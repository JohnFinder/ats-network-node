// Independent music endpoint. The upstream worker is operator-configured, never client-selected.
import http from 'node:http';
import https from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdir, readFile, writeFile, rm, chmod } from 'node:fs/promises';
import path from 'node:path';
import { STABLE_AUDIO, MM3, MAX_AUDIO_BYTES, modelRegistry, validateMM3, validateWAV } from './models.mjs';

const integer = (name, fallback, max) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) throw new Error(`Invalid ${name}`);
  return value;
};
const port = integer('NODE_MUSIC_PORT', 8791, 65535);
const directory = path.resolve(process.env.NODE_MUSIC_DATA_DIR ?? './data/music');
const models = modelRegistry();
const maxJobs = integer('NODE_MUSIC_MAX_JOBS', 200, 10000);
const maxAudio = MAX_AUDIO_BYTES;
const keys = (process.env.NODE_MUSIC_API_KEYS ?? '').split(',').filter(Boolean);
if (!keys.length || keys.some(key => key.length < 24 || key.length > 4096 || /\s/.test(key))) throw new Error('Set NODE_MUSIC_API_KEYS to strong separate client credentials');
for (const config of models.values()) {
  if (config.key && keys.includes(config.key)) throw new Error('Worker credentials must differ from client credentials');
  if (config.mm3 && (!config.key || config.key.length < 24 || config.key.length > 4096 || /\s/.test(config.key))) throw new Error('Set a separate MiniMax-Music3 worker credential');
}
await mkdir(directory, { recursive: true, mode: 0o700 });
const databaseFile = path.join(directory, 'music.sqlite');
const db = new DatabaseSync(databaseFile);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
 CREATE TABLE IF NOT EXISTS music_jobs (id TEXT PRIMARY KEY, owner TEXT NOT NULL, idem TEXT NOT NULL, fingerprint TEXT NOT NULL,
 prompt TEXT NOT NULL, seconds INTEGER NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL, UNIQUE(owner,idem));`);
await chmod(databaseFile, 0o600);
// Old records predate model/seed/caption persistence. Never reinterpret a
// queued Stable Audio request as MM3 when the operator changes NODE_MUSIC_MODEL.
db.exec('BEGIN IMMEDIATE');
try {
  const columns = new Set(db.prepare('PRAGMA table_info(music_jobs)').all().map(column => column.name));
  for (const [name, type] of [['model', 'TEXT'], ['instructions', 'TEXT'], ['seed', 'INTEGER'], ['instrumental', 'INTEGER'],
    ['started_at', 'INTEGER'], ['finished_at', 'INTEGER'], ['error_code', 'TEXT']]) {
    if (!columns.has(name)) db.exec(`ALTER TABLE music_jobs ADD COLUMN ${name} ${type}`);
  }
  db.prepare('UPDATE music_jobs SET model=?, instrumental=1 WHERE model IS NULL').run(process.env.NODE_MUSIC_LEGACY_MODEL ?? STABLE_AUDIO);
  db.exec('COMMIT');
} catch (failure) { db.exec('ROLLBACK'); throw failure; }
// An interrupted upstream may have consumed compute. Never blindly regenerate after restart.
db.prepare("UPDATE music_jobs SET status='interrupted', error_code='worker_interrupted', finished_at=? WHERE status='running'").run(Date.now());
const controllers = new Map();
let working = false;
const digest = value => createHash('sha256').update(value).digest('hex');
const error = (status, code) => Object.assign(new Error(code), { status, code });
const json = (res, status, value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes);
};
const authenticate = req => {
  const authorization = req.headers.authorization ?? '';
  if (!authorization.startsWith('Bearer ')) throw error(401, 'authentication_required');
  const value = Buffer.from(authorization.slice(7));
  const valid = keys.some(key => { const candidate = Buffer.from(key); return candidate.length === value.length && timingSafeEqual(candidate, value); });
  if (!valid) throw error(401, 'authentication_required');
  return digest(value);
};
const body = async req => {
  const pieces = []; let count = 0;
  for await (const piece of req) { count += piece.length; if (count > (models.has(MM3) ? 32768 : 20000)) throw error(413, 'body_too_large'); pieces.push(piece); }
  try { return { payload: JSON.parse(Buffer.concat(pieces).toString('utf8')), bytes: count }; } catch { throw error(400, 'invalid_json'); }
};
function requestWorker(config, headers, content, signal) {
  if (!config.mm3) return fetch(config.url, { method: 'POST', redirect: 'error', headers, signal, body: content });
  // MM3 can wait >700s for its first response. Use a native request governed by
  // our entire-job deadline, without fetch's separate internal header timeout.
  // Native http does not follow redirects; the caller rejects non-2xx below.
  return new Promise((resolve, reject) => {
    const transport = config.url.protocol === 'https:' ? https : http;
    const request = transport.request(config.url, { method: 'POST', headers: { ...headers, 'Content-Length': Buffer.byteLength(content) }, signal, agent: false }, response => {
      const status = response.statusCode ?? 0;
      resolve({ status, ok: status >= 200 && status < 300,
        headers: { get: name => response.headers[name.toLowerCase()] }, body: response });
    });
    request.once('error', reject);
    request.end(content);
  });
}
async function discardResponse(response) {
  if (response.body?.cancel) await response.body.cancel();
  else response.body?.destroy();
}
const output = job => ({ id: job.id, status: job.status,
  ...(job.model === MM3 ? { model: job.model, seed: job.seed, created_at: job.created,
    ...(job.started_at != null ? { started_at: job.started_at } : {}),
    ...(job.finished_at != null ? { finished_at: job.finished_at, elapsed_seconds: job.started_at == null ? 0 : (job.finished_at - job.started_at) / 1000 } : {}),
    ...(job.error_code ? { error_code: job.error_code } : {}) } : {}),
  ...(job.status === 'completed' ? { audio_url: `/v1/music/jobs/${job.id}/audio` } : {}) });
const owned = (id, owner) => {
  const job = db.prepare('SELECT * FROM music_jobs WHERE id=? AND owner=?').get(id, owner);
  if (!job) throw error(404, 'job_not_found'); return job;
};
async function pump() {
  if (working) return;
  working = true;
  try {
    while (true) {
      const job = db.prepare("SELECT * FROM music_jobs WHERE status='queued' ORDER BY created,id LIMIT 1").get();
      if (!job) break;
      const config = models.get(job.model);
      if (!config) {
        db.prepare("UPDATE music_jobs SET status='interrupted', error_code='model_unavailable', finished_at=? WHERE id=?").run(Date.now(), job.id);
        continue;
      }
      db.prepare("UPDATE music_jobs SET status='running', started_at=? WHERE id=?").run(Date.now(), job.id);
      const controller = new AbortController(); controllers.set(job.id, controller);
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, config.timeoutSeconds * 1000);
      try {
        const headers = { 'Content-Type': 'application/json' };
        if (config.key) headers.Authorization = `Bearer ${config.key}`;
        const request = { model: job.model, prompt: job.prompt, duration_seconds: job.seconds, instrumental: job.instrumental === 1,
          ...(job.instructions != null ? { instructions: job.instructions } : {}), ...(job.seed != null ? { seed: job.seed } : {}) };
        const response = await requestWorker(config, headers, JSON.stringify(request), controller.signal);
        if (!response.ok) {
          if (!config.mm3) { await discardResponse(response); throw new Error('worker_response'); }
          // Keep failure metadata bounded and never persist upstream text/lyrics.
          const parts = []; let size = 0;
          if (response.body) for await (const piece of response.body) {
            const part = Buffer.from(piece).subarray(0, 4096 - size); parts.push(part); size += part.length;
            if (size >= 4096) break;
          }
          const detail = Buffer.concat(parts).toString('utf8');
          let code = response.status >= 300 && response.status < 400 ? 'upstream_redirect_rejected' : 'worker_response';
          try {
            const candidate = JSON.parse(detail).error;
            if (['upstream_timeout', 'lyrics_too_long', 'upstream_unavailable', 'upstream_request_rejected', 'upstream_redirect_rejected', 'invalid_upstream_wav', 'worker_busy'].includes(candidate)) code = candidate;
          } catch {}
          throw new Error(code);
        }
        if (Number(response.headers.get('content-length') ?? 0) > maxAudio) { await discardResponse(response); throw new Error('audio_too_large'); }
        const pieces = []; let count = 0;
        for await (const piece of response.body) { count += piece.length; if (count > maxAudio) { controller.abort(); throw new Error('audio_too_large'); } pieces.push(piece); }
        const bytes = Buffer.concat(pieces, count);
        validateWAV(bytes, config, job.seconds);
        controller.signal.throwIfAborted();
        if (owned(job.id, job.owner).status === 'cancelled') continue;
        await writeFile(path.join(directory, `${job.id}.wav`), bytes, { mode: 0o600 });
        controller.signal.throwIfAborted();
        if (owned(job.id, job.owner).status === 'cancelled') { await rm(path.join(directory, `${job.id}.wav`), { force: true }); continue; }
        db.prepare("UPDATE music_jobs SET status='completed', finished_at=? WHERE id=?").run(Date.now(), job.id);
      } catch (failure) {
        await rm(path.join(directory, `${job.id}.wav`), { force: true }).catch(() => {});
        if (owned(job.id, job.owner).status !== 'cancelled') {
          const known = new Set(['upstream_timeout', 'lyrics_too_long', 'upstream_unavailable', 'upstream_request_rejected', 'upstream_redirect_rejected', 'invalid_upstream_wav', 'worker_busy', 'audio_too_large', 'worker_must_return_wav', 'invalid_mm3_wav', 'invalid_mm3_wav_format', 'invalid_mm3_wav_duration']);
          const code = timedOut ? 'worker_timeout' : known.has(failure.message) ? failure.message : 'worker_response';
          db.prepare("UPDATE music_jobs SET status='failed', error_code=?, finished_at=? WHERE id=?").run(code, Date.now(), job.id);
        }
      } finally { clearTimeout(timeout); controllers.delete(job.id); }
    }
  } finally { working = false; }
}
async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  if (url.search) throw error(400, 'query_not_supported');
  const owner = authenticate(req);
  if (req.method === 'GET' && url.pathname === '/v1/models') return json(res, 200, { data: Array.from(models.values(), config => config.metadata) });
  if (req.method === 'POST' && url.pathname === '/v1/music/jobs') {
    const { payload, bytes: requestBytes } = await body(req);
    const config = models.get(payload?.model);
    if (!config) throw error(400, 'invalid_generation_request');
    if (!config.mm3 && requestBytes > 20000) throw error(413, 'body_too_large');
    let instructions;
    if (config.mm3) instructions = validateMM3(payload, config.maxSeconds);
    else if (typeof payload.prompt !== 'string' || !payload.prompt.trim() || Buffer.byteLength(payload.prompt) > 16384 ||
        !Number.isInteger(payload.duration_seconds) || payload.duration_seconds < 3 || payload.duration_seconds > config.maxSeconds || payload.instrumental !== true) throw error(400, 'invalid_generation_request');
    if (typeof payload.idempotency_key !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(payload.idempotency_key) || req.headers['idempotency-key'] !== payload.idempotency_key) throw error(400, 'invalid_generation_request');
    // Preserve the exact legacy fingerprint. An omitted MM3 seed is represented
    // by null for idempotency, then sampled once and persisted only for a new job.
    const fingerprint = digest(JSON.stringify(config.mm3 ? [config.id, payload.prompt, payload.duration_seconds, false, instructions, payload.seed ?? null]
      : [config.id, payload.prompt, payload.duration_seconds, true]));
    const existing = db.prepare('SELECT * FROM music_jobs WHERE owner=? AND idem=?').get(owner, payload.idempotency_key);
    if (existing) { if (existing.fingerprint !== fingerprint) throw error(409, 'idempotency_conflict'); return json(res, 200, output(existing)); }
    if (db.prepare('SELECT COUNT(*) AS n FROM music_jobs').get().n >= maxJobs || db.prepare("SELECT COUNT(*) AS n FROM music_jobs WHERE status IN ('queued','running')").get().n >= 10) throw error(429, 'music_capacity');
    const id = randomUUID();
    db.prepare('INSERT INTO music_jobs (id,owner,idem,fingerprint,prompt,seconds,status,created,model,instructions,seed,instrumental) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id, owner, payload.idempotency_key, fingerprint, payload.prompt, payload.duration_seconds, 'queued', Date.now(), config.id,
        config.mm3 ? instructions : typeof payload.instructions === 'string' ? payload.instructions : typeof payload.caption === 'string' ? payload.caption : null,
        config.mm3 ? payload.seed ?? randomInt(0, 0x80000000) : null, config.mm3 ? 0 : 1);
    json(res, 202, output(owned(id, owner))); void pump(); return;
  }
  const match = /^\/v1\/music\/jobs\/([a-f0-9-]{36})(\/audio)?$/.exec(url.pathname);
  if (!match) throw error(404, 'not_found');
  const job = owned(match[1], owner);
  if (match[2]) {
    if (req.method !== 'GET' || job.status !== 'completed') throw error(404, 'audio_not_ready');
    const bytes = await readFile(path.join(directory, `${job.id}.wav`));
    res.writeHead(200, { 'Content-Type': 'audio/wav', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes); return;
  }
  if (req.method === 'GET') return json(res, 200, output(job));
  if (req.method === 'DELETE') {
    if (job.status !== 'completed') {
      db.prepare("UPDATE music_jobs SET status='cancelled', finished_at=? WHERE id=?").run(Date.now(), job.id);
      controllers.get(job.id)?.abort();
    }
    return json(res, 200, output(owned(job.id, owner)));
  }
  throw error(405, 'method_not_allowed');
}
let activeRequests = 0;
const server = http.createServer((req, res) => {
  if (activeRequests >= 16) { json(res, 429, { error: 'request_capacity' }); req.resume(); return; }
  activeRequests++;
  handle(req, res).catch(failure => {
    if (!res.headersSent) json(res, failure.status ?? 500, { error: failure.status ? failure.code : 'music_service_error' }); else res.destroy();
    req.resume();
  }).finally(() => { activeRequests--; });
});
server.requestTimeout = 30000; server.headersTimeout = 15000;
server.listen(port, process.env.NODE_MUSIC_HOST ?? '127.0.0.1');
void pump();
