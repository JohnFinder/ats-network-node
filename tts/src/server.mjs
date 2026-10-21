// The only public interface to the private vLLM-Omni process. No user-supplied
// URL, filesystem path, model identifier or extra engine argument is forwarded.
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { createHash, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';

const model = 'openbmb/VoxCPM2';
const bounded = (name, fallback, minimum, maximum) => {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`Invalid ${name}`);
  return value;
};
const port = bounded('TTS_PORT', 8791, 1, 65535);
const maxConcurrent = bounded('TTS_MAX_CONCURRENT', 8, 1, 128);
const maxBody = bounded('TTS_MAX_BODY_BYTES', 12 * 1024 * 1024, 1024, 16 * 1024 * 1024);
const maxResponse = bounded('TTS_MAX_RESPONSE_BYTES', 64 * 1024 * 1024, 1024, 128 * 1024 * 1024);
const timeout = bounded('TTS_TIMEOUT_SECONDS', 180, 5, 600) * 1000;
const upstream = new URL(process.env.TTS_UPSTREAM ?? 'http://voxcpm2:8000');
if (upstream.protocol !== 'http:' || upstream.username || upstream.password || upstream.pathname !== '/' || upstream.search || upstream.hash) throw new Error('TTS_UPSTREAM must be a private HTTP origin');
const secret = readFileSync(process.env.TTS_API_KEY_FILE ?? '/run/secrets/tts_api_key', 'utf8').trim();
if (!/^[A-Za-z0-9_-]{43,128}$/.test(secret)) throw new Error('Generate a TTS API key before starting the gateway');
const digest = value => createHash('sha256').update(value).digest();
const secretDigest = digest(secret);
let active = 0;

class RequestError extends Error {
  constructor(status, code) { super(code); this.status = status; this.code = code; }
}
const fail = (status, code) => { throw new RequestError(status, code); };
function json(res, status, value) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...(status === 429 ? { 'Retry-After': '2' } : {}) });
  res.end(JSON.stringify(value));
}
function authenticate(req) {
  const value = req.headers.authorization;
  const token = typeof value === 'string' && value.startsWith('Bearer ') ? value.slice(7) : '';
  if (token.length > 128 || !timingSafeEqual(digest(token), secretDigest)) fail(401, 'invalid_api_key');
}
async function requestBody(req) {
  if (!/^application\/json(?:\s*;.*)?$/i.test(req.headers['content-type'] ?? '')) fail(415, 'json_required');
  const length = req.headers['content-length'];
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBody)) fail(413, 'request_too_large');
  const chunks = []; let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > maxBody) fail(413, 'request_too_large');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail(400, 'invalid_json'); }
}

function validateReference(value) {
  if (typeof value !== 'string') fail(400, 'invalid_reference_audio');
  const match = /^data:audio\/(?:wav|x-wav|wave);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match || match[1].length % 4) fail(400, 'reference_requires_wav_data_uri');
  const wav = Buffer.from(match[1], 'base64');
  if (wav.length > 8 * 1024 * 1024 || wav.length < 44 || wav.toString('ascii', 0, 4) !== 'RIFF' || wav.toString('ascii', 8, 12) !== 'WAVE' || wav.readUInt32LE(4) + 8 !== wav.length) fail(400, 'invalid_reference_wav');
  let byteRate = 0, blockAlign = 0, dataSize = 0, formatSeen = false;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const type = wav.toString('ascii', offset, offset + 4), size = wav.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > wav.length) fail(400, 'invalid_reference_wav');
    if (type === 'fmt ') {
      if (formatSeen || size < 16) fail(400, 'invalid_reference_wav');
      formatSeen = true;
      const encoding = wav.readUInt16LE(start), channels = wav.readUInt16LE(start + 2), rate = wav.readUInt32LE(start + 4), bits = wav.readUInt16LE(start + 14);
      byteRate = wav.readUInt32LE(start + 8); blockAlign = wav.readUInt16LE(start + 12);
      if (![1, 3].includes(encoding) || channels < 1 || channels > 2 || rate < 8000 || rate > 96000 || ![16, 24, 32].includes(bits) || (encoding === 3 && bits !== 32) || blockAlign !== channels * bits / 8 || byteRate !== rate * blockAlign) fail(400, 'reference_requires_pcm_wav');
    } else if (type === 'data') {
      if (dataSize) fail(400, 'invalid_reference_wav');
      dataSize = size;
    } else if (!['JUNK', 'LIST', 'fact', 'bext', 'PAD '].includes(type)) {
      // In particular, reject external sample references and codec-specific chunks.
      fail(400, 'unsupported_reference_wav_chunk');
    }
    offset = start + size + (size % 2);
  }
  if (!byteRate || !dataSize || dataSize % blockAlign || dataSize / byteRate > 45) fail(400, 'reference_duration_exceeded');
  return `data:audio/wav;base64,${wav.toString('base64')}`;
}

