export const STABLE_AUDIO = 'stabilityai/stable-audio-open-1.0';
export const MM3 = 'MiniMaxAI/MiniMax-Music3';
export const MAX_AUDIO_BYTES = 50_000_000;

export const requestError = (status, code) => Object.assign(new Error(code), { status, code });
const integer = (value, fallback, maximum, name) => {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n <= 0 || n > maximum) throw new Error(`Invalid ${name}`);
  return n;
};

export function workerURL(value) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search || !['http:', 'https:'].includes(url.protocol) ||
      (url.protocol === 'http:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))) throw new Error('Worker must use HTTPS or loopback HTTP');
  return url;
}

export function modelRegistry(env = process.env) {
  const selected = env.NODE_MUSIC_MODEL ?? STABLE_AUDIO;
  const registry = new Map();
  const add = (id, suffix, explicitURL) => {
    const mm3 = id === MM3;
    const maxSeconds = integer(env[`NODE_MUSIC_MAX_SECONDS_${suffix}`] ?? (mm3 ? undefined : env.NODE_MUSIC_MAX_SECONDS),
      mm3 ? 360 : 47, mm3 ? 360 : 120, `NODE_MUSIC_MAX_SECONDS_${suffix}`);
    if (maxSeconds < 3) throw new Error('Music duration limit must be at least 3 seconds');
    const timeoutSeconds = integer(env[`NODE_MUSIC_WORKER_TIMEOUT_SECONDS_${suffix}`],
      mm3 ? maxSeconds * 2 + 30 : 600, 86400, `NODE_MUSIC_WORKER_TIMEOUT_SECONDS_${suffix}`);
    const key = env[`NODE_MUSIC_WORKER_API_KEY_${suffix}`] ?? env.NODE_MUSIC_WORKER_API_KEY;
    registry.set(id, { id, mm3, maxSeconds, timeoutSeconds, key,
      url: workerURL(explicitURL ?? env.NODE_MUSIC_WORKER_URL ?? `http://127.0.0.1:${mm3 ? 8793 : 8792}/generate`),
      metadata: { id, capabilities: ['music-generation'], max_duration_seconds: maxSeconds, audio_format: 'wav',
        ...(mm3 ? { sample_rate: 32000, channels: 2, stereo: true, max_seconds: maxSeconds,
          generative_only: true, instrumental_supported: false, attribution: 'MiniMax-Music3',
          license_url: 'https://huggingface.co/MiniMaxAI/MiniMax-Music3/blob/main/LICENSE' } : {}) } });
  };
  const suffix = selected === MM3 ? 'MINIMAX_MUSIC3' : 'STABLE_AUDIO';
  add(selected, suffix, env[`NODE_MUSIC_WORKER_URL_${suffix}`]);
  for (const [id, name] of [[STABLE_AUDIO, 'STABLE_AUDIO'], [MM3, 'MINIMAX_MUSIC3']]) {
    if (!registry.has(id) && env[`NODE_MUSIC_WORKER_URL_${name}`]) add(id, name, env[`NODE_MUSIC_WORKER_URL_${name}`]);
  }
  return registry;
}

// A documented heuristic, not a tokenizer: alphabetic runs ~3 chars/token,
// CJK characters/punctuation individually, supplementary Unicode conservatively.
// The worker maps a stricter upstream tokenizer rejection to lyrics_too_long.
export function estimatedTokens(text) {
  return (text.match(/[A-Za-z0-9]+|\s+|./gu) ?? []).reduce((n, part) => n +
    (/^[A-Za-z0-9]/.test(part) ? Math.ceil(part.length / 3) : /^\s/.test(part) ? Math.ceil(part.length / 4) : part.codePointAt(0) > 0xffff ? 4 : 1), 0);
}

