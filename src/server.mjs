import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createPublicKey, createPrivateKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, rm, stat, statfs, open, chmod, readdir } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const integer = (name, fallback, max = Number.MAX_SAFE_INTEGER) => {
  const n = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(n) || n <= 0 || n > max) throw new Error(`Invalid ${name}`);
  return n;
};
const port = integer('NODE_PORT', 8787, 65535);
const dataDir = path.resolve(process.env.NODE_DATA_DIR ?? './data');
const partSize = 8 * 1024 * 1024;
const maxFile = integer('NODE_MAX_FILE_BYTES', 1073741824, 128 * 1024 ** 3);
const ownerQuota = integer('NODE_OWNER_QUOTA_BYTES', 10 * 1024 ** 3);
const totalQuota = integer('NODE_TOTAL_QUOTA_BYTES', 100 * 1024 ** 3);
const maxEntries = integer('NODE_MAX_ENTRIES', 50000, 1000000);
const maxOwnerEntries = integer('NODE_MAX_OWNER_ENTRIES', 1000, 100000);
const uploadTTL = integer('NODE_UPLOAD_TTL_HOURS', 168, 8760) * 3600;
const publicURL = new URL(process.env.NODE_PUBLIC_URL ?? `http://127.0.0.1:${port}`);
if (publicURL.username || publicURL.password || publicURL.search || publicURL.hash || publicURL.pathname !== '/' ||
    (publicURL.protocol !== 'https:' && !(publicURL.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(publicURL.hostname)))) {
  throw new Error('NODE_PUBLIC_URL must be an HTTPS origin (HTTP loopback is development only)');
}
const adminIDs = new Set((process.env.NODE_ADMIN_PUBLIC_KEYS ?? '').split(',').filter(Boolean));
const providerAddress = process.env.NODE_PROVIDER_ADDRESS ?? null;
if (providerAddress && !/^0x[0-9a-fA-F]{40}$/.test(providerAddress)) throw new Error('Invalid NODE_PROVIDER_ADDRESS');
const sha = value => createHash('sha256').update(value).digest('hex');
const now = () => Math.floor(Date.now() / 1000);
const iso = value => new Date(value * 1000).toISOString();
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digestPattern = /^[0-9a-f]{64}$/;
const busy = new Set();
let bufferedRequests = 0;
let activePartRequests = 0;
const requestRates = new Map();
await mkdir(dataDir, { recursive: true, mode: 0o700 });
for (const dir of ['uploads', 'objects']) await mkdir(path.join(dataDir, dir), { recursive: true, mode: 0o700 });
const identityPath = path.join(dataDir, 'provider-key.der');
let providerKey;
try { providerKey = createPrivateKey({ key: await readFile(identityPath), format: 'der', type: 'pkcs8' }); }
catch (error) {
  if (error.code !== 'ENOENT') throw error;
  providerKey = generateKeyPairSync('ed25519').privateKey;
  await writeFile(identityPath, providerKey.export({ format: 'der', type: 'pkcs8' }), { flag: 'wx', mode: 0o600 });
}
await chmod(identityPath, 0o600);
const providerPublicKey = createPublicKey(providerKey).export({ format: 'der', type: 'spki' }).subarray(-32);
const providerID = sha(providerPublicKey);
const db = new DatabaseSync(path.join(dataDir, 'node.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS uploads(id TEXT PRIMARY KEY, owner TEXT NOT NULL, metadata TEXT NOT NULL, bytes INTEGER NOT NULL, sha TEXT NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL DEFAULT 'pending');
CREATE TABLE IF NOT EXISTS parts(upload TEXT NOT NULL REFERENCES uploads(id) ON DELETE CASCADE, idx INTEGER NOT NULL, sha TEXT NOT NULL, bytes INTEGER NOT NULL, PRIMARY KEY(upload,idx));
CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY REFERENCES uploads(id), owner TEXT NOT NULL, metadata TEXT NOT NULL, bytes INTEGER NOT NULL, sha TEXT NOT NULL, created INTEGER NOT NULL, visibility TEXT NOT NULL, downloads INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS public_resources ON resources(visibility,created);
CREATE TABLE IF NOT EXISTS nonces(owner TEXT NOT NULL, nonce TEXT NOT NULL, expires INTEGER NOT NULL, PRIMARY KEY(owner,nonce));
CREATE TABLE IF NOT EXISTS tickets(id TEXT PRIMARY KEY, resource TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE, owner TEXT NOT NULL, created INTEGER NOT NULL, completed INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS served(ticket TEXT NOT NULL REFERENCES tickets(id) ON DELETE CASCADE, start INTEGER NOT NULL, end INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS download_events(resource TEXT NOT NULL REFERENCES resources(id) ON DELETE CASCADE, owner TEXT NOT NULL, day INTEGER NOT NULL, created INTEGER NOT NULL, PRIMARY KEY(resource,owner,day));
CREATE INDEX IF NOT EXISTS download_time ON download_events(created);
CREATE TABLE IF NOT EXISTS attestations(hash TEXT PRIMARY KEY, resource TEXT NOT NULL, payload TEXT NOT NULL, created INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS attestation_resource_time ON attestations(resource,created);
`);
await chmod(path.join(dataDir, 'node.sqlite'), 0o600);
// A crash during completion leaves the original durable parts available for retry.
db.prepare("UPDATE uploads SET status='pending' WHERE status='completing'").run();
const fail = (status, code) => Object.assign(new Error(code), { status, code });
const json = (res, status, value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(bytes);
};
const body = async (req, maximum) => {
  const length = req.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximum)) throw fail(413, 'body_too_large');
  if (maximum > 16384 && bufferedRequests >= 4) throw fail(429, 'upload_concurrency_limit');
  if (maximum > 16384) bufferedRequests++;
  try {
    const buffers = []; let size = 0;
    for await (const chunk of req) {
      size += chunk.length;
      if (size > maximum) throw fail(413, 'body_too_large');
      buffers.push(chunk);
    }
    return Buffer.concat(buffers, size);
  } finally { if (maximum > 16384) bufferedRequests--; }
};
const parse = bytes => {
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch { throw fail(400, 'invalid_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw fail(400, 'invalid_json');
  return value;
};
const authenticate = (req, url, bytes) => {
  const audience = req.headers['x-ats-audience'];
  const keyText = req.headers['x-ats-public-key'];
  const timestamp = req.headers['x-ats-timestamp'];
  const nonce = req.headers['x-ats-nonce'];
  const signatureText = req.headers['x-ats-signature'];
  if (audience !== publicURL.origin || typeof keyText !== 'string' || typeof signatureText !== 'string' || typeof timestamp !== 'string' ||
      !/^\d{1,12}$/.test(timestamp) || typeof nonce !== 'string' || !uuidPattern.test(nonce) ||
      Math.abs(now() - Number(timestamp)) > 300) throw fail(401, 'authentication_required');
  const key = Buffer.from(keyText, 'base64'), signature = Buffer.from(signatureText, 'base64');
  if (key.length !== 32 || signature.length !== 64 || key.toString('base64') !== keyText || signature.toString('base64') !== signatureText) throw fail(401, 'invalid_signature');
  const message = `ATS-NODE-V1\n${audience}\n${req.method}\n${url.pathname}${url.search}\n${timestamp}\n${nonce}\n${sha(bytes)}`;
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key]), format: 'der', type: 'spki' });
  if (!verify(null, Buffer.from(message), publicKey, signature)) throw fail(401, 'invalid_signature');
  const owner = sha(key);
  if (db.prepare('SELECT COUNT(*) AS count FROM nonces').get().count >= 100000) throw fail(429, 'authentication_capacity_limit');
  try { db.prepare('INSERT INTO nonces(owner,nonce,expires) VALUES(?,?,?)').run(owner, nonce.toLowerCase(), now() + 601); }
  catch { throw fail(409, 'replayed_request'); }
  return owner;
};
const ownedUpload = (id, owner) => {
  const value = db.prepare('SELECT * FROM uploads WHERE id=?').get(id);
  if (!value || value.owner !== owner) throw fail(404, 'upload_not_found');
  if (value.status === 'pending' && value.expires < now()) throw fail(410, 'upload_expired');
  return value;
};
const uploadResponse = upload => ({ id: upload.id, partSize, byteCount: upload.bytes, sha256: upload.sha, expiresAt: iso(upload.expires),
  parts: db.prepare('SELECT idx AS `index`,sha AS sha256,bytes AS byteCount FROM parts WHERE upload=? ORDER BY idx').all(upload.id) });
const resourceResponse = r => {
  const metadata = JSON.parse(r.metadata);
  return { id: r.id, title: metadata.title, summary: metadata.summary, language: metadata.language, tags: metadata.tags,
    sha256: r.sha, byteCount: r.bytes, sources: [`${publicURL.origin}/v1/resources/${r.id}/download`], encrypted: metadata.encrypted,
    publisherID: r.owner, createdAt: iso(r.created), downloads: r.downloads, visibility: r.visibility };
};
const metadata = value => {
  const string = (v, max, required = false) => {
    if ((v === undefined || v === null) && !required) return '';
    if (typeof v !== 'string' || v.length > max || (required && !v.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) throw fail(400, 'invalid_metadata');
    return v.trim();
  };
  if (typeof value.sha256 !== 'string' || !digestPattern.test(value.sha256) || !Number.isSafeInteger(value.byteCount) || value.byteCount < 8 || value.byteCount > maxFile) throw fail(400, 'invalid_content_size_or_hash');
  if (!['public', 'unlisted', 'private'].includes(value.visibility) || typeof value.encrypted !== 'boolean') throw fail(400, 'invalid_visibility_or_encryption');
  if (!Array.isArray(value.tags) || value.tags.length > 16) throw fail(400, 'invalid_tags');
  return { title: string(value.title, 300, true), summary: string(value.summary, 4000), language: string(value.language, 64) || null,
    tags: [...new Set(value.tags.map(v => string(v, 64, true)))], encrypted: value.encrypted, visibility: value.visibility };
};
const getResource = (req, url, id) => {
  const r = db.prepare('SELECT * FROM resources WHERE id=?').get(id);
  if (!r) throw fail(404, 'resource_not_found');
  if (r.visibility === 'private') {
    // A signed owner creates a short-lived, resource-scoped download capability.
    // It never grants access to metadata, evidence, list, or other resources.
    const ticket = url.pathname === `/v1/resources/${id}/download` && url.searchParams.get('ticket');
    const grant = ticket && uuidPattern.test(ticket) && db.prepare('SELECT 1 FROM tickets WHERE id=? AND resource=? AND owner=? AND created>?').get(ticket, id, r.owner, now() - 86400);
    if (grant) return r;
    const owner = authenticate(req, url, Buffer.alloc(0));
    if (owner !== r.owner && !adminIDs.has(owner)) throw fail(404, 'resource_not_found');
  }
  return r;
};
const filePath = (folder, id, part) => path.join(dataDir, folder, id, ...(part === undefined ? [] : [String(part)]));
const objectPath = id => path.join(dataDir, 'objects', id);
const complete = async upload => {
  if (busy.has(upload.id)) throw fail(409, 'upload_busy');
  const existing = db.prepare('SELECT * FROM resources WHERE id=?').get(upload.id);
  if (existing) return existing;
  busy.add(upload.id);
  const staging = `${objectPath(upload.id)}.partial`;
  try {
    const parts = db.prepare('SELECT idx,sha,bytes FROM parts WHERE upload=? ORDER BY idx').all(upload.id);
    if (parts.length !== Math.ceil(upload.bytes / partSize)) throw fail(409, 'incomplete_upload');
    const disk = await statfs(dataDir);
    if (disk.bavail * disk.bsize < upload.bytes + 16 * 1024 ** 2) throw fail(507, 'insufficient_storage');
    db.prepare("UPDATE uploads SET status='completing' WHERE id=?").run(upload.id);
    const output = await open(staging, 'w', 0o600);
    const hash = createHash('sha256'); let size = 0; let prefix = Buffer.alloc(0);
    try {
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        if (p.idx !== i || p.bytes !== Math.min(partSize, upload.bytes - i * partSize)) throw fail(409, 'incomplete_upload');
        const partHash = createHash('sha256'); let partBytes = 0;
        for await (const chunk of createReadStream(filePath('uploads', upload.id, i))) {
          if (size + chunk.length > upload.bytes || partBytes + chunk.length > p.bytes) throw fail(422, 'content_integrity_failure');
          if (prefix.length < 8) prefix = Buffer.concat([prefix, chunk.subarray(0, 8 - prefix.length)]);
          hash.update(chunk); partHash.update(chunk); size += chunk.length; partBytes += chunk.length;
          let written = 0;
          while (written < chunk.length) written += (await output.write(chunk, written, chunk.length - written)).bytesWritten;
        }
        if (partBytes !== p.bytes || partHash.digest('hex') !== p.sha) throw fail(422, 'content_integrity_failure');
      }
      if (size !== upload.bytes || hash.digest('hex') !== upload.sha || prefix.toString('ascii') !== 'ATSBOOK1') throw fail(422, 'content_integrity_failure');
      await output.sync();
    } finally { await output.close(); }
    await rename(staging, objectPath(upload.id));
    const m = JSON.parse(upload.metadata);
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO resources(id,owner,metadata,bytes,sha,created,visibility) VALUES(?,?,?,?,?,?,?)').run(upload.id, upload.owner, upload.metadata, upload.bytes, upload.sha, now(), m.visibility);
      db.prepare("UPDATE uploads SET status='complete' WHERE id=?").run(upload.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    await rm(filePath('uploads', upload.id), { recursive: true, force: true });
    return db.prepare('SELECT * FROM resources WHERE id=?').get(upload.id);
  } finally {
    await rm(staging, { force: true });
    db.prepare("UPDATE uploads SET status='pending' WHERE id=? AND status='completing'").run(upload.id);
    busy.delete(upload.id);
  }
};

async function route(req, res) {
  const url = new URL(req.url, 'http://node.invalid');
  if (req.url.length > 4096 || url.pathname.includes('%') || url.pathname.includes('..')) throw fail(400, 'invalid_path');
  const segments = url.pathname.split('/').filter(Boolean);
  if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { status: 'ok', schemaVersion: 1 });
  if (req.method === 'GET' && url.pathname === '/v1/node') {
    const disk = await statfs(dataDir);
    return json(res, 200, {
    schemaVersion: 1, providerID, publicKey: providerPublicKey.toString('base64'), providerAddress, publicURL: publicURL.origin,
    partSize, maximumFileBytes: maxFile, capabilities: ['resumable-upload', 'public-search', 'range-download', 'signed-evidence'],
    rewards: { mode: 'external-attested-escrow', automaticMinting: false }
    ,storage: { configuredQuotaBytes: totalQuota, availableDiskBytes: disk.bavail * disk.bsize }
    });
  }
  if (req.method === 'POST' && url.pathname === '/v1/uploads') {
    const bytes = await body(req, 16384), owner = authenticate(req, url, bytes), value = parse(bytes), m = metadata(value);
    const ownerBytes = db.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes FROM uploads WHERE owner=? AND (status='complete' OR expires>=?)").get(owner, now()).bytes;
    const totalBytes = db.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes FROM uploads WHERE status='complete' OR expires>=?").get(now()).bytes;
    const pending = db.prepare("SELECT COUNT(*) AS count FROM uploads WHERE owner=? AND status='pending'").get(owner).count;
    const entries = db.prepare('SELECT COUNT(*) AS count FROM uploads').get().count;
    const ownerEntries = db.prepare('SELECT COUNT(*) AS count FROM uploads WHERE owner=?').get(owner).count;
    if (pending >= 32 || entries >= maxEntries || ownerEntries >= maxOwnerEntries || ownerBytes + value.byteCount > ownerQuota || totalBytes + value.byteCount > totalQuota) throw fail(429, 'storage_quota_exceeded');
    const id = randomUUID();
    db.prepare('INSERT INTO uploads(id,owner,metadata,bytes,sha,created,expires) VALUES(?,?,?,?,?,?,?)').run(id, owner, JSON.stringify(m), value.byteCount, value.sha256, now(), now() + uploadTTL);
    try {
      const disk = await statfs(dataDir);
      const reserved = db.prepare("SELECT COALESCE(SUM(bytes),0) AS bytes FROM uploads WHERE status IN ('pending','completing') AND expires>=?").get(now()).bytes;
      const storedParts = db.prepare("SELECT COALESCE(SUM(p.bytes),0) AS bytes FROM parts p JOIN uploads u ON p.upload=u.id WHERE u.status IN ('pending','completing') AND u.expires>=?").get(now()).bytes;
      if (disk.bavail * disk.bsize < reserved * 2 - storedParts + 16 * 1024 ** 2) throw fail(507, 'insufficient_storage');
      await mkdir(filePath('uploads', id), { mode: 0o700 });
    }
    catch (error) { db.prepare('DELETE FROM uploads WHERE id=?').run(id); throw error; }
    return json(res, 201, uploadResponse(ownedUpload(id, owner)));
  }
  if (segments[0] === 'v1' && segments[1] === 'uploads' && uuidPattern.test(segments[2] ?? '')) {
    const id = segments[2];
    const bytes = await body(req, req.method === 'PUT' ? partSize : 16384);
    const owner = authenticate(req, url, bytes), upload = ownedUpload(id, owner);
    if (segments.length === 3 && req.method === 'GET') return json(res, 200, uploadResponse(upload));
    if (segments.length === 3 && req.method === 'DELETE') {
      if (upload.status !== 'pending' || busy.has(id)) throw fail(409, 'upload_busy_or_complete');
      busy.add(id);
      db.prepare('DELETE FROM uploads WHERE id=?').run(id);
      try { await rm(filePath('uploads', id), { recursive: true, force: true }); }
      finally { busy.delete(id); }
      return json(res, 200, { cancelled: true });
    }
    if (segments.length === 5 && segments[3] === 'parts' && req.method === 'PUT' && /^(0|[1-9]\d{0,6})$/.test(segments[4])) {
      const index = Number(segments[4]);
      if (upload.status !== 'pending' || busy.has(id)) throw fail(409, 'upload_busy_or_complete');
      const expected = Math.min(partSize, upload.bytes - index * partSize);
      if (expected <= 0 || bytes.length !== expected) throw fail(400, 'invalid_part_size');
      const digest = sha(bytes), current = db.prepare('SELECT sha FROM parts WHERE upload=? AND idx=?').get(id, index);
      if (current && current.sha !== digest) throw fail(409, 'part_conflict');
      // Idempotent rewrites also repair a part lost after an interrupted write.
      {
        busy.add(id);
        const temp = filePath('uploads', id, `${index}.${randomUUID()}.partial`);
        try {
          const part = await open(temp, 'wx', 0o600);
          try { await part.writeFile(bytes); await part.sync(); } finally { await part.close(); }
          await rename(temp, filePath('uploads', id, index));
          db.prepare('INSERT OR REPLACE INTO parts(upload,idx,sha,bytes) VALUES(?,?,?,?)').run(id, index, digest, bytes.length);
        } finally { await rm(temp, { force: true }); busy.delete(id); }
      }
      return json(res, 200, { index, sha256: digest, byteCount: bytes.length });
    }
    if (segments.length === 4 && segments[3] === 'complete' && req.method === 'POST') return json(res, 200, resourceResponse(await complete(upload)));
  }
  if (req.method === 'GET' && url.pathname === '/v1/resources') {
    const query = url.searchParams.get('q') ?? '', sort = url.searchParams.get('sort') ?? 'recent';
    const limit = Number(url.searchParams.get('limit') ?? 30), cursor = Number(url.searchParams.get('cursor') ?? 0);
    if (query.length > 200 || !['recent', 'downloads', 'trending'].includes(sort) || !Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(cursor) || cursor < 0 || cursor > 1000000) throw fail(400, 'invalid_search');
    // JSON fields searched separately; metadata never interpolated into SQL.
    const term = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
    const order = sort === 'downloads' ? 'r.downloads DESC,r.created DESC,r.id' : sort === 'trending' ? 'score DESC,r.created DESC,r.id' : 'r.created DESC,r.id';
    const rows = db.prepare(`SELECT r.*,COALESCE((SELECT SUM(1.0 / (1.0 + (? - e.created) / 172800.0)) FROM download_events e WHERE e.resource=r.id AND e.created>=?),0) AS score
      FROM resources r WHERE r.visibility='public' AND (?='' OR json_extract(r.metadata,'$.title') LIKE ? ESCAPE '\\' OR json_extract(r.metadata,'$.summary') LIKE ? ESCAPE '\\' OR json_extract(r.metadata,'$.language') LIKE ? ESCAPE '\\' OR json_extract(r.metadata,'$.tags') LIKE ? ESCAPE '\\')
      ORDER BY ${order} LIMIT ? OFFSET ?`).all(now(), now() - 30 * 86400, query, term, term, term, term, limit + 1, cursor);
    return json(res, 200, { items: rows.slice(0, limit).map(resourceResponse), nextCursor: rows.length > limit ? String(cursor + limit) : null });
  }
  if (segments[0] === 'v1' && segments[1] === 'resources' && uuidPattern.test(segments[2] ?? '')) {
    const id = segments[2];
    if (req.method === 'DELETE' && segments.length === 3) {
      const bytes = await body(req, 1024), owner = authenticate(req, url, bytes);
      const r = db.prepare('SELECT * FROM resources WHERE id=?').get(id);
      if (!r || (r.owner !== owner && !adminIDs.has(owner))) throw fail(404, 'resource_not_found');
      db.prepare('DELETE FROM resources WHERE id=?').run(id);
      db.prepare('DELETE FROM uploads WHERE id=?').run(id);
      await rm(objectPath(id), { force: true });
      return json(res, 200, { deleted: true });
    }
    if (req.method === 'POST' && segments[3] === 'downloads' && segments.length === 4) {
      const bytes = await body(req, 1024), owner = authenticate(req, url, bytes);
      const r = db.prepare('SELECT * FROM resources WHERE id=?').get(id);
      if (!r || (r.visibility === 'private' && r.owner !== owner)) throw fail(404, 'resource_not_found');
      const recent = db.prepare('SELECT COUNT(*) AS n FROM tickets WHERE owner=? AND created>?').get(owner, now() - 3600).n;
      if (recent >= 120 || db.prepare('SELECT COUNT(*) AS n FROM tickets').get().n >= maxEntries * 10) throw fail(429, 'download_ticket_limit');
      const ticket = randomUUID();
      db.prepare('INSERT INTO tickets(id,resource,owner,created) VALUES(?,?,?,?)').run(ticket, id, owner, now());
      return json(res, 201, { id: ticket, downloadURL: `${publicURL.origin}/v1/resources/${id}/download?ticket=${ticket}` });
    }
    if (req.method === 'GET') {
      const r = getResource(req, url, id);
      if (segments.length === 3) return json(res, 200, resourceResponse(r));
      if (segments.length === 4 && segments[3] === 'evidence') {
        const size = (await stat(objectPath(id))).size;
        if (size !== r.bytes) throw fail(503, 'stored_object_unavailable');
        const recent = db.prepare('SELECT payload FROM attestations WHERE resource=? AND created>? ORDER BY created DESC LIMIT 1').get(r.id, now() - 60);
        const evidence = recent ? JSON.parse(recent.payload) : { schemaVersion: 1, resourceId: r.sha, publicationID: r.id, providerID, providerAddress, observedAt: iso(now()), byteCount: r.bytes, sha256: r.sha, status: 'self-reported-stored' };
        const encoded = Buffer.from(JSON.stringify(evidence));
        if (!recent) {
          db.prepare('INSERT OR IGNORE INTO attestations(hash,resource,payload,created) VALUES(?,?,?,?)').run(sha(encoded), r.id, encoded.toString('utf8'), now());
          if (db.prepare('SELECT COUNT(*) AS n FROM attestations').get().n > maxEntries * 10) db.prepare('DELETE FROM attestations WHERE hash IN (SELECT hash FROM attestations ORDER BY created LIMIT 1000)').run();
        }
        return json(res, 200, { evidence, publicKey: providerPublicKey.toString('base64'), signature: sign(null, encoded, providerKey).toString('base64'), evidenceHash: sha(encoded), evidenceBytes: encoded.toString('base64') });
      }
      if (segments.length === 4 && segments[3] === 'download') {
        const ticketID = url.searchParams.get('ticket');
        const ticket = ticketID && uuidPattern.test(ticketID) ? db.prepare('SELECT * FROM tickets WHERE id=? AND resource=? AND created>?').get(ticketID, id, now() - 86400) : null;
        if (ticketID && !ticket) throw fail(404, 'download_ticket_not_found');
        let start = 0, end = r.bytes - 1, status = 200;
        if (req.headers.range) {
          const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
          if (!match || (!match[1] && !match[2])) throw fail(416, 'invalid_range');
          if (!match[1]) { const suffix = Number(match[2]); start = Math.max(0, r.bytes - suffix); if (!suffix) throw fail(416, 'invalid_range'); }
          else { start = Number(match[1]); end = match[2] ? Math.min(Number(match[2]), end) : end; }
          if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= r.bytes) throw fail(416, 'invalid_range');
          status = 206;
        }
        const file = await open(objectPath(id), 'r');
        if ((await file.stat()).size !== r.bytes) { await file.close(); throw fail(503, 'stored_object_unavailable'); }
        res.writeHead(status, { 'Content-Type': 'application/vnd.anyaudiobooks.book', 'Content-Length': end - start + 1,
          'Accept-Ranges': 'bytes', ETag: `"${r.sha}"`, 'Content-Disposition': `attachment; filename="${id}.atsbook"`,
          'Cache-Control': r.visibility === 'private' || ticket ? 'private, no-store' : 'public, max-age=3600', 'X-Content-Type-Options': 'nosniff',
          ...(status === 206 ? { 'Content-Range': `bytes ${start}-${end}/${r.bytes}` } : {}) });
        await pipeline(file.createReadStream({ start, end, autoClose: true }), res);
        if (ticket && !ticket.completed && db.prepare('SELECT 1 FROM tickets WHERE id=?').get(ticket.id)) {
          // Store a bounded union, not one row per repeated byte-range request.
          const ranges = [...db.prepare('SELECT start,end FROM served WHERE ticket=?').all(ticket.id), { start, end }]
            .sort((a, b) => a.start - b.start || a.end - b.end);
          const merged = [];
          for (const range of ranges) {
            const previous = merged.at(-1);
            if (previous && range.start <= previous.end + 1) previous.end = Math.max(previous.end, range.end);
            else merged.push({ start: range.start, end: range.end });
          }
          if (merged.length <= 1024) {
            db.exec('BEGIN IMMEDIATE');
            try {
              db.prepare('DELETE FROM served WHERE ticket=?').run(ticket.id);
              const insert = db.prepare('INSERT INTO served(ticket,start,end) VALUES(?,?,?)');
              for (const range of merged) insert.run(ticket.id, range.start, range.end);
              db.exec('COMMIT');
            } catch (error) { db.exec('ROLLBACK'); throw error; }
          }
        }
        return;
      }
    }
  }
  if (req.method === 'POST' && segments.length === 4 && segments[0] === 'v1' && segments[1] === 'downloads' && uuidPattern.test(segments[2] ?? '') && segments[3] === 'complete') {
    const bytes = await body(req, 1024), owner = authenticate(req, url, bytes), value = parse(bytes);
    const ticket = db.prepare('SELECT * FROM tickets WHERE id=? AND owner=? AND created>?').get(segments[2], owner, now() - 86400);
    if (!ticket) throw fail(404, 'download_ticket_not_found');
    const r = db.prepare('SELECT * FROM resources WHERE id=?').get(ticket.resource);
    if (value.sha256 !== r.sha) throw fail(422, 'content_integrity_failure');
    if (ticket.completed) return json(res, 200, { counted: false, downloads: r.downloads });
    let covered = 0;
    for (const range of db.prepare('SELECT start,end FROM served WHERE ticket=? ORDER BY start,end').all(ticket.id)) {
      if (range.start > covered) break;
      covered = Math.max(covered, range.end + 1);
    }
    if (covered < r.bytes) throw fail(409, 'download_incomplete');
    db.exec('BEGIN IMMEDIATE'); let counted = false;
    try {
      counted = db.prepare('INSERT OR IGNORE INTO download_events(resource,owner,day,created) VALUES(?,?,?,?)').run(r.id, owner, Math.floor(now() / 86400), now()).changes > 0;
      if (counted) db.prepare('UPDATE resources SET downloads=downloads+1 WHERE id=?').run(r.id);
      db.prepare('UPDATE tickets SET completed=1 WHERE id=?').run(ticket.id);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
    return json(res, 200, { counted, downloads: db.prepare('SELECT downloads FROM resources WHERE id=?').get(r.id).downloads });
  }
  throw fail(404, 'not_found');
}

const server = http.createServer({ maxHeaderSize: 16384, requestTimeout: 120000, headersTimeout: 15000 }, async (req, res) => {
  const remote = req.socket.remoteAddress ?? 'unknown';
  const minute = Math.floor(now() / 60), rate = requestRates.get(remote);
  if (rate?.minute === minute && rate.count >= 1200) { res.setHeader('Connection', 'close'); json(res, 429, { error: 'request_rate_limit' }); req.resume(); return; }
  if (rate?.minute === minute) rate.count++;
  else {
    if (requestRates.size >= 10000) requestRates.clear();
    requestRates.set(remote, { minute, count: 1 });
  }
  const isPart = req.method === 'PUT';
  if (isPart && activePartRequests >= 4) { res.setHeader('Connection', 'close'); json(res, 429, { error: 'upload_concurrency_limit' }); req.resume(); return; }
  if (isPart) activePartRequests++;
  try { await route(req, res); }
  catch (error) {
    if (res.headersSent || res.destroyed) { res.destroy(); return; }
    if (!error.status) console.error(JSON.stringify({ level: 'error', event: 'request_failed', code: error.code ?? 'internal_error' }));
    json(res, error.status ?? 500, { error: error.code && error.status ? error.code : 'internal_error' });
  } finally { if (isPart) activePartRequests--; }
});
server.maxConnections = 128;
server.keepAliveTimeout = 5000;
const cleanup = async () => {
  db.prepare('DELETE FROM nonces WHERE expires<?').run(now());
  db.prepare('DELETE FROM tickets WHERE created<?').run(now() - 86400);
  db.prepare('DELETE FROM download_events WHERE created<?').run(now() - 90 * 86400);
  db.prepare('DELETE FROM attestations WHERE created<?').run(now() - 90 * 86400);
  // A killed process may leave uncommitted temporary files; they are never resumed.
  for (const upload of db.prepare("SELECT id FROM uploads WHERE status='pending'").all()) {
    if (busy.has(upload.id)) continue;
    busy.add(upload.id);
    const folder = filePath('uploads', upload.id);
    try {
      for (const entry of await readdir(folder).catch(() => [])) {
        if (entry.endsWith('.partial')) await rm(path.join(folder, entry), { force: true });
      }
    } finally { busy.delete(upload.id); }
  }
  for (const upload of db.prepare("SELECT id FROM uploads WHERE status='pending' AND expires<?").all(now())) {
    if (busy.has(upload.id)) continue;
    db.prepare('DELETE FROM uploads WHERE id=?').run(upload.id);
    await rm(filePath('uploads', upload.id), { recursive: true, force: true });
    await rm(objectPath(upload.id), { force: true });
    await rm(`${objectPath(upload.id)}.partial`, { force: true });
  }
};
await cleanup();
const timer = setInterval(() => cleanup().catch(() => console.error('{"event":"cleanup_failed"}')), 60000);
timer.unref();
server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ event: 'listening', port, providerID })));
for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
  clearInterval(timer);
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(1), 15000).unref();
});