function payload(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(400, 'invalid_request');
  const allowed = new Set(['model', 'input', 'voice', 'response_format', 'ref_audio', 'ref_text', 'stream', 'speed', 'language']);
  if (Object.keys(value).some(key => !allowed.has(key))) fail(400, 'unsupported_parameter');
  if (![model, 'voxcpm2'].includes(value.model)) fail(400, 'unsupported_model');
  if (typeof value.input !== 'string' || value.input.length > 8192 || !value.input.trim() || [...value.input].length > 4096) fail(400, 'invalid_input_length');
  if (value.voice !== undefined && value.voice !== 'default') fail(400, 'unsupported_voice');
  if (value.response_format !== undefined && value.response_format !== 'wav') fail(400, 'wav_required');
  if (value.stream !== undefined && value.stream !== false) fail(400, 'streaming_not_supported');
  // Playback speed is applied in ATS, keeping local and remote voice behavior identical.
  if (value.speed !== undefined && value.speed !== 1) fail(400, 'unsupported_speed');
  // ATS preserves an explicit language for its LAN Mac host. VoxCPM2 infers it
  // from text, so validate this compatibility field without forwarding it.
  if (value.language !== undefined && (typeof value.language !== 'string' || !/^(?:auto|[a-z]{2,3}(?:[-_][A-Za-z0-9]{2,8}){0,2})$/.test(value.language))) fail(400, 'invalid_language');
  const output = { model, input: value.input, voice: 'default', response_format: 'wav', stream: false };
  if (value.ref_audio !== undefined) output.ref_audio = validateReference(value.ref_audio);
  if (value.ref_text !== undefined) {
    if (!output.ref_audio || typeof value.ref_text !== 'string' || value.ref_text.length > 8192 || [...value.ref_text].length > 4096) fail(400, 'invalid_reference_text');
    if (value.ref_text.trim()) output.ref_text = value.ref_text;
  }
  return output;
}

async function forwardAudio(response, res, signal) {
  let size = 0, header = Buffer.alloc(0), started = false;
  const declared = response.headers.get('content-length');
  const reader = response.body?.getReader();
  if (!reader) fail(502, 'empty_engine_response');
  try {
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maxResponse)) fail(502, 'engine_response_too_large');
    while (true) {
      if (signal.aborted) throw signal.reason;
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxResponse) fail(502, 'engine_response_too_large');
      let chunk = Buffer.from(value);
      if (!started) {
        header = Buffer.concat([header, chunk]);
        if (header.length < 44) continue;
        if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') fail(502, 'invalid_engine_audio');
        res.writeHead(200, { 'Content-Type': 'audio/wav', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'X-ATS-Sample-Rate': '48000', ...(declared ? { 'Content-Length': declared } : {}) });
        chunk = header; header = Buffer.alloc(0); started = true;
      }
      // Forward the completed (non-streaming model) WAV with backpressure;
      // never buffer many entire audiobooks in gateway memory.
      if (!res.write(chunk)) await once(res, 'drain', { signal });
    }
    if (!started || (declared && size !== Number(declared))) fail(502, 'invalid_engine_audio');
    res.end();
  } finally { await reader.cancel().catch(() => {}); }
}

async function ready(signal) {
  const response = await fetch(new URL('/health', upstream), { signal, redirect: 'error' });
  await response.body?.cancel();
  return response.ok;
}

async function route(req, res) {
  if (req.url === '/health' && req.method === 'GET') return json(res, 200, { status: 'ok' });
  if (!['/v1/models', '/v1/audio/speech'].includes(req.url)) fail(404, 'not_found');
  authenticate(req);
  if (req.url === '/v1/models' && req.method === 'GET') {
    if (!await ready(AbortSignal.timeout(3000))) fail(503, 'engine_unavailable');
    return json(res, 200, { object: 'list', data: [{ id: model, object: 'model', owned_by: 'openbmb', capabilities: ['speech', 'voice-cloning'], sample_rate: 48000 }] });
  }
  if (req.url !== '/v1/audio/speech' || req.method !== 'POST') fail(405, 'method_not_allowed');
  // Admission happens before reading audio, bounding concurrent body memory as well as GPU work.
  if (active >= maxConcurrent) fail(429, 'tts_busy');
  active++;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('deadline')), timeout);
  const abort = () => { if (!res.writableEnded) controller.abort(new Error('client_disconnected')); };
  req.on('aborted', abort); res.on('close', abort);
  try {
    const value = payload(await requestBody(req));
    const response = await fetch(new URL('/v1/audio/speech', upstream), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value), signal: controller.signal, redirect: 'error' });
    if (!response.ok) { await response.body?.cancel(); fail(response.status === 429 || response.status === 503 ? 503 : 502, 'engine_unavailable'); }
    await forwardAudio(response, res, controller.signal);
  } catch (error) {
    if (controller.signal.aborted) fail(504, 'tts_deadline_exceeded');
    throw error;
  } finally {
    clearTimeout(timer); req.off('aborted', abort); res.off('close', abort); active--;
  }
}

const server = http.createServer({ maxHeaderSize: 8192 }, (req, res) => {
  route(req, res).catch(error => {
    if (res.headersSent) { res.destroy(); return; }
    json(res, error instanceof RequestError ? error.status : 503, { error: { code: error instanceof RequestError ? error.code : 'tts_unavailable' } });
  });
});
server.requestTimeout = Math.min(timeout, 30000);
server.headersTimeout = 10000;
server.keepAliveTimeout = 5000;
// Leave room for idle keep-alive sockets, probes, and busy responses even when
// every synthesis slot is occupied. Socket count is not the admission limit.
server.maxConnections = Math.max(128, maxConcurrent * 2 + 32);
server.listen(port, '0.0.0.0', () => console.log(`ATS VoxCPM2 gateway listening on ${port}; max_concurrent=${maxConcurrent}`));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
  server.close(); server.closeIdleConnections();
  setTimeout(() => process.exit(0), 5000).unref();
});
