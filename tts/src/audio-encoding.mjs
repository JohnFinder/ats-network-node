import { mkdtemp, open, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';

const execute = promisify(execFile);
let active = 0;
export const compressionAvailable = () => active < 2;

// Opt-in extension: keep the upstream and legacy clients on their WAV contract.
// Transcode on the server once, so receivers can play/store the same AAC bytes.
// Admission is shared with synthesis; each encoder uses one CPU thread.
export async function compressedAudio(response, res, signal, maximumBytes) {
  active++;
  let reader, directory;
  try {
    directory = await mkdtemp(join(tmpdir(), 'ats-tts-aac-'));
    const input = join(directory, 'source.wav'), output = join(directory, 'speech.m4a');
    const declared = response.headers.get('content-length');
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > maximumBytes)) throw new Error('engine_response_too_large');
    reader = response.body?.getReader();
    if (!reader) throw new Error('empty_engine_response');
    const file = await open(input, 'wx');
    let size = 0, header = Buffer.alloc(0);
    try {
      while (true) {
        signal.throwIfAborted();
        const { value, done } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > maximumBytes) throw new Error('engine_response_too_large');
        if (header.length < 12) header = Buffer.concat([header, Buffer.from(value).subarray(0, 12 - header.length)]);
        let offset = 0;
        while (offset < value.length) {
          const { bytesWritten } = await file.write(value, offset, value.length - offset);
          if (!bytesWritten) throw new Error('audio_write_failed');
          offset += bytesWritten;
        }
      }
    } finally { await file.close(); }
    if (size < 44 || (declared && size !== Number(declared)) || header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') throw new Error('invalid_engine_audio');
    let path = input, type = 'audio/wav';
    try {
      // Fixed filenames and arguments; never invoke a shell or accept paths,
      // filters or executable names from a client. M4A preserves gapless trim.
      await execute('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error',
        '-threads', '1', '-protocol_whitelist', 'file,pipe', '-f', 'wav', '-i', input,
        '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'aac',
        '-b:a', '48k', '-threads', '1', '-movflags', '+faststart',
        '-fs', String(maximumBytes), '-f', 'ipod', output],
      { signal, timeout: 30_000, maxBuffer: 64 * 1024, killSignal: 'SIGKILL' });
      const encodedSize = (await stat(output)).size;
      if (encodedSize > 0 && encodedSize < size * 0.9) { path = output; type = 'audio/mp4'; }
    } catch (error) {
      signal.throwIfAborted();
      // Missing/unavailable encoder must not trigger another costly synthesis.
      // Return the original bounded WAV in the same successful response.
    }
    signal.throwIfAborted();
    const audio = await readFile(path);
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': audio.length,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    const finished = once(res, 'finish', { signal });
    res.end(audio);
    await finished;
  } finally {
    try {
      await reader?.cancel().catch(() => {});
      if (directory) await rm(directory, { recursive: true, force: true });
    } finally { active--; }
  }
}
