import { createHash, createPublicKey, createPrivateKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import path from 'node:path';
import { verifyTypedData, getAddress, keccak256 } from 'ethers';

export const sha = bytes => createHash('sha256').update(bytes).digest('hex');
export const now = () => Math.floor(Date.now() / 1000);
export const digest = value => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
export const integer = (value, fallback, max = Number.MAX_SAFE_INTEGER, min = 1) => {
  const n = Number(value ?? fallback);
  if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error('invalid_integer_configuration');
  return n;
};
export function origin(value, development = false) {
  const url = new URL(value);
  if (url.username || url.password || url.hash || url.search || url.pathname !== '/' ||
      !(url.protocol === 'https:' || (development && url.protocol === 'http:'))) throw new Error('https_origin_required');
  return url.origin;
}
export function rawKey(value) {
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== 32 || bytes.toString('base64') !== value) throw new Error('invalid_ed25519_public_key');
  return bytes;
}
export function edKey(bytes) {
  return createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), bytes]), format: 'der', type: 'spki' });
}
export function verifyEnvelope(envelope, pinned) {
  if (!envelope || typeof envelope.payloadBytes !== 'string' || envelope.payloadBytes.length > 3 * 1024 * 1024) throw new Error('invalid_envelope');
  const bytes = Buffer.from(envelope.payloadBytes, 'base64'), key = rawKey(envelope.publicKey);
  if (bytes.toString('base64') !== envelope.payloadBytes || !pinned.has(sha(key)) || !verify(null, bytes, edKey(key), Buffer.from(envelope.signature ?? '', 'base64'))) throw new Error('untrusted_signature');
  return { bytes, payload: JSON.parse(bytes) };
}
export async function signingIdentity(file, dataDir) {
  let key;
  const target = file ?? path.join(dataDir, 'service-ed25519.der');
  try { key = createPrivateKey({ key: await readFile(target), type: 'pkcs8', format: 'der' }); }
  catch (error) {
    if (error.code !== 'ENOENT' || file) throw error;
    key = generateKeyPairSync('ed25519').privateKey;
    await writeFile(target, key.export({ type: 'pkcs8', format: 'der' }), { mode: 0o600, flag: 'wx' });
  }
  if (key.asymmetricKeyType !== 'ed25519') throw new Error('ed25519_identity_required');
  if (!file) await chmod(target, 0o600);
  const publicKey = createPublicKey(key).export({ type: 'spki', format: 'der' }).subarray(-32);
  return { publicKey: publicKey.toString('base64'), fingerprint: sha(publicKey), envelope(payload) {
    const bytes = Buffer.from(JSON.stringify(payload));
    return { payloadBytes: bytes.toString('base64'), publicKey: publicKey.toString('base64'), signature: sign(null, bytes, key).toString('base64') };
  } };
}
export async function boundedFetch(url, maximum, { signal, ...options } = {}) {
  const timeout = AbortSignal.timeout(20000), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  const response = await fetch(url, { ...options, redirect: 'error', signal: combined });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`upstream_status_${response.status}`); }
  if (response.headers.get('content-length') && Number(response.headers.get('content-length')) > maximum) { await response.body?.cancel(); throw new Error('upstream_too_large'); }
  const chunks = []; let count = 0;
  for await (const chunk of response.body) {
    count += chunk.length;
    if (count > maximum) { await response.body.cancel().catch(() => {}); throw new Error('upstream_too_large'); }
    chunks.push(chunk);
  }
  return { response, bytes: Buffer.concat(chunks, count) };
}
export async function hashDownload(url, expectedBytes, expectedHash, signal, headers = {}) {
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.any([signal ?? new AbortController().signal, AbortSignal.timeout(120000)]), headers });
  if (response.status !== 200) { await response.body?.cancel(); throw new Error('audit_download_failed'); }
  const hash = createHash('sha256'); let count = 0;
  for await (const chunk of response.body) {
    count += chunk.length;
    if (count > expectedBytes) throw new Error('audit_size_exceeded');
    hash.update(chunk);
  }
  if (count !== expectedBytes || hash.digest('hex') !== expectedHash) throw new Error('audit_hash_mismatch');
  return count;
}
export function verifyBinding(payload, chainId, registry) {
  const { wallet, publicKey, edSignature, nonce, expiresAt, walletSignature } = payload;
  const key = rawKey(publicKey), fingerprint = sha(key), address = getAddress(wallet);
  if (!Number.isSafeInteger(expiresAt) || expiresAt < now() || expiresAt > now() + 366 * 86400 || !/^\d{1,78}$/.test(String(nonce))) throw new Error('binding_expired_or_invalid');
  const message = `ATS-WALLET-BIND-V1\n${chainId}\n${registry.toLowerCase()}\n${address.toLowerCase()}\n${fingerprint}\n${nonce}\n${expiresAt}`;
  const signature = Buffer.from(edSignature, 'base64');
  if (signature.length !== 64 || !verify(null, Buffer.from(message), edKey(key), signature)) throw new Error('invalid_ed25519_binding_proof');
  const edProofHash = keccak256(signature);
  const recovered = verifyTypedData({ name: 'ATSIdentityRegistry', version: '1', chainId, verifyingContract: registry },
    { Bind: [{ name: 'wallet', type: 'address' }, { name: 'fingerprint', type: 'bytes32' }, { name: 'edProofHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' }, { name: 'expiresAt', type: 'uint64' }] },
    { wallet: address, fingerprint: `0x${fingerprint}`, edProofHash, nonce, expiresAt }, walletSignature);
  if (recovered !== address) throw new Error('invalid_evm_binding_proof');
  return { wallet: address, fingerprint, edProofHash, nonce: String(nonce), expiresAt };
}