export function validateMM3(payload, maxSeconds = 360) {
  const fail = code => { throw requestError(400, code); };
  if (payload.instrumental === true) fail('instrumental_not_supported');
  const allowed = new Set(['model', 'prompt', 'duration_seconds', 'instrumental', 'seed', 'instructions', 'caption', 'idempotency_key']);
  for (const field of Object.keys(payload)) {
    if (!allowed.has(field)) fail(/ref|voice|melody/i.test(field) ? 'generative_only' : 'unsupported_parameter');
  }
  if (payload.instrumental !== undefined && payload.instrumental !== false) fail('invalid_instrumental');
  if (!Number.isInteger(payload.duration_seconds) || payload.duration_seconds < 3 || payload.duration_seconds > maxSeconds) fail('duration_out_of_range');
  if (typeof payload.prompt !== 'string' || !payload.prompt.trim()) fail('invalid_lyrics');
  if (Buffer.byteLength(payload.prompt) > 16384 || estimatedTokens(payload.prompt) > 5000) fail('lyrics_too_long');
  for (const line of payload.prompt.split(/\r?\n/)) {
    const tags = line.match(/\[(?:Verse(?:\s+\d+)?|Chorus(?:\s+\d+)?|Intro|Bridge|Outro|Pre-Chorus|Post-Chorus|Instrumental|Solo)\]/gi);
    if (tags && (tags.length !== 1 || line.trim() !== tags[0])) fail('lyrics_structure_tag_must_be_on_own_line');
  }
  if (payload.instructions !== undefined && typeof payload.instructions !== 'string') fail('invalid_instructions');
  if (payload.caption !== undefined && typeof payload.caption !== 'string') fail('invalid_instructions');
  if (payload.instructions !== undefined && payload.caption !== undefined && payload.instructions !== payload.caption) fail('caption_conflict');
  const instructions = payload.instructions ?? payload.caption ?? '';
  if (Buffer.byteLength(instructions) > 8192 || estimatedTokens(payload.prompt) + estimatedTokens(instructions) > 5000) fail('lyrics_too_long');
  if (payload.seed !== undefined && (!Number.isSafeInteger(payload.seed) || payload.seed < 0)) fail('invalid_seed');
  for (const field of ['voice', 'ref_audio', 'reference_audio', 'reference_melody', 'melody']) {
    if (payload[field] !== undefined) fail('generative_only');
  }
  return instructions;
}

export function validateWAV(bytes, config, seconds) {
  if (bytes.length < 44 || bytes.length > MAX_AUDIO_BYTES || bytes.toString('ascii', 0, 4) !== 'RIFF' || bytes.toString('ascii', 8, 12) !== 'WAVE') throw new Error('worker_must_return_wav');
  if (!config.mm3) return; // Preserve the existing Stable Audio contract.
  if (bytes.readUInt32LE(4) + 8 !== bytes.length) throw new Error('invalid_mm3_wav');
  let format = false, dataBytes = 0, offset = 12;
  for (; offset + 8 <= bytes.length;) {
    const kind = bytes.toString('ascii', offset, offset + 4), size = bytes.readUInt32LE(offset + 4), start = offset + 8;
    if (start + size > bytes.length) throw new Error('invalid_mm3_wav');
    if (kind === 'fmt ') {
      if (format || size < 16) throw new Error('invalid_mm3_wav');
      const encoding = bytes.readUInt16LE(start);
      const pcm = encoding === 1 || (encoding === 0xfffe && size >= 40 && bytes.subarray(start + 24, start + 40).equals(Buffer.from('0100000000001000800000aa00389b71', 'hex')));
      if (!pcm || bytes.readUInt16LE(start + 2) !== 2 || bytes.readUInt32LE(start + 4) !== 32000 ||
          bytes.readUInt32LE(start + 8) !== 128000 || bytes.readUInt16LE(start + 12) !== 4 || bytes.readUInt16LE(start + 14) !== 16) throw new Error('invalid_mm3_wav_format');
      format = true;
    } else if (kind === 'data') {
      if (dataBytes) throw new Error('invalid_mm3_wav');
      dataBytes = size;
    }
    offset = start + size + size % 2;
  }
  if (offset !== bytes.length || !format || !dataBytes || dataBytes % 4 || dataBytes / 128000 > seconds + .1) throw new Error('invalid_mm3_wav_duration');
}
