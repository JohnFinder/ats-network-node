import assert from 'node:assert/strict';
import { generateKeyPairSync, createPublicKey, sign, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { JsonRpcProvider, Wallet, Contract, keccak256 } from 'ethers';
import { ChainIndex } from '../src/chain.mjs';
import { sha, verifyEnvelope } from '../src/common.mjs';

const base = process.env.SERVICE_VERIFY_URL ?? 'http://127.0.0.1:8790';
const rpc = process.env.SERVICE_RPC_URL ?? 'http://127.0.0.1:8545';
const development = new URL(base);
if (development.protocol !== 'http:' || !['127.0.0.1', 'localhost', 'services'].includes(development.hostname)) throw new Error('verification_requires_local_service');
async function request(url, payload) {
  const response = await fetch(`${base}${url}`, payload ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) } : {});
  return { status: response.status, value: await response.json() };
}
async function eventually(operation) {
  let last;
  for (let i = 0; i < 100; i++) { try { return await operation(); } catch (error) { last = error; await new Promise(r => setTimeout(r, 100)); } }
  throw last;
}
const net = await eventually(async () => { const result = await request('/v2/network'); assert.equal(result.value.chain.state, 'ready'); return result.value; });
assert.equal(net.chainId, 1337, 'local verification refuses other chains');
const catalog = await request('/v2/catalog');
assert.equal(catalog.status, 200);
assert.equal(verifyEnvelope(catalog.value, new Set([net.serviceID])).payload.type, 'ats-chain-catalog-v1');
assert.equal((await request('/v2/publication-intents', { nodeURL: 'http://169.254.169.254', resourceID: randomUUID() })).status, 400, 'unapproved source must fail before fetch');
assert.equal((await request('/v2/binding-intents', {})).status, 400);
const walletPage = await fetch(`${base}/wallet`);
assert.match(walletPage.headers.get('content-security-policy'), /frame-ancestors 'none'/);
assert.equal((await fetch(`${base}/wallet/ethers.js`)).status, 200);
const operations = await request('/v2/wallet-operations'); assert.equal(operations.status, 200);
assert(operations.value.operations.some(value => value.id === 'storage.stake' && value.inputs[0].name === 'amount'));
assert(operations.value.operations.some(value => value.id === 'tasks.openRetainedTask'));
assert.equal((await request('/v2/wallet-operations/preview', { operation: 'arbitrary.send', args: [] })).status, 400);
const exactApproval = await request('/v2/wallet-operations/preview', { operation: 'approve.storage', args: ['123'] });
assert.equal(exactApproval.status, 200); assert.equal(exactApproval.value.args[0], net.contracts.storage.address); assert.equal(exactApproval.value.args[1], '123');
assert.equal((await fetch(`${base}/wallet/manage`)).status, 200);

const crossOrigin = await fetch(`${base}/v2/binding-intents`, { method: 'POST', headers: { Origin: 'https://attacker.invalid', 'Content-Type': 'application/json' }, body: '{}' });
assert.equal(crossOrigin.status, 400);

