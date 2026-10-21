import { mkdir, open, chmod } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { dirname, resolve } from 'node:path';

// Never print the key or replace an existing one. The operator transfers it to
// authorized ATS clients using their own secure channel.
const target = resolve(process.argv[2] ?? 'secrets/tts_api_key');
await mkdir(dirname(target), { recursive: true, mode: 0o700 });
let file;
try { file = await open(target, 'wx', 0o600); }
catch (error) {
  if (error.code === 'EEXIST') { console.log('TTS key already exists; left unchanged.'); process.exit(0); }
  throw error;
}
try { await file.writeFile(`${randomBytes(32).toString('base64url')}\n`); }
finally { await file.close(); }
// Docker Compose file secrets retain host permissions on Linux. Group-readable
// mode plus a dedicated numeric group lets the non-root gateway read this file.
await chmod(target, 0o640);
console.log(`Created API key file: ${target}. Keep it private; configure TTS_SECRET_GID to this file's group ID.`);
