import http from 'node:http';
import path from 'node:path';
import { mkdir, readFile, chmod } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { randomUUID, verify } from 'node:crypto';
import { getAddress, ZeroAddress, ZeroHash, AbiCoder, keccak256, verifyTypedData } from 'ethers';
import { ChainIndex } from './chain.mjs';
import { Catalog } from './catalog.mjs';
import { Observer } from './observer.mjs';
import { Settlement } from './settlement.mjs';
import { walletOperations, previewOperation } from './operations.mjs';
import { integer, now, sha, rawKey, edKey, origin, signingIdentity, verifyBinding, boundedFetch, verifyEnvelope } from './common.mjs';

const config = {
  dataDir: path.resolve(process.env.SERVICE_DATA_DIR ?? './data'),
  rpc: process.env.SERVICE_RPC_URL,
  chainId: integer(process.env.SERVICE_CHAIN_ID, 1337),
  manifestFile: process.env.SERVICE_DEPLOYMENT_MANIFEST,
  confirmations: integer(process.env.SERVICE_CONFIRMATIONS, 12, 1024, 0),
  port: integer(process.env.SERVICE_PORT, 8790, 65535),
  pollMs: integer(process.env.SERVICE_POLL_MS, 5000, 300000, 100),
  maximumAuditBytes: integer(process.env.SERVICE_MAX_AUDIT_BYTES, 1024 ** 3, 128 * 1024 ** 3),
  catalogCheckSeconds: integer(process.env.SERVICE_CATALOG_CHECK_SECONDS, 3600, 86400, 60),
  observerKeyFile: process.env.SERVICE_OBSERVER_KEY_FILE,
  observerPrivateKey: process.env.SERVICE_OBSERVER_PRIVATE_KEY,
  settlementKeyFile: process.env.SERVICE_SETTLEMENT_KEY_FILE,
  auditSamples: integer(process.env.SERVICE_AUDIT_SAMPLES, 3, 20),
  maxObserverWork: integer(process.env.SERVICE_OBSERVER_WORK, 2, 16),
  transactionConfirmations: integer(process.env.SERVICE_TRANSACTION_CONFIRMATIONS, 1, 64),
  settle: process.env.SERVICE_SETTLE === 'true',
  development: process.env.SERVICE_ALLOW_HTTP === 'true'
};
if (!config.development && config.observerPrivateKey) throw new Error('production_observer_requires_secret_file');
const publicURL = origin(process.env.SERVICE_PUBLIC_URL ?? `http://127.0.0.1:${config.port}`, config.development);
config.indexers = JSON.parse(process.env.SERVICE_APPROVED_INDEXERS ?? '[]').map(peer => {
  if (!/^[0-9a-f]{64}$/.test(peer.serviceID)) throw new Error('invalid_indexer_pin');
  return { url: origin(peer.url, config.development), serviceID: peer.serviceID };
});
if (config.indexers.length > 16) throw new Error('too_many_indexers');
const nodes = JSON.parse(process.env.SERVICE_APPROVED_NODES ?? '[]').map(node => {
  if (!/^[0-9a-f]{64}$/.test(node.providerID)) throw new Error('node_public_key_fingerprint_required');
  return { url: origin(node.url, config.development), providerID: node.providerID };
});
if (nodes.length > 32 || new Set(nodes.map(n => n.url)).size !== nodes.length) throw new Error('too_many_or_duplicate_nodes');
await mkdir(config.dataDir, { recursive: true, mode: 0o700 });
const db = new DatabaseSync(path.join(config.dataDir, 'services.sqlite'));
db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS intents(id TEXT PRIMARY KEY,type TEXT NOT NULL,payload TEXT NOT NULL,expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS binding_proofs(wallet TEXT PRIMARY KEY,payload TEXT NOT NULL,proofHash TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS leases(domain TEXT PRIMARY KEY,nonce INTEGER NOT NULL,id TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS lease_receipts(domain TEXT PRIMARY KEY,payload TEXT NOT NULL,issued INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS verified_bindings(fingerprint TEXT NOT NULL,wallet TEXT NOT NULL,PRIMARY KEY(fingerprint,wallet));`);
await chmod(path.join(config.dataDir, 'services.sqlite'), 0o600);
const identity = await signingIdentity(process.env.SERVICE_SIGNING_KEY_FILE, config.dataDir);
const chain = await ChainIndex.connect(db, config);
if (process.argv.includes('--rebuild')) chain.rewind();
const catalog = new Catalog(db, chain, identity, nodes, config);
const observer = await Observer.create(db, chain, catalog, identity, config);
const settlement = await Settlement.create(chain, config);
const json = (res, status, value) => {
  const bytes = Buffer.from(JSON.stringify(value, (_, value) => typeof value === 'bigint' ? value.toString() : value));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(bytes);
};
async function body(req, max = 32768) {
  let size = 0; const chunks = [];
  for await (const chunk of req) { size += chunk.length; if (size > max) throw new Error('body_too_large'); chunks.push(chunk); }
  const value = JSON.parse(Buffer.concat(chunks));
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_body');
  return value;
}
const requireReady = () => { if (chain.status.state !== 'ready') throw new Error('chain_unavailable'); };
async function bindingFor(fingerprint, expectedWallet = null) {
  if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new Error('invalid_fingerprint');
  const preferred = db.prepare('SELECT value FROM service_state WHERE key=?').get(`verified-wallet:${fingerprint}`)?.value;
  const verifiedWallets = db.prepare('SELECT wallet FROM verified_bindings WHERE fingerprint=?').all(fingerprint).map(row => row.wallet);
  const candidates = [...new Set([...(preferred ? [preferred] : []), ...verifiedWallets, ...chain.events('Bound').filter(e => e.contract === 'identity' && e.args.fingerprint === `0x${fingerprint}`).reverse().map(e => e.args.wallet)])];
  for (const wallet of candidates.filter(wallet => !expectedWallet || wallet.toLowerCase() === expectedWallet.toLowerCase()).slice(0, 128)) {
  const binding = await chain.confirmedCall('identity', 'bindings', wallet);
  let proof = db.prepare('SELECT * FROM binding_proofs WHERE wallet=?').get(wallet.toLowerCase());
  if (!proof || proof.proofHash !== binding.edProofHash) {
    for (const peer of config.indexers) {
      try {
        const { bytes } = await boundedFetch(`${peer.url}/v2/binding-proofs/${wallet}`, 32768);
        const remote = verifyEnvelope(JSON.parse(bytes), new Set([peer.serviceID])).payload;
        if (remote.type !== 'ats-wallet-binding-proof-v1' || remote.wallet.toLowerCase() !== wallet.toLowerCase()) throw new Error('invalid_remote_binding');
        const checked = verifyBinding(remote.proof, config.chainId, chain.contracts.identity.address);
        if (checked.fingerprint !== fingerprint || checked.edProofHash !== binding.edProofHash || checked.expiresAt !== Number(binding.expiresAt)) throw new Error('binding_chain_mismatch');
        db.prepare('INSERT OR REPLACE INTO binding_proofs VALUES(?,?,?)').run(wallet.toLowerCase(), JSON.stringify(remote.proof), checked.edProofHash);
        db.prepare('INSERT OR IGNORE INTO verified_bindings VALUES(?,?)').run(fingerprint, wallet);
        proof = { proofHash: checked.edProofHash }; break;
      } catch { /* Ignore unavailable pinned proof issuers; no false verified badge. */ }
    }
  }
  const active = await chain.confirmedCall('identity', 'isActive', wallet);
  if (active && proof && proof.proofHash === binding.edProofHash && binding.fingerprint === `0x${fingerprint}`) return { fingerprint, wallet, active, expiresAt: Number(binding.expiresAt), edProofVerified: true };
  }
  return { fingerprint, wallet: null, active: false, edProofVerified: false };
}
function network() {
  return { schemaVersion: 2, chainId: config.chainId, servicesURL: publicURL, servicePublicKey: identity.publicKey, serviceID: identity.fingerprint, confirmations: config.confirmations, contracts: Object.fromEntries(Object.entries(chain.contracts).map(([key, value]) => [key, { address: value.address, codeHash: value.codeHash }])), nodes, chain: chain.status, observer: observer?.status ?? { state: 'disabled' }, settlement: settlement?.status ?? { state: 'disabled' }, accountingMode: 'prepaid-trusted-observer-committee', proofMode: 'retrieval-observation-not-replica-proof' };
}
catalog.bindingVerifier = bindingFor;
const bindTypes = { Bind: [{ name: 'wallet', type: 'address' }, { name: 'fingerprint', type: 'bytes32' }, { name: 'edProofHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' }, { name: 'expiresAt', type: 'uint64' }] };
const publishTypes = { Publish: [{ name: 'wallet', type: 'address' }, { name: 'archiveHash', type: 'bytes32' }, { name: 'metadataHash', type: 'bytes32' }, { name: 'previous', type: 'bytes32' }, { name: 'royaltiesHash', type: 'bytes32' }, { name: 'nonce', type: 'uint256' }, { name: 'expiresAt', type: 'uint64' }] };
function intent(id) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('invalid_intent');
  const row = db.prepare('SELECT * FROM intents WHERE id=? AND expires>?').get(id, now());
  if (!row) throw new Error('intent_expired');
  return { ...row, payload: JSON.parse(row.payload) };
}
async function route(req, res) {
  if (req.url.length > 4096) throw new Error('request_too_long');
  const url = new URL(req.url, publicURL);
  if (req.headers.origin && req.headers.origin !== publicURL) throw new Error('cross_origin_request_denied');
  if (req.method === 'GET' && url.pathname === '/health') return json(res, chain.status.state === 'ready' ? 200 : 503, network());
  if (req.method === 'GET' && url.pathname === '/v2/network') return json(res, 200, network());
  if (req.method === 'GET' && /^\/v2\/binding-proofs\/0x[0-9a-fA-F]{40}$/.test(url.pathname)) {
    const wallet = getAddress(url.pathname.split('/').at(-1)), row = db.prepare('SELECT * FROM binding_proofs WHERE wallet=?').get(wallet.toLowerCase());
    if (!row) throw new Error('binding_proof_not_found');
    const stored = JSON.parse(row.payload);
    const proof = stored.wallet ? stored : { wallet: stored.walletAddress, publicKey: stored.publicKey, edSignature: stored.signature, nonce: stored.nonce, expiresAt: stored.expiresAt, walletSignature: stored.walletSignature };
    return json(res, 200, identity.envelope({ schemaVersion: 1, type: 'ats-wallet-binding-proof-v1', wallet, proof }));
  }
  if (req.method === 'GET' && /^\/v2\/metadata\/[0-9a-f]{64}$/.test(url.pathname)) {
    const hash = url.pathname.split('/').at(-1), row = db.prepare('SELECT bytes FROM metadata WHERE hash=?').get(hash);
    if (!row || !chain.events('Published').some(e => e.contract === 'publication' && e.args.metadataHash === `0x${hash}`)) throw new Error('confirmed_metadata_not_found');
    return json(res, 200, identity.envelope({ schemaVersion: 1, type: 'ats-publication-metadata-v1', metadataHash: hash, metadataBytes: row.bytes }));
  }
  if (req.method === 'GET' && url.pathname === '/v2/catalog') {
    const query = (url.searchParams.get('q') ?? '').slice(0, 200), cursor = integer(url.searchParams.get('cursor'), 0, 100000, 0), limit = integer(url.searchParams.get('limit'), 50, 100);
    return json(res, 200, identity.envelope(await catalog.list(query, cursor, limit)));
  }
  if (req.method === 'GET' && /^\/v2\/(identity|account)\/[0-9a-f]{64}$/.test(url.pathname)) {
    requireReady(); const fingerprint = url.pathname.split('/').at(-1), binding = await bindingFor(fingerprint);
    if (url.pathname.includes('/identity/')) return json(res, 200, binding);
    const publications = chain.events('Published').filter(e => e.contract === 'publication' && e.args.fingerprint === `0x${fingerprint}`).map(e => e.args);
    const orders = chain.events('OrderOpened').filter(e => binding.wallet && [e.args.provider, e.args.requester].includes(binding.wallet));
    return json(res, 200, { ...binding, publications, orders: await Promise.all(orders.slice(-100).map(async e => ({ id: e.args.orderId, ...(await chain.confirmedCall('storage', 'orders', e.args.orderId)).toObject() }))), rewards: chain.events('PeriodSettled').filter(e => orders.some(order => order.args.orderId === e.args.orderId)).map(e => e.args), observedAtBlock: chain.status.indexedHeight });
  }
  if (req.method === 'GET' && url.pathname === '/v2/binding-nonce') {
    const wallet = getAddress(url.searchParams.get('wallet'));
    return json(res, 200, { wallet, nonce: (await chain.confirmedCall('identity', 'nonces', wallet)).toString(), chainId: config.chainId, registry: chain.contracts.identity.address });
  }
  if (req.method === 'POST' && url.pathname === '/v2/binding-intents') {
    requireReady(); if (db.prepare('SELECT COUNT(*) AS n FROM intents WHERE expires>unixepoch()').get().n >= 10000) throw new Error('intent_capacity_limit'); const input = await body(req), wallet = getAddress(input.walletAddress), key = rawKey(input.publicKey), fingerprint = sha(key);
    if (input.chainId !== config.chainId || input.registry.toLowerCase() !== chain.contracts.identity.address.toLowerCase() || !Number.isSafeInteger(input.expiresAt) || input.expiresAt < now() + 60 || input.expiresAt > now() + 366 * 86400) throw new Error('invalid_binding_scope');
    const nonce = (await chain.confirmedCall('identity', 'nonces', wallet)).toString();
    if (String(input.nonce) !== nonce) throw new Error('binding_nonce_changed');
    const statement = `ATS-WALLET-BIND-V1\n${config.chainId}\n${chain.contracts.identity.address.toLowerCase()}\n${wallet.toLowerCase()}\n${fingerprint}\n${nonce}\n${input.expiresAt}`;
    const proof = Buffer.from(input.signature, 'base64');
    if (input.statement !== statement || proof.length !== 64 || !verify(null, Buffer.from(statement), edKey(key), proof)) throw new Error('invalid_ed25519_binding_proof');
    const id = randomUUID(), domain = { name: 'ATSIdentityRegistry', version: '1', chainId: config.chainId, verifyingContract: chain.contracts.identity.address };
    const message = { wallet, fingerprint: `0x${fingerprint}`, edProofHash: keccak256(proof), nonce, expiresAt: input.expiresAt };
    const payload = { input, wallet, fingerprint, domain, types: bindTypes, primaryType: 'Bind', message, contract: domain.verifyingContract };
    const intentExpiresAt = now() + 600;
    db.prepare('INSERT INTO intents VALUES(?,?,?,?)').run(id, 'binding', JSON.stringify(payload), intentExpiresAt);
    return json(res, 201, { intentID: id, expiresAt: intentExpiresAt, bindingExpiresAt: input.expiresAt, statement, walletURL: `${publicURL}/wallet?intent=${id}` });
  }
  const intentPath = /^\/v2\/binding-intents\/([0-9a-f-]{36})(\/complete)?$/.exec(url.pathname);
  if (intentPath) {
    const row = intent(intentPath[1]), p = row.payload;
    if (req.method === 'GET' && !intentPath[2]) return json(res, 200, { ...p, intentID: row.id, type: row.type, expiresAt: row.expires, abi: chain.contracts[row.type === 'binding' ? 'identity' : 'publication'].abi });
    if (req.method === 'POST' && intentPath[2]) {
      requireReady(); const input = await body(req);
      const recovered = verifyTypedData(p.domain, p.types, p.message, input.walletSignature);
      if (recovered !== p.wallet) throw new Error('invalid_wallet_signature');
      if (row.type === 'binding') {
        verifyBinding({ wallet: p.wallet, publicKey: p.input.publicKey, edSignature: p.input.signature, nonce: p.message.nonce, expiresAt: p.message.expiresAt, walletSignature: input.walletSignature }, config.chainId, chain.contracts.identity.address);
        const binding = await chain.confirmedCall('identity', 'bindings', p.wallet);
        if (binding.edProofHash !== p.message.edProofHash || binding.fingerprint !== p.message.fingerprint || Number(binding.expiresAt) !== p.message.expiresAt) throw new Error('waiting_for_confirmed_transaction');
        db.prepare('INSERT OR REPLACE INTO binding_proofs VALUES(?,?,?)').run(p.wallet.toLowerCase(), JSON.stringify({ ...p.input, walletSignature: input.walletSignature }), p.message.edProofHash);
        db.prepare('INSERT OR REPLACE INTO service_state VALUES(?,?)').run(`verified-wallet:${p.fingerprint}`, p.wallet);
        db.prepare('INSERT OR IGNORE INTO verified_bindings VALUES(?,?)').run(p.fingerprint, p.wallet);
        return json(res, 200, { status: 'confirmed', ...await bindingFor(p.fingerprint) });
      }
      const id = await chain.confirmedCall('publication', 'publicationID', p.wallet, p.message.archiveHash);
      const publication = await chain.confirmedCall('publication', 'publications', id);
      if (publication.metadataHash !== p.message.metadataHash) throw new Error('waiting_for_confirmed_transaction');
      return json(res, 200, { status: 'confirmed', publicationID: id });
    }
  }
  if (req.method === 'POST' && url.pathname === '/v2/publication-intents') {
    requireReady(); if (db.prepare('SELECT COUNT(*) AS n FROM intents WHERE expires>unixepoch()').get().n >= 10000) throw new Error('intent_capacity_limit'); const input = await body(req);
    const { metadata } = await catalog.source(input.nodeURL, input.resourceID), binding = await bindingFor(metadata.publisherID);
    if (!binding.active || !binding.edProofVerified) throw new Error('verified_wallet_binding_required');
    const wallet = binding.wallet;
    const nonce = (await chain.confirmedCall('publication', 'nonces', wallet)).toString(), expiresAt = now() + 1800;
    const priorIntent = db.prepare("SELECT id,expires FROM intents WHERE type='publication' AND expires>? AND json_extract(payload,'$.wallet')=? AND json_extract(payload,'$.message.archiveHash')=? AND json_extract(payload,'$.message.nonce')=? LIMIT 1").get(now() + 60, wallet, `0x${metadata.sha256}`, nonce);
    if (priorIntent) return json(res, 201, { intentID: priorIntent.id, expiresAt: priorIntent.expires, walletURL: `${publicURL}/wallet?intent=${priorIntent.id}` });
    await catalog.check(metadata); const saved = catalog.save(metadata);
    const recipients = [wallet], bps = [10000], royaltiesHash = keccak256(AbiCoder.defaultAbiCoder().encode(['address[]', 'uint16[]'], [recipients, bps]));
    const domain = { name: 'ATSPublicationRegistry', version: '1', chainId: config.chainId, verifyingContract: chain.contracts.publication.address };
    const message = { wallet, archiveHash: `0x${metadata.sha256}`, metadataHash: saved.hash, previous: ZeroHash, royaltiesHash, nonce, expiresAt };
    const id = randomUUID(), payload = { wallet, fingerprint: metadata.publisherID, domain, types: publishTypes, primaryType: 'Publish', message, recipients, bps, metadata, contract: domain.verifyingContract };
    db.prepare('INSERT INTO intents VALUES(?,?,?,?)').run(id, 'publication', JSON.stringify(payload), expiresAt);
    return json(res, 201, { intentID: id, expiresAt, walletURL: `${publicURL}/wallet?intent=${id}` });
  }
  if (req.method === 'GET' && /^\/v2\/orders\/\d+\/lease$/.test(url.pathname)) {
    requireReady(); const orderID = url.pathname.split('/')[3], order = await chain.confirmedCall('storage', 'orders', orderID);
    if (order.requester === ZeroAddress || order.closed || order.remaining === 0n) throw new Error('no_active_paid_order');
    const block = await chain.provider.getBlock(chain.status.indexedHeight);
    if (Number(order.end) <= Number(block.timestamp)) throw new Error('retention_order_expired');
    const publication = await chain.confirmedCall('publication', 'publications', order.publicationId), row = db.prepare('SELECT bytes FROM metadata WHERE hash=?').get(publication.metadataHash.slice(2));
    if (!row) throw new Error('metadata_unavailable');
    const metadata = JSON.parse(Buffer.from(row.bytes, 'base64')), providerBinding = await bindingFor((await chain.confirmedCall('identity', 'bindings', order.provider)).fingerprint.slice(2), order.provider);
    if (!providerBinding.active || !providerBinding.edProofVerified || providerBinding.wallet.toLowerCase() !== order.provider.toLowerCase()) throw new Error('verified_provider_binding_required');
    const source = metadata.sources.find(s => s.providerID === providerBinding.fingerprint);
    if (!source || metadata.sha256 !== order.archiveHash.slice(2)) throw new Error('order_source_mismatch');
    const domain = `${config.chainId}:${chain.contracts.storage.address}:${orderID}`;
    const cachedReceipt = db.prepare('SELECT * FROM lease_receipts WHERE domain=?').get(domain);
    if (cachedReceipt && now() - cachedReceipt.issued < 300) return json(res, 200, JSON.parse(cachedReceipt.payload));
    const existing = db.prepare('SELECT * FROM leases WHERE domain=?').get(domain), id = randomUUID(), nonce = (existing?.nonce ?? 0) + 1;
    db.prepare('INSERT OR REPLACE INTO leases VALUES(?,?,?)').run(domain, nonce, id);
    const receipt = identity.envelope({ schemaVersion: 1, type: 'ats-retention-lease', providerID: source.providerID, resourceID: source.resourceID, publisherID: metadata.publisherID, sha256: metadata.sha256, byteCount: metadata.byteCount, retainUntil: Number(order.end), orderID: id, chainId: config.chainId, market: chain.contracts.storage.address, serviceOrderID: `0x${BigInt(orderID).toString(16).padStart(64, '0')}`, leaseNonce: nonce, issuedAt: now() });
    db.prepare('INSERT OR REPLACE INTO lease_receipts VALUES(?,?,?)').run(domain, JSON.stringify(receipt), now());
    return json(res, 200, receipt);
  }
  if (req.method === 'GET' && url.pathname === '/v2/observations') {
    const orderID = url.searchParams.get('orderID');
    if (!/^\d+$/.test(orderID ?? '')) throw new Error('invalid_order');
    if (!observer) return json(res, 200, { items: [] });
    return json(res, 200, { items: db.prepare('SELECT evidence FROM observations WHERE orderID=? ORDER BY period DESC,slot LIMIT 100').all(orderID).map(r => JSON.parse(r.evidence)) });
  }
  if (req.method === 'GET' && url.pathname === '/wallet/ethers.js') {
    const bytes = await readFile(new URL('../node_modules/ethers/dist/ethers.min.js', import.meta.url));
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'public,max-age=3600' }); return res.end(bytes);
  }
  if (req.method === 'GET' && url.pathname === '/v2/wallet-operations') {
    const token = chain.contracts.token;
    let tokenInfo = { address: chain.manifest.token, symbol: 'base units', decimals: 0 };
    if (token) { try { tokenInfo = { ...tokenInfo, symbol: await token.reader.symbol(), decimals: Number(await token.reader.decimals()) }; } catch {} }
    return json(res, 200, { network: network(), token: tokenInfo, operations: walletOperations(chain) });
  }
  if (req.method === 'POST' && url.pathname === '/v2/wallet-operations/preview') {
    requireReady(); const input = await body(req); return json(res, 200, previewOperation(chain, input.operation, input.args));
  }
  if (req.method === 'GET' && url.pathname === '/wallet/manage.js') {
    const bytes = await readFile(new URL('./manage.mjs', import.meta.url)); res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(bytes);
  }
  if (req.method === 'GET' && url.pathname === '/wallet/app.js') {
    const bytes = await readFile(new URL('./wallet.mjs', import.meta.url)); res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(bytes);
  }
  if (req.method === 'GET' && ['/wallet', '/wallet/publish', '/wallet/manage'].includes(url.pathname)) {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Security-Policy': "default-src 'self'; script-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'", 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff' });
    if (url.pathname === '/wallet/manage') return res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ATS network wallet operations</title><body><main style="max-width:52em;margin:2em auto;padding:1em;font:17px system-ui"><h1>Network wallet operations</h1><p id="network"></p><section id="account"></section><p>Select an operation and fill its fields. Your wallet shows the gas fee before you approve. Each action is separate; token spending requires its own exact approval.</p><label>Operation <select id="operation"></select></label><p id="explanation"></p><div id="fields"></div><p><label>Import a reward voucher or signed quote <input id="import" type="file" accept="application/json,.json"></label></p><button id="preview">Review operation</button><section id="review"></section><details><summary>Advanced transaction details</summary><pre id="details" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre></details><button id="execute" disabled>Open wallet and review</button><p id="status" role="status"></p></main><script type="module" src="/wallet/manage.js"></script></body></html>');
    return res.end('<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>ATS wallet authorization</title><body><main style="max-width:48em;margin:3em auto;padding:1em;font:17px system-ui"><h1>ATS wallet authorization</h1><p>Review the exact operation and network. Your wallet submits a transaction and pays gas. No private key is sent to this service.</p><pre id="details" style="white-space:pre-wrap;overflow-wrap:anywhere"></pre><button id="authorize" disabled>Connect wallet, review and authorize</button><p id="status" role="status"></p></main><script type="module" src="/wallet/app.js"></script></body></html>');
  }
  return json(res, 404, { error: 'not_found' });
}
let active = 0, stopping = false;
const rates = new Map();
const server = http.createServer(async (req, res) => {
  if (stopping || active >= 16) return json(res, 503, { error: 'service_busy' });
  const ip = req.socket.remoteAddress, time = now();
  if (rates.size > 10000) for (const [key, value] of rates) if (time - value.start > 60) rates.delete(key);
  if (!rates.has(ip) && rates.size >= 10000) return json(res, 429, { error: 'rate_limit' });
  const rate = rates.get(ip) ?? { start: time, count: 0 };
  if (time - rate.start > 60) { rate.start = time; rate.count = 0; }
  rate.count++; rates.set(ip, rate);
  if (rate.count > 240) return json(res, 429, { error: 'rate_limit' });
  active++;
  try { await route(req, res); }
  catch (error) { if (!res.headersSent) json(res, 400, { error: String(error.code ?? error.message).slice(0, 120) }); else res.destroy(); }
  finally { active--; }
});
server.requestTimeout = 30000; server.headersTimeout = 10000; server.maxHeadersCount = 50;
let timer, running = false;
async function cycle() {
  if (running || stopping) return;
  running = true;
  try { await chain.tick();
    if (chain.status.rollbackBlocks > 0) {
      db.exec('BEGIN IMMEDIATE');
      try {
        for (const table of ['observations', 'observer_reports', 'observer_actions']) { if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) db.exec(`DELETE FROM ${table}`); }
        db.exec("DELETE FROM service_state WHERE key LIKE 'audit-schedule:%'; DELETE FROM lease_receipts; DELETE FROM catalog_checks;");
        db.exec('COMMIT');
      } catch (error) { db.exec('ROLLBACK'); throw error; }
    }
    await catalog.refresh(); await observer?.tick(); await settlement?.tick(); db.prepare('DELETE FROM intents WHERE expires<?').run(now()); }
  catch (error) { console.error(JSON.stringify({ event: 'service_cycle_failed', code: String(error.code ?? error.message).slice(0, 100) })); }
  finally { running = false; if (!stopping) timer = setTimeout(cycle, config.pollMs); }
}
server.listen(config.port, '0.0.0.0', () => console.log(JSON.stringify({ event: 'service_started', port: config.port, serviceID: identity.fingerprint, observer: observer?.signer.address ?? null })));
cycle();
async function stop() {
  if (stopping) return; stopping = true; clearTimeout(timer); server.close();
  const deadline = Date.now() + 15000;
  while ((running || active) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100));
  await chain.provider.destroy(); db.close(); process.exit(0);
}
process.on('SIGTERM', stop); process.on('SIGINT', stop);
