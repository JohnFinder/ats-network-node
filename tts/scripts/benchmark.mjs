// An explicitly invoked, bounded performance experiment. No text/audio/key is
// recorded in the result. Run against the same warm engine and compare hardware.
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';

const args = process.argv.slice(2);
function option(name, fallback) {
  const index = args.indexOf(name);
  if (index < 0) return fallback;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name}`);
  return args[index + 1];
}
const origin = new URL(option('--url', 'http://127.0.0.1:8791'));
if (origin.protocol !== 'https:' && !(origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname))) throw new Error('Use HTTPS outside loopback');
if (origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') throw new Error('Provide the endpoint origin only');
const key = (await readFile(option('--key-file', 'secrets/tts_api_key'), 'utf8')).trim();
const count = Number(option('--requests', '8'));
const concurrency = Number(option('--concurrency', '1'));
if (!Number.isInteger(count) || count < 1 || count > 60 || !Number.isInteger(concurrency) || concurrency < 1 || concurrency > 8) throw new Error('Use requests 1...60 and concurrency 1...8');
const texts = [
  '这是用于测量有声书合成速度的固定短文。预热与正式测量分开进行，并分别记录音频时长和请求耗时。',
  'This fixed paragraph measures audiobook synthesis. Warmup is recorded separately from steady state, and audio duration is measured from the returned waveform.',
  '音声合成の速度を測定します。準備にかかる時間と、継続して利用するときの速度を分けて記録します。'
];
const reference = option('--ref-wav');
const refAudio = reference ? `data:audio/wav;base64,${(await readFile(reference)).toString('base64')}` : undefined;
const refTextPath = option('--ref-text-file');
const refText = refTextPath ? (await readFile(refTextPath, 'utf8')).trim() : undefined;
if (refText && !refAudio) throw new Error('Reference transcript needs --ref-wav');

function audioDuration(buffer) {
  if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Invalid WAV response');
  let byteRate = 0, dataBytes = 0;
  for (let offset = 12; offset + 8 <= buffer.length;) {
    const kind = buffer.toString('ascii', offset, offset + 4), size = buffer.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > buffer.length) throw new Error('Truncated WAV response');
    if (kind === 'fmt ' && size >= 16) byteRate = buffer.readUInt32LE(start + 8);
    if (kind === 'data') dataBytes += size;
    offset = start + size + size % 2;
  }
  if (!byteRate || !dataBytes) throw new Error('Empty WAV response');
  return dataBytes / byteRate;
}
async function synthesize(index) {
  const started = performance.now();
  const response = await fetch(new URL('/v1/audio/speech', origin), {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'openbmb/VoxCPM2', input: texts[index % texts.length], voice: 'default', response_format: 'wav', stream: false, ...(refAudio ? { ref_audio: refAudio } : {}), ...(refText ? { ref_text: refText } : {}) }),
    signal: AbortSignal.timeout(180000), redirect: 'error'
  });
  const firstResponseByteSeconds = (performance.now() - started) / 1000;
  if (!response.ok) { await response.body?.cancel(); throw new Error(`Endpoint returned HTTP ${response.status}`); }
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.length;
    if (bytes > 64 * 1024 * 1024) throw new Error('Response too large');
    chunks.push(chunk);
  }
  const wallSeconds = (performance.now() - started) / 1000;
  const audioSeconds = audioDuration(Buffer.concat(chunks));
  return { wallSeconds, firstResponseByteSeconds, audioSeconds, rtf: wallSeconds / audioSeconds, bytes };
}
let hardware = 'not available on benchmark client';
try { hardware = execFileSync('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch {}
const warmup = [];
for (let i = 0; i < 2; i++) warmup.push(await synthesize(i));
const results = [], started = performance.now(); let next = 0;
await Promise.all(Array.from({ length: concurrency }, async () => {
  while (next < count) { const index = next++; results[index] = await synthesize(index); }
}));
const elapsedSeconds = (performance.now() - started) / 1000;
const percentile = (key, fraction) => results.map(x => x[key]).sort((a, b) => a - b)[Math.ceil(count * fraction) - 1];
const report = {
  schemaVersion: 1, timestamp: new Date().toISOString(), model: 'openbmb/VoxCPM2', engine: 'vllm-omni-0.30.0', clientHardware: hardware, concurrency, count, cloning: Boolean(refAudio),
  timingNote: 'Non-streaming WAV: first response byte includes server buffering and is not streaming time-to-first-audio. Client hardware may differ from server hardware.',
  warmup, elapsedSeconds, audioSecondsPerWallSecond: results.reduce((sum, x) => sum + x.audioSeconds, 0) / elapsedSeconds,
  p50LatencySeconds: percentile('wallSeconds', 0.5), p95LatencySeconds: percentile('wallSeconds', 0.95), p50RTF: percentile('rtf', 0.5), p95RTF: percentile('rtf', 0.95), results
};
const output = option('--output');
if (output) await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
else console.log(JSON.stringify(report, null, 2));