if (process.argv.includes('--binding')) {
  const rawKey = process.env.SERVICE_VERIFY_PRIVATE_KEY_FILE ? (await readFile(process.env.SERVICE_VERIFY_PRIVATE_KEY_FILE, 'utf8')).trim() : process.env.SERVICE_VERIFY_PRIVATE_KEY;
  if (!rawKey) throw new Error('explicit_local_funded_signer_key_required');
  const provider = new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
  assert.equal((await provider.getNetwork()).chainId, 1337n);
  const wallet = new Wallet(rawKey, provider), pair = generateKeyPairSync('ed25519'), raw = createPublicKey(pair.privateKey).export({ type: 'spki', format: 'der' }).subarray(-32), fingerprint = sha(raw);
  const nonceResult = await request(`/v2/binding-nonce?wallet=${wallet.address}`), nonce = nonceResult.value.nonce;
  const expiresAt = Math.max(Math.floor(Date.now() / 1000), Number((await provider.getBlock('latest')).timestamp)) + 3600, registry = net.contracts.identity.address;
  const statement = `ATS-WALLET-BIND-V1\n1337\n${registry.toLowerCase()}\n${wallet.address.toLowerCase()}\n${fingerprint}\n${nonce}\n${expiresAt}`;
  const signature = sign(null, Buffer.from(statement), pair.privateKey).toString('base64');
  const input = { walletAddress: wallet.address, publicKey: raw.toString('base64'), nonce, expiresAt, chainId: 1337, registry, statement, signature };
  assert.equal((await request('/v2/binding-intents', { ...input, statement: `${statement}\n` })).status, 400);
  const created = await request('/v2/binding-intents', input); assert.equal(created.status, 201);
  const plan = (await request(`/v2/binding-intents/${created.value.intentID}`)).value;
  const walletSignature = await wallet.signTypedData(plan.domain, plan.types, plan.message);
  const contract = new Contract(registry, plan.abi, wallet), m = plan.message;
  await (await contract.bindFor(m.wallet, m.fingerprint, m.edProofHash, m.nonce, m.expiresAt, walletSignature)).wait();
  // Mine confirmation blocks explicitly on this development-only chain.
  for (let i = 0; i < net.confirmations; i++) await provider.send('evm_mine', []);
  const completed = await eventually(async () => {
    const result = await request(`/v2/binding-intents/${created.value.intentID}/complete`, { walletSignature });
    assert.equal(result.status, 200); return result.value;
  });
  assert.equal(completed.edProofVerified, true);
  assert.equal((await request(`/v2/identity/${fingerprint}`)).value.wallet, wallet.address);
  assert.equal((await request(`/v2/account/${fingerprint}`)).status, 200);
  await provider.destroy();
}
if (process.argv.includes('--reorg')) {
  // Reorg exercise requires a dedicated disposable local chain; it rewinds only blocks
  // created inside its snapshot and uses a separate index database.
  if (!process.env.SERVICE_DEPLOYMENT_MANIFEST) throw new Error('manifest_required');
  const provider = new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
  assert.equal((await provider.getNetwork()).chainId, 1337n);
  const dir = await mkdtemp(path.join(os.tmpdir(), 'ats-index-reorg-'));
  let db = new DatabaseSync(path.join(dir, 'index.sqlite'));
  let index = await ChainIndex.connect(db, { rpc, chainId: 1337, manifestFile: process.env.SERVICE_DEPLOYMENT_MANIFEST, confirmations: 0 });
  await index.tick();
  const initial = index.status.indexedHeight, snapshot = await provider.send('evm_snapshot', []);
  await provider.send('evm_mine', []); await provider.send('evm_mine', []);
  await index.tick(); assert.equal(index.status.indexedHeight, initial + 2);
  db.exec("CREATE TABLE observations(marker TEXT); INSERT INTO observations VALUES('old-order-branch'); INSERT INTO service_state VALUES('audit-schedule:1:0','old-schedule');");
  const priorHash = db.prepare('SELECT hash FROM blocks WHERE height=?').get(initial + 1).hash;
  assert.equal(await provider.send('evm_revert', [snapshot]), true);
  await provider.send('evm_increaseTime', [3]); await provider.send('evm_mine', []);
  await index.tick(); assert.equal(index.status.rollbackBlocks, 2); assert.equal(index.status.indexedHeight, initial + 1);
  assert.notEqual(db.prepare('SELECT hash FROM blocks WHERE height=?').get(initial + 1).hash, priorHash);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 0);
  assert.equal(db.prepare("SELECT value FROM service_state WHERE key='audit-schedule:1:0'").get(), undefined);
  const events = db.prepare('SELECT COUNT(*) AS n FROM chain_events').get().n;
  await index.provider.destroy(); db.close(); db = new DatabaseSync(path.join(dir, 'index.sqlite'));
  index = await ChainIndex.connect(db, { rpc, chainId: 1337, manifestFile: process.env.SERVICE_DEPLOYMENT_MANIFEST, confirmations: 0 });
  await index.tick(); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chain_events').get().n, events);
  db.exec("INSERT INTO observations VALUES('old-order-branch'); INSERT INTO service_state VALUES('audit-schedule:1:0','old-schedule');");
  index.rewind(); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 0); assert.equal(db.prepare("SELECT value FROM service_state WHERE key='audit-schedule:1:0'").get(), undefined); await index.tick(); assert.equal(db.prepare('SELECT COUNT(*) AS n FROM chain_events').get().n, events);
  await index.provider.destroy(); db.close(); await provider.destroy(); await rm(dir, { recursive: true, force: true });
}
console.log(JSON.stringify({ status: 'passed', serviceID: net.serviceID, checks: ['confirmed-network', 'signed-catalog', 'pinned-source-ssrf-rejection', 'binding-malformation', 'wallet-csp', 'same-origin-mutations', 'allowlisted-wallet-operations', 'exact-spender-approval', ...(process.argv.includes('--binding') ? ['dual-signature-wallet-binding', 'confirmed-proof-lookup'] : []), ...(process.argv.includes('--reorg') ? ['blockhash-reorg-rollback', 'reorg-rebuild-clears-observations', 'restart-idempotency', 'rebuild-from-deployment'] : [])] }));
