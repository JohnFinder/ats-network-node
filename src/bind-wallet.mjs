// Operator-only CLI. Signs with the node identity in-place; never exports its key.
import { readFile, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createPrivateKey, createPublicKey, createHash, sign } from 'node:crypto';
import { fileURLToPath } from 'node:url';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export async function beginProviderBinding({ services, wallet, serviceID, development = false, dataDir = process.env.NODE_DATA_DIR ?? './data' }) {
  const base = new URL(services);
  if (base.username || base.password || base.hash || base.search || !['', '/'].includes(base.pathname) || (base.protocol !== 'https:' && !(development && base.protocol === 'http:'))) throw new Error('Explicit HTTPS services origin required');
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet) || !/^[0-9a-f]{64}$/.test(serviceID)) throw new Error('Wallet address and verified services fingerprint required');
  async function request(target, body) {
    const response = await fetch(base.origin + target, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, redirect: 'error', signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error(`Service rejected request (${response.status})`);
    const chunks = []; let length = 0;
    for await (const chunk of response.body) { length += chunk.length; if (length > 262144) throw new Error('Service response too large'); chunks.push(chunk); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const network = await request('/v2/network');
  const serviceKey = Buffer.from(network.servicePublicKey, 'base64');
  if (serviceKey.length !== 32 || sha(serviceKey) !== serviceID || network.serviceID !== serviceID || !Number.isSafeInteger(network.chainId) || network.chainId <= 0) throw new Error('Service identity or network mismatch');
  const nonce = await request(`/v2/binding-nonce?wallet=${wallet}`);
  if (nonce.chainId !== network.chainId || !/^\d{1,78}$/.test(nonce.nonce) || !/^0x[0-9a-fA-F]{40}$/.test(nonce.registry) || nonce.registry.toLowerCase() !== network.contracts?.identity?.address?.toLowerCase()) throw new Error('Registry or nonce mismatch');
  const keyFile = path.join(dataDir, 'provider-key.der'), info = await lstat(keyFile);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 1024 || (info.mode & 0o077)) throw new Error('Private node identity file permissions invalid');
  const key = createPrivateKey({ key: await readFile(keyFile), format: 'der', type: 'pkcs8' });
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('Expected Ed25519 identity');
  const raw = createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32), fingerprint = sha(raw), expiresAt = Math.floor(Date.now() / 1000) + 90 * 86400;
  const statement = `ATS-WALLET-BIND-V1\n${network.chainId}\n${nonce.registry.toLowerCase()}\n${wallet.toLowerCase()}\n${fingerprint}\n${nonce.nonce}\n${expiresAt}`;
  const intent = await request('/v2/binding-intents', { walletAddress: wallet, publicKey: raw.toString('base64'), nonce: nonce.nonce, expiresAt, chainId: network.chainId, registry: nonce.registry, statement, signature: sign(null, Buffer.from(statement), key).toString('base64') });
  const url = new URL(intent.walletURL);
  if (intent.statement !== statement || intent.bindingExpiresAt !== expiresAt || !Number.isSafeInteger(intent.expiresAt) || intent.expiresAt <= Date.now() / 1000 || intent.expiresAt > Date.now() / 1000 + 900 || !/^[0-9a-f-]{36}$/i.test(intent.intentID) || url.origin !== base.origin || url.pathname !== '/wallet' || url.search !== `?intent=${intent.intentID}`) throw new Error('Invalid wallet authorization link');
  return { providerID: fingerprint, wallet, chainId: network.chainId, registry: nonce.registry, walletURL: url.href, expiresAt: intent.expiresAt, bindingExpiresAt: expiresAt, action: 'Review and authorize in your external wallet. No on-chain change has been made.' };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2), input = {};
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--development-http') { input.development = true; continue; }
      const field = { '--services': 'services', '--wallet': 'wallet', '--service-id': 'serviceID' }[args[i]];
      if (!field || input[field] || !args[i + 1]) throw new Error('Usage: bind-wallet.mjs --services HTTPS_ORIGIN --wallet 0xADDRESS --service-id VERIFIED_FINGERPRINT');
      input[field] = args[++i];
    }
    console.log(JSON.stringify(await beginProviderBinding(input), null, 2));
  } catch (error) { console.error(`Provider wallet binding stopped: ${error.message}`); process.exitCode = 1; }
}
