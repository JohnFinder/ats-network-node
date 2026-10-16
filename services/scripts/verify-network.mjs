import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { generateKeyPairSync, createPublicKey, createPrivateKey, randomUUID, sign } from 'node:crypto';
import { JsonRpcProvider, Wallet, Contract, MaxUint256, parseEther, ZeroHash } from 'ethers';
import { sha, verifyEnvelope, now } from '../src/common.mjs';

const rpc = process.env.SERVICE_RPC_URL ?? 'http://chain:8545', base = 'http://services:8790', node = 'http://node:8787';
const provider = new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1, pollingInterval: 50 });
assert.equal((await provider.getNetwork()).chainId, 1337n);
const manifest = JSON.parse(await readFile('/deployment/deployment.v2.1337.json'));
const wallets = await Promise.all([0,1,2,3,4,5].map(async i => new Wallet((await readFile(`/secrets/dev-${i}.key`, 'utf8')).trim(), provider)));
const abi = name => manifest.contracts[name].abi;
const token = new Contract(manifest.token, abi('ATNTestToken'), wallets[0]);
const market = new Contract(manifest.storage, abi('ATSStorageMarket'), wallets[0]);
const registry = new Contract(manifest.registry, abi('ATSPublicationRegistry'), wallets[2]);
async function request(url, payload, headers = {}) {
  const response = await fetch(url, { ...(payload === undefined ? {} : { method: 'POST', body: JSON.stringify(payload) }), headers: { 'Content-Type': 'application/json', ...headers } });
  const value = await response.json(); return { response, value };
}
async function expect(url, payload, status = 200, headers) { const r = await request(url, payload, headers); assert.equal(r.response.status, status, JSON.stringify(r.value)); return r.value; }
async function eventually(check, ms = 30000) { const end = Date.now() + ms; let error; while (Date.now() < end) { try { return await check(); } catch (e) { error = e; await new Promise(r => setTimeout(r, 200)); } } throw error; }
async function indexReady() { await eventually(async () => { const n = await expect(`${base}/v2/network`); assert.equal(n.chain.state, 'ready'); assert.equal(n.chain.indexedHeight, await provider.getBlockNumber()); }); }
async function mine(seconds = 1) { await provider.send('evm_increaseTime', [seconds]); await provider.send('evm_mine', []); await indexReady(); }
const publisherPair = generateKeyPairSync('ed25519'), providerKey = createPrivateKey({ key: await readFile('/provider/provider-key.der'), format: 'der', type: 'pkcs8' });
const edRaw = key => createPublicKey(key).export({ format: 'der', type: 'spki' }).subarray(-32);
const providerID = sha(edRaw(providerKey)), publisherID = sha(edRaw(publisherPair.privateKey));
async function bind(wallet, key) {
  const keyBytes = edRaw(key), fingerprint = sha(keyBytes), nonce = (await expect(`${base}/v2/binding-nonce?wallet=${wallet.address}`)).nonce;
  const expiresAt = Math.max(now(), Number((await provider.getBlock('latest')).timestamp)) + 90 * 86400;
  const statement = `ATS-WALLET-BIND-V1\n1337\n${manifest.identity.toLowerCase()}\n${wallet.address.toLowerCase()}\n${fingerprint}\n${nonce}\n${expiresAt}`;
  const input = { walletAddress: wallet.address, publicKey: keyBytes.toString('base64'), nonce, expiresAt, chainId: 1337, registry: manifest.identity, statement, signature: sign(null, Buffer.from(statement), key).toString('base64') };
  const made = await expect(`${base}/v2/binding-intents`, input, 201), plan = await expect(`${base}/v2/binding-intents/${made.intentID}`), signature = await wallet.signTypedData(plan.domain, plan.types, plan.message), m = plan.message;
  const contract = new Contract(manifest.identity, plan.abi, wallet);
  await (await contract.bindFor(m.wallet, m.fingerprint, m.edProofHash, m.nonce, m.expiresAt, signature)).wait(); await indexReady();
  const complete = await expect(`${base}/v2/binding-intents/${made.intentID}/complete`, { walletSignature: signature }); assert.equal(complete.edProofVerified, true);
}
await indexReady(); await bind(wallets[1], providerKey); await bind(wallets[2], publisherPair.privateKey);
function auth(method, pathname, bytes) { const timestamp = String(now()), nonce = randomUUID(), audience = node; const message = `ATS-NODE-V1\n${audience}\n${method}\n${pathname}\n${timestamp}\n${nonce}\n${sha(bytes)}`; return { 'x-ats-audience': audience, 'x-ats-public-key': edRaw(publisherPair.privateKey).toString('base64'), 'x-ats-timestamp': timestamp, 'x-ats-nonce': nonce, 'x-ats-signature': sign(null, Buffer.from(message), publisherPair.privateKey).toString('base64') }; }
const data = Buffer.concat([Buffer.from('ATSBOOK1'), Buffer.alloc(100000, 7)]), archiveHash = sha(data);
const metadata = { title: '  Service verification book  ', summary: '  Signed upload canonicalization fixture  ', tags: ['sample', 'sample'], encrypted: false, visibility: 'public', sha256: archiveHash, byteCount: data.length };
let bytes = Buffer.from(JSON.stringify(metadata));
const upload = await expect(`${node}/v1/uploads`, metadata, 201, auth('POST', '/v1/uploads', bytes));
const partPath = `/v1/uploads/${upload.id}/parts/0`;
const put = await fetch(`${node}${partPath}`, { method: 'PUT', headers: { ...auth('PUT', partPath, data), 'Content-Type': 'application/octet-stream', 'x-content-sha256': archiveHash }, body: data }); assert.equal(put.status, 200, await put.text());
const completePath = `/v1/uploads/${upload.id}/complete`; bytes = Buffer.from('{}');
await expect(`${node}${completePath}`, {}, 200, auth('POST', completePath, bytes));
const made = await expect(`${base}/v2/publication-intents`, { nodeURL: node, resourceID: upload.id }, 201), plan = await expect(`${base}/v2/binding-intents/${made.intentID}`), signature = await wallets[2].signTypedData(plan.domain, plan.types, plan.message), m = plan.message;
await (await registry.publishFor(m.wallet, m.archiveHash, m.metadataHash, m.previous, plan.recipients, plan.bps, m.nonce, m.expiresAt, signature)).wait(); await indexReady();
const publicationId = await registry.publicationID(wallets[2].address, m.archiveHash);
await expect(`${base}/v2/binding-intents/${made.intentID}/complete`, { walletSignature: signature });
const network = await expect(`${base}/v2/network`), published = verifyEnvelope(await expect(`${base}/v2/catalog?q=Service`), new Set([network.serviceID])).payload;
assert.equal(published.items.length, 1); assert.equal(published.items[0].title, 'Service verification book');
await (await token.transfer(wallets[1].address, parseEther('100'))).wait();
await (await token.connect(wallets[1]).approve(manifest.storage, MaxUint256)).wait(); await (await market.connect(wallets[1]).stake(parseEther('20'))).wait();
await (await token.approve(manifest.storage, MaxUint256)).wait();
const quoteTypes = { Quote: [{name:'requester',type:'address'},{name:'provider',type:'address'},{name:'publicationId',type:'bytes32'},{name:'archiveHash',type:'bytes32'},{name:'start',type:'uint64'},{name:'end',type:'uint64'},{name:'period',type:'uint64'},{name:'amount',type:'uint256'},{name:'salt',type:'bytes32'},{name:'expiresAt',type:'uint64'}] };
const start = Number((await provider.getBlock('latest')).timestamp) + 30;
const quote = { requester: wallets[0].address, provider: wallets[1].address, publicationId, archiveHash: m.archiveHash, start, end: start + 180, period: 60, amount: parseEther('3'), salt: `0x${sha(randomUUID())}`, expiresAt: start };
const qsig = await wallets[1].signTypedData({name:'ATSStorageMarket',version:'1',chainId:1337,verifyingContract:manifest.storage},quoteTypes,quote);
await (await market.openOrder(quote, qsig)).wait(); const orderID = (await market.nextOrder()) - 1n; await indexReady();
const lease = await expect(`${base}/v2/orders/${orderID}/lease`), leasePayload = verifyEnvelope(lease, new Set([network.serviceID])).payload;
assert.equal(leasePayload.sha256, archiveHash); assert.equal(leasePayload.providerID, providerID); assert.equal(leasePayload.retainUntil, quote.end);
// A separate >1h funded lease exercises actual node acceptance, including
// an exact idempotent receipt re-read. Short period fixtures alone are not leases.
const leaseStart = Number((await provider.getBlock('latest')).timestamp) + 30;
const leaseQuote = { ...quote, start: leaseStart, end: leaseStart + 7200, period: 3600, amount: parseEther('2'), salt: `0x${sha(randomUUID())}`, expiresAt: leaseStart };
const leaseSignature = await wallets[1].signTypedData({name:'ATSStorageMarket',version:'1',chainId:1337,verifyingContract:manifest.storage},quoteTypes,leaseQuote);
await (await market.openOrder(leaseQuote, leaseSignature)).wait(); const leaseOrderID = (await market.nextOrder()) - 1n; await indexReady();
const fundedReceipt = await expect(`${base}/v2/orders/${leaseOrderID}/lease`);
assert.deepEqual(await expect(`${base}/v2/orders/${leaseOrderID}/lease`), fundedReceipt);
const requestQuote = { resourceID: upload.id, retainUntil: leaseQuote.end }, quotePath = '/v1/retention/quotes';
const nodeQuoteEnvelope = await expect(`${node}${quotePath}`, requestQuote, 201, auth('POST', quotePath, Buffer.from(JSON.stringify(requestQuote))));
const nodeQuote = verifyEnvelope(nodeQuoteEnvelope, new Set([providerID])).payload;
const acceptPath = '/v1/retention/orders', acceptBody = { quoteID: nodeQuote.quoteID, settlementReceipt: fundedReceipt };
assert.equal((await expect(`${node}${acceptPath}`, acceptBody, 201, auth('POST',acceptPath,Buffer.from(JSON.stringify(acceptBody))))).status,'active');
assert.equal((await expect(`${node}${acceptPath}`, acceptBody, 200, auth('POST',acceptPath,Buffer.from(JSON.stringify(acceptBody))))).status,'active');
console.log(JSON.stringify({ stage: 'ready_for_observers', orderID: orderID.toString(), start, end: quote.end, resourceID: upload.id, providerID, publicationId, serviceID: network.serviceID }));
// Wait for the host to start distinct observer processes after this fixture exists.
await eventually(async () => { const a = await expect('http://observer-1:8790/v2/network'); const b = await expect('http://observer-2:8790/v2/network'); assert.equal(a.observer.state, 'ready'); assert.equal(b.observer.state, 'ready'); }, 60000);
async function tickAt(timestamp) {
  const delta = timestamp - Number((await provider.getBlock('latest')).timestamp);
  if (delta > 0) await mine(delta); else await mine(0);
  await new Promise(r => setTimeout(r, 2500));
}
// Frequent chain-clock steps hit each persisted random audit window rather than
// pretending an audit happened during a period that was skipped.
for (let time = start; time <= start + 60; time += 4) await tickAt(time);
await eventually(async () => { const pending = await market.pending(orderID); assert.notEqual(pending.candidate, ZeroHash); });
const firstPending = await market.pending(orderID);
assert.equal(firstPending.successful, 3n); assert.equal(firstPending.samples, 3n);
// Challenge is an explicit requester action and blocks the independent coordinator.
await (await market.challengePeriod(orderID, `0x${sha('fixture-challenge')}`)).wait();
await tickAt(Number(firstPending.readyAt) + 1);
assert.equal((await market.orders(orderID)).settledPeriods, 0n);
await (await market.resolveChallenge(orderID, true, `0x${sha('fixture-resolution')}`)).wait();
const reReviewed = await market.pending(orderID); await tickAt(Number(reReviewed.readyAt) + 1);
await eventually(async () => assert.equal((await market.orders(orderID)).settledPeriods, 1n));
const firstPaid = await market.queryFilter(market.filters.PeriodSettled(orderID, 0)); assert.equal(firstPaid[0].args.paid, parseEther('1'));
// Periods skipped while reviewing are recorded as missed observations: a real
// restart/late-node failure must not be backfilled as successful service.
await tickAt(quote.end + 1);
await eventually(async () => { const p = await market.pending(orderID); assert.notEqual(p.candidate, ZeroHash); assert.equal(p.successful, 0n); });
const failedPending = await market.pending(orderID); await tickAt(Number(failedPending.readyAt) + 1);
await eventually(async () => assert.equal((await market.orders(orderID)).settledPeriods, 2n));
const failedPaid = await market.queryFilter(market.filters.PeriodSettled(orderID, 1)); assert.equal(failedPaid[0].args.paid, 0n); assert.equal(failedPaid[0].args.refunded, parseEther('1'));
const obs = await expect(`http://observer-1:8790/v2/observations?orderID=${orderID}`); assert.ok(obs.items.length >= 6);
assert.equal(verifyEnvelope(obs.items[0], new Set([(await expect('http://observer-1:8790/v2/network')).serviceID])).payload.success, false);
console.log(JSON.stringify({ status:'passed', checks:['dual-wallet-provider-binding','signed-canonical-metadata','fullhash-publication-index','funded-active-retention-receipt','node-accepted-funded-lease','idempotent-receipt-retry','independent-observers','timely-fullhash-samples','threshold-report','challenge-blocks-settlement','resolution-restarts-review','coordinator-period-payout','missed-window-failure-refund','signed-observation-evidence'], orderID:orderID.toString(), publicationId }));
await provider.destroy();
