import { randomUUID } from 'node:crypto';

const reasons = new Set(['objectionable', 'harassment', 'copyright', 'spam', 'other']);
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const cleanText = (value, max) => {
  if (typeof value !== 'string' || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)) throw fail(400, 'invalid_moderation_text');
  return value.trim();
};

export function createModeration(db, admins, contact) {
  let info;
  if (contact) {
    const url = new URL(contact);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.href.length > 2048 ||
        ![...admins].some(id => /^[a-f0-9]{64}$/.test(id))) throw new Error('Moderation requires an HTTPS contact and a valid administrator subject');
    info = { schemaVersion: 1, contactURL: url.href };
  }

  db.exec(`CREATE TABLE IF NOT EXISTS moderation_reports (
    id TEXT PRIMARY KEY, target TEXT NOT NULL, subject TEXT NOT NULL, context TEXT NOT NULL,
    reason TEXT NOT NULL, details TEXT NOT NULL, created_at TEXT NOT NULL,
    resolved_at TEXT, resolved_by TEXT, resolution TEXT
  );
  CREATE UNIQUE INDEX IF NOT EXISTS moderation_open_report ON moderation_reports(target,subject) WHERE resolved_at IS NULL;
  CREATE INDEX IF NOT EXISTS moderation_reports_queue ON moderation_reports(resolved_at,created_at,id);
  CREATE INDEX IF NOT EXISTS moderation_reports_rate ON moderation_reports(subject,created_at);
  CREATE TABLE IF NOT EXISTS moderation_decisions (
    target TEXT PRIMARY KEY, status TEXT NOT NULL, subject TEXT NOT NULL,
    details TEXT NOT NULL, decided_at TEXT NOT NULL
  );`);

  function transaction(operation) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      db.exec('COMMIT');
      return result;
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  }

  function requireOperator(subject) {
    if (!admins.has(subject)) throw fail(403, 'administrator_required');
  }

  function requireAvailable() {
    if (!info) throw fail(503, 'moderation_unavailable');
  }

  function report(target, subject, value, context) {
    requireAvailable();
    if (!reasons.has(value.reason)) throw fail(400, 'invalid_report_reason');
    const details = cleanText(value.details ?? '', 2000);
    return transaction(() => {
      const prior = db.prepare('SELECT id FROM moderation_reports WHERE target=? AND subject=? AND resolved_at IS NULL').get(target, subject);
      if (prior) return { id: prior.id };
      const now = Date.now();
      const recent = new Date(now - 3600_000).toISOString();
      db.prepare('DELETE FROM moderation_reports WHERE resolved_at<?').run(new Date(now - 90 * 86400_000).toISOString());
      if (db.prepare('SELECT COUNT(*) AS n FROM moderation_reports WHERE subject=? AND created_at>?').get(subject, recent).n >= 10 ||
          db.prepare('SELECT COUNT(*) AS n FROM moderation_reports').get().n >= 100_000) throw fail(429, 'report_capacity');
      const id = randomUUID();
      db.prepare('INSERT INTO moderation_reports(id,target,subject,context,reason,details,created_at) VALUES(?,?,?,?,?,?,?)')
        .run(id, target, subject, JSON.stringify(context), value.reason, details, new Date(now).toISOString());
      return { id };
    });
  }

  function reports(offset) {
    return db.prepare('SELECT * FROM moderation_reports WHERE resolved_at IS NULL ORDER BY created_at,id LIMIT 100 OFFSET ?').all(offset)
      .map(row => ({ id: row.id, target: JSON.parse(row.context), reason: row.reason, details: row.details, createdAt: row.created_at }));
  }

  function resolve(id, operator, value) {
    const resolution = cleanText(value.details, 2000);
    if (!resolution) throw fail(400, 'moderation_resolution_required');
    const row = db.prepare('SELECT resolved_at FROM moderation_reports WHERE id=?').get(id);
    if (!row) throw fail(404, 'report_not_found');
    if (!row.resolved_at) db.prepare('UPDATE moderation_reports SET resolved_at=?,resolved_by=?,resolution=? WHERE id=? AND resolved_at IS NULL')
      .run(new Date().toISOString(), operator, resolution, id);
    return { resolved: true };
  }

  function decide(target, previous, subject, value, apply) {
    const status = value.status;
    const details = cleanText(value.details, 2000);
    if (!details || !['approved', 'rejected', 'removed'].includes(status)) throw fail(400, 'invalid_moderation_decision');
    if (status === 'approved') {
      requireAvailable();
      if (value.inspectedContent !== true) throw fail(400, 'content_inspection_required');
    }
    if (status === previous) return { moderationStatus: status };
    if (!(previous === 'pending' && ['approved', 'rejected'].includes(status)) && !(previous === 'approved' && status === 'removed')) {
      throw fail(409, 'invalid_moderation_transition');
    }
    return transaction(() => {
      apply(status);
      db.prepare(`INSERT INTO moderation_decisions(target,status,subject,details,decided_at) VALUES(?,?,?,?,?)
        ON CONFLICT(target) DO UPDATE SET status=excluded.status, subject=excluded.subject, details=excluded.details, decided_at=excluded.decided_at`)
        .run(target, status, subject, details, new Date().toISOString());
      return { moderationStatus: status };
    });
  }

  function offset(url) {
    const value = Number(url.searchParams.get('offset') ?? 0);
    if (!Number.isSafeInteger(value) || value < 0 || value > 100_000) throw fail(400, 'invalid_moderation_offset');
    return value;
  }

  return { info, requireOperator, requireAvailable, report, reports, resolve, decide, offset };
}
