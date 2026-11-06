import { createHash, createPrivateKey, createPublicKey, randomUUID, sign } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');

async function main() {
  const [origin, method, route, bodyPath] = process.argv.slice(2);
  const keyPath = process.env.ATS_MODERATION_PRIVATE_KEY_FILE;
  if (!keyPath) throw new Error('Set ATS_MODERATION_PRIVATE_KEY_FILE to an Ed25519 PEM file.');
  const key = createPrivateKey(await readFile(keyPath));
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('An Ed25519 private key is required.');
  const rawKey = createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
  if (origin === 'subject' && !method) {
    process.stdout.write(`${sha(rawKey)}\n`);
    return;
  }

  const base = new URL(origin);
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname);
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      !(base.protocol === 'https:' || (base.protocol === 'http:' && loopback))) throw new Error('Use an HTTPS service origin.');
  const allowed = method === 'GET' ? /^\/v1\/(?:moderation\/(?:queue|reports)(?:\?offset=\d+)?|resources\/[a-f0-9-]+\/download|voice-packages\/[a-f0-9-]+\/versions\/[A-Za-z0-9._-]+\/content)$/i
    : /^\/v1\/moderation\/(?:reports\/[a-f0-9-]+\/resolve|resources\/[a-f0-9-]+|voice-packages\/[a-f0-9-]+\/versions\/[A-Za-z0-9._-]+)$/i;
  if (!['GET', 'POST'].includes(method) || !route || !allowed.test(route) || (method === 'POST') !== Boolean(bodyPath)) {
    throw new Error('Use <origin> GET <review path> or <origin> POST <review path> <JSON file>.');
  }
  const url = new URL(route, base);
  if (`${url.pathname}${url.search}` !== route) throw new Error('Use the canonical review path.');
  const body = bodyPath ? await readFile(bodyPath) : Buffer.alloc(0);
  if (body.length > 16384) throw new Error('The JSON file must be 16 KiB or smaller.');
  const timestamp = String(Math.floor(Date.now() / 1000)), nonce = randomUUID();
  const message = `ATS-NODE-V1\n${base.origin}\n${method}\n${route}\n${timestamp}\n${nonce}\n${sha(body)}`;
  const headers = { 'X-ATS-Audience': base.origin, 'X-ATS-Public-Key': rawKey.toString('base64'), 'X-ATS-Timestamp': timestamp,
    'X-ATS-Nonce': nonce, 'X-ATS-Signature': sign(null, Buffer.from(message), key).toString('base64') };
  if (bodyPath) headers['Content-Type'] = 'application/json';
  const response = await fetch(url, { method, headers, body: bodyPath ? body : undefined, redirect: 'error', signal: AbortSignal.timeout(120_000) });
  if (!response.ok) throw new Error(`Review request failed (${response.status}): ${await response.text()}`);
  if (response.body) await pipeline(Readable.fromWeb(response.body), process.stdout);
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
