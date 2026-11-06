import http from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, randomUUID, sign, verify } from 'node:crypto';
import { mkdir, readFile, writeFile, chmod } from 'node:fs/promises';
import path from 'node:path';
import { verifyMessage, getAddress } from 'ethers';
import { createEconomy } from './economy.mjs';
import { connectSettlement, kindCode, loadChainSettlement, packageKey, quoteLedger, readAtomicBalance, readPurchase, readRefund } from './chain-settlement.mjs';
import { reconcileChainOrders } from './chain-entitlements.mjs';
import { createModeration } from '../../src/moderation.mjs';

// This service deliberately has no route into the anonymous ATSBOOK1 storage/mesh.
const port = Number(process.env.VOICE_MARKET_PORT ?? 8793);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw Error('Invalid port');
const origin = new URL(process.env.VOICE_MARKET_PUBLIC_URL ?? `http://127.0.0.1:${port}`);
if (origin.pathname !== '/' || origin.search || origin.hash || origin.username || origin.password ||
    !(origin.protocol === 'https:' || (origin.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname)))) throw Error('Invalid public origin');
const sandbox = process.env.VOICE_MARKET_SANDBOX_ENABLED === '1';
const admins = new Set((process.env.VOICE_MARKET_ADMIN_SUBJECTS ?? '').split(',').filter(Boolean));
const dataDir = path.resolve(process.env.VOICE_MARKET_DATA_DIR ?? './voice-market-data');
process.umask(0o077);
await mkdir(dataDir, { recursive: true, mode: 0o700 });
const keyPath = path.join(dataDir, 'issuer.der');
let privateKey;
try { privateKey = createPrivateKey({ key: await readFile(keyPath), format: 'der', type: 'pkcs8' }); }
catch (e) {
  if (e.code !== 'ENOENT') throw e;
  privateKey = generateKeyPairSync('ed25519').privateKey;
  await writeFile(keyPath, privateKey.export({ format: 'der', type: 'pkcs8' }), { mode: 0o600, flag: 'wx' });
}
await chmod(keyPath, 0o600);
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const publicKeyBytes = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }).subarray(-32);
const issuerID = hash(publicKeyBytes), keyID = issuerID;
const dbPath = path.join(dataDir, 'market.sqlite');
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
CREATE TABLE IF NOT EXISTS nonces(subject TEXT, nonce TEXT, expires INTEGER, PRIMARY KEY(subject,nonce));
CREATE TABLE IF NOT EXISTS packages(id TEXT, version TEXT, holder TEXT NOT NULL, manifest TEXT NOT NULL, manifest_sha TEXT NOT NULL, bundle TEXT NOT NULL, prices TEXT NOT NULL, terms TEXT NOT NULL, delegation TEXT NOT NULL, active INTEGER NOT NULL DEFAULT 1, created TEXT NOT NULL, PRIMARY KEY(id,version));
CREATE TABLE IF NOT EXISTS ledger(id TEXT PRIMARY KEY, subject TEXT NOT NULL, amount INTEGER NOT NULL, kind TEXT NOT NULL, reference TEXT NOT NULL UNIQUE, created TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS orders(id TEXT PRIMARY KEY, buyer TEXT NOT NULL, package TEXT NOT NULL, version TEXT NOT NULL, kind TEXT NOT NULL, amount INTEGER NOT NULL, status TEXT NOT NULL, certificate TEXT NOT NULL, created TEXT NOT NULL, UNIQUE(buyer,package,version,kind));
CREATE TABLE IF NOT EXISTS requests(subject TEXT, key TEXT, digest TEXT NOT NULL, result TEXT NOT NULL, PRIMARY KEY(subject,key));
CREATE TABLE IF NOT EXISTS audit(id TEXT PRIMARY KEY, subject TEXT NOT NULL, action TEXT NOT NULL, reference TEXT NOT NULL, created TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ledger_subject ON ledger(subject);
CREATE INDEX IF NOT EXISTS orders_buyer ON orders(buyer);
`);
if (!db.prepare('PRAGMA table_info(packages)').all().some(column => column.name === 'moderation_status')) {
  db.exec("ALTER TABLE packages ADD COLUMN moderation_status TEXT NOT NULL DEFAULT 'pending'");
}
db.exec('CREATE INDEX IF NOT EXISTS package_moderation_queue ON packages(moderation_status,created,id,version)');
const moderation = createModeration(db, admins, process.env.VOICE_MARKET_MODERATION_CONTACT_URL);
await chmod(dbPath, 0o600);
const now = () => new Date().toISOString();
const fail = (status, code) => Object.assign(Error(code), { status, code });
const requireThat = (condition, code = 'invalid_request', status = 400) => { if (!condition) throw fail(status, code); };
const json = (res, status, value) => {
  const bytes = Buffer.from(JSON.stringify(value));
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(bytes);
};
let buffered = 0;
async function body(req, max = 64 * 1024) {
  requireThat(buffered < 2, 'request_capacity', 429);
  buffered++;
  try {
    const buffers = []; let size = 0;
    for await (const b of req) { size += b.length; requireThat(size <= max, 'body_too_large', 413); buffers.push(b); }
    return Buffer.concat(buffers);
  } finally { buffered--; }
}
function parse(bytes) {
  try { const value = JSON.parse(bytes); requireThat(value && typeof value === 'object' && !Array.isArray(value)); return value; }
  catch { throw fail(400, 'invalid_json'); }
}
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const digest = /^[0-9a-f]{64}$/;
const text = (value, max = 256) => typeof value === 'string' && value.length > 0 && value.length <= max;
const base64 = value => {
  requireThat(typeof value === 'string', 'invalid_base64');
  const bytes = Buffer.from(value, 'base64');
  requireThat(bytes.toString('base64') === value, 'invalid_base64');
  return bytes;
};
function authenticate(req, url, bytes) {
  const h = req.headers, timestamp = h['x-ats-timestamp'], nonce = h['x-ats-nonce'];
  requireThat(h['x-ats-audience'] === origin.origin && typeof timestamp === 'string' && /^\d{1,12}$/.test(timestamp) &&
    Math.abs(Date.now() / 1000 - Number(timestamp)) <= 300 && typeof nonce === 'string' && uuid.test(nonce), 'authentication_required', 401);
  const key = base64(h['x-ats-public-key']), signature = base64(h['x-ats-signature']);
  requireThat(key.length === 32 && signature.length === 64, 'invalid_signature', 401);
  const message = `ATS-NODE-V1\n${origin.origin}\n${req.method}\n${url.pathname}${url.search}\n${timestamp}\n${nonce}\n${hash(bytes)}`;
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key]), format: 'der', type: 'spki' });
  requireThat(verify(null, Buffer.from(message), publicKey, signature), 'invalid_signature', 401);
  const subject = hash(key);
  db.prepare('DELETE FROM nonces WHERE expires < ?').run(Math.floor(Date.now() / 1000));
  requireThat(db.prepare('SELECT COUNT(*) n FROM nonces').get().n < 100000, 'authentication_capacity', 429);
  try { db.prepare('INSERT INTO nonces VALUES(?,?,?)').run(subject, nonce.toLowerCase(), Math.floor(Date.now() / 1000) + 601); }
  catch { throw fail(409, 'replayed_request'); }
  return { subject, publicKey: key.toString('base64'), signature: signature.toString('base64'), message };
}
function transaction(fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const result = fn(); db.exec('COMMIT'); return result; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}
function idempotent(req, subject, bytes, operation) {
  const key = req.headers['idempotency-key'];
  requireThat(typeof key === 'string' && /^[a-zA-Z0-9_-]{16,128}$/.test(key) && parse(bytes).idempotencyKey === key, 'signed_idempotency_key_required');
  const requestDigest = hash(Buffer.concat([Buffer.from(`${req.method}\n${req.url}\n`), bytes]));
  return transaction(() => {
    const previous = db.prepare('SELECT * FROM requests WHERE subject=? AND key=?').get(subject, key);
    if (previous) { requireThat(previous.digest === requestDigest, 'idempotency_conflict', 409); return JSON.parse(previous.result); }
    requireThat(db.prepare('SELECT COUNT(*) n FROM requests').get().n < 100000, 'mutation_capacity', 507);
    const result = operation();
    db.prepare('INSERT INTO requests VALUES(?,?,?,?)').run(subject, key, requestDigest, JSON.stringify(result));
    return result;
  });
}
const balance = subject => db.prepare('SELECT COALESCE(SUM(amount),0) amount FROM ledger WHERE subject=?').get(subject).amount;
const economy = createEconomy(db, { issuerID, sandbox });
const chain = await connectSettlement(loadChainSettlement());
db.exec(`CREATE TABLE IF NOT EXISTS chain_settlements(order_id TEXT PRIMARY KEY REFERENCES orders(id), onchain_order_id TEXT NOT NULL, purchase_tx TEXT NOT NULL UNIQUE, refund_tx TEXT UNIQUE, chain_id INTEGER NOT NULL, contract TEXT NOT NULL);`);
function settlementHolder(subject) { return db.prepare('SELECT address FROM wallet_bindings WHERE subject=?').get(subject)?.address ?? null; }
function packageDetails(p) {
  return { packageID: p.id, packageVersion: p.version, rightsHolderID: p.holder, settlementHolder: settlementHolder(p.holder),
    manifestSHA256: p.manifest_sha, manifest: JSON.parse(p.manifest), prices: JSON.parse(p.prices), terms: JSON.parse(p.terms), moderationStatus: p.moderation_status };
}
function packageFor(id, version) {
  return db.prepare('SELECT * FROM packages WHERE lower(id)=lower(?) AND version=?').get(id, version);
}
const packageTarget = p => `voice:${p.id.toLowerCase()}:${p.version}`;
async function hasEntitlement(subject, p) {
  const orders = db.prepare("SELECT * FROM orders WHERE buyer=? AND package=? AND version=? AND status='active'").all(subject, p.id, p.version);
  await reconcileChainOrders(db, chain, orders);
  return orders.some(order => order.status === 'active');
}
function audit(subject, action, reference) { db.prepare('INSERT INTO audit VALUES(?,?,?,?,?)').run(randomUUID(), subject, action, reference, now()); }
function envelope(payload) {
  const bytes = Buffer.from(JSON.stringify(payload));
  return { algorithm: 'Ed25519', keyID, payload: bytes.toString('base64'), signature: sign(null, bytes, privateKey).toString('base64') };
}
function validBundle(value, subject) {
  const m = value.manifest;
  requireThat(m?.schemaVersion === 2 && uuid.test(m.packageID) && text(m.version, 64) && /^[a-zA-Z0-9._-]+$/.test(m.version) &&
    m.rightsHolderID === subject && text(m.name) && text(m.recordingLanguage, 32) && text(m.engine) && text(m.modelRevision) &&
    Array.isArray(m.targetLanguages) && m.targetLanguages.length > 0 && m.targetLanguages.length <= 113 && m.targetLanguages.every(l => text(l, 32)), 'invalid_manifest');
  requireThat(Array.isArray(m.licenseKinds) && m.licenseKinds.length > 0 && m.licenseKinds.length <= 2 && new Set(m.licenseKinds).size === m.licenseKinds.length && m.licenseKinds.every(k => ['commercial', 'noncommercial'].includes(k)), 'invalid_license');
  requireThat(Array.isArray(m.files) && m.files.length > 0 && m.files.length <= 128 && Array.isArray(value.files) && value.files.length === m.files.length, 'invalid_files');
  const names = new Set(); const supplied = new Map(); let total = 0;
  for (const f of value.files) { requireThat(text(f.path) && !supplied.has(f.path), 'duplicate_file'); supplied.set(f.path, f.data); }
  for (const f of m.files) {
    requireThat(text(f.path) && /^[a-zA-Z0-9_./-]+$/.test(f.path) && !f.path.startsWith('/') && !f.path.split('/').some(p => !p || p === '.' || p === '..') && !['manifest.json', 'voice.json'].includes(f.path) && !names.has(f.path), 'unsafe_path');
    names.add(f.path);
    requireThat(digest.test(f.sha256) && Number.isSafeInteger(f.byteLength) && f.byteLength > 0, 'invalid_file_metadata');
    const bytes = base64(supplied.get(f.path)); total += bytes.length;
    requireThat(total <= 24 * 1024 * 1024 && bytes.length === f.byteLength && hash(bytes) === f.sha256, 'file_integrity');
  }
  requireThat(Array.isArray(m.samples) && m.samples.length > 0 && m.samples.length <= 64 && m.samples.every(s => names.has(s.path) && text(s.transcript, 16000) && text(s.language, 32)) && names.has(m.previewPath) && !m.samples.some(s => s.path === m.previewPath), 'invalid_samples');
  // Audio decoding and quality measurements are performed by the native importer.
  requireThat(m.samples.every(s => /\.(wav|flac|m4a)$/i.test(s.path)) && /\.(wav|flac|m4a)$/i.test(m.previewPath), 'invalid_audio_path');
  const grant = value.distribution;
  requireThat(grant && grant.operatorID === issuerID && grant.rightsHolderID === subject && grant.packageID === m.packageID && grant.packageVersion === m.version && grant.allowDistribution === true && grant.allowCertificateIssuance === true && text(grant.termsVersion, 64), 'distribution_grant_required');
  requireThat(value.prices && Object.keys(value.prices).length === m.licenseKinds.length && m.licenseKinds.every(k => Number.isSafeInteger(value.prices[k]) && value.prices[k] > 0 && value.prices[k] <= 100000000), 'invalid_prices');
  requireThat(value.terms && Object.keys(value.terms).length === 2 && text(value.terms.version, 64) && text(value.terms.text, 32000) && grant.termsVersion === value.terms.version, 'terms_required');
  requireThat(Buffer.byteLength(JSON.stringify(m)) <= 65536, 'manifest_too_large');
  return m;
}
function pdfCertificate(order) {
  const payload = JSON.parse(Buffer.from(JSON.parse(order.certificate).payload, 'base64'));
  const lines = ['ATS Personal Voice License', ...Object.entries({ certificateID: payload.certificateID, orderID: payload.orderID, buyerSubjectID: payload.buyerSubjectID, packageID: payload.packageID, packageVersion: payload.packageVersion, license: payload.license.kind, personalOnly: true, transferable: false, sublicensable: false, issuedAt: payload.issuedAt, issuerID: payload.issuerID, status: order.status }).map(([k, v]) => `${k}: ${v}`)];
  const escape = s => s.replace(/[^\x20-\x7e]/g, '?').replace(/[\\()]/g, '\\$&');
  const stream = `BT /F1 9 Tf 36 800 Td 14 TL ${lines.map((line, i) => `${i ? 'T* ' : ''}(${escape(line)}) Tj`).join('\n')} ET`;
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>', '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>', `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`];
  let output = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((o, i) => { offsets.push(Buffer.byteLength(output)); output += `${i + 1} 0 obj\n${o}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(o => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(output);
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, origin), route = url.pathname;
    requireThat(!url.search || (req.method === 'GET' && ['/v1/moderation/queue', '/v1/moderation/reports'].includes(route)), 'query_not_supported');
    if (req.method === 'GET' && route === '/health') return json(res, 200, { status: 'ok', sandbox, settlementChainID: chain?.chainID ?? null });
    if (req.method === 'GET' && route === '/v1/voice-economic-policy') {
      // The overlay is a response view. It does not rewrite the stored sandbox policy.
      const policy = economy.publicPolicy();
      return json(res, 200, chain ? { ...policy, ...chain.policyOverlay } : policy);
    }
    if (req.method === 'GET' && route === '/v1/voice-issuer') return json(res, 200, { issuerID, keyID, algorithm: 'Ed25519', publicKey: publicKeyBytes.toString('base64'), sandbox, paymentMode: chain ? 'base-sepolia-test' : sandbox ? 'sandboxCredits' : 'unavailable', ...(moderation.info ? { moderation: moderation.info } : {}) });
    if (req.method === 'GET' && route === '/v1/voice-packages') {
      const items = moderation.info ? db.prepare("SELECT id,version,holder,manifest_sha,manifest,prices,terms,moderation_status FROM packages WHERE active=1 AND moderation_status='approved' ORDER BY created DESC LIMIT 20").all() : [];
      return json(res, 200, { items: items.map(packageDetails) });
    }
    const bytes = await body(req, req.method === 'POST' && route === '/v1/voice-packages' ? 36 * 1024 * 1024 : 64 * 1024);
    const auth = authenticate(req, url, bytes), subject = auth.subject;
    const value = bytes.length ? parse(bytes) : {};
    if (route.startsWith('/v1/moderation/')) {
      moderation.requireOperator(subject);
      if (req.method === 'GET' && route === '/v1/moderation/queue') {
        const items = db.prepare("SELECT id,version,holder,manifest_sha,manifest,prices,terms,moderation_status FROM packages WHERE moderation_status='pending' ORDER BY created,id,version LIMIT 100 OFFSET ?")
          .all(moderation.offset(url)).map(packageDetails);
        return json(res, 200, { items });
      }
      if (req.method === 'GET' && route === '/v1/moderation/reports') return json(res, 200, { items: moderation.reports(moderation.offset(url)) });
      const reportRoute = route.match(/^\/v1\/moderation\/reports\/([a-f0-9-]+)\/resolve$/);
      if (req.method === 'POST' && reportRoute && uuid.test(reportRoute[1])) return json(res, 200, moderation.resolve(reportRoute[1], subject, value));
      const reviewRoute = route.match(/^\/v1\/moderation\/voice-packages\/([^/]+)\/versions\/([^/]+)$/);
      if (req.method === 'POST' && reviewRoute) {
        const p = packageFor(reviewRoute[1], reviewRoute[2]);
        requireThat(p, 'package_not_found', 404);
        requireThat(value.status !== 'approved' || p.holder !== subject, 'independent_reviewer_required', 403);
        return json(res, 200, moderation.decide(packageTarget(p), p.moderation_status, subject, value, status => {
          db.prepare('UPDATE packages SET moderation_status=? WHERE id=? AND version=?').run(status, p.id, p.version);
          audit(subject, `moderation_${status}`, `${p.id}/${p.version}`);
        }));
      }
      throw fail(404, 'not_found');
    }
    if (req.method === 'GET' && ['/v1/voice-balance', '/v1/voice-wallet'].includes(route)) {
      const account = economy.wallet(subject);
      if (chain && route === '/v1/voice-wallet') account.onchainAtomicBalance = await readAtomicBalance(chain, account.walletAddress);
      return json(res, 200, account);
    }
    if (req.method === 'POST' && route === '/v1/voice-revenue/settle') {
      requireThat(sandbox, 'sandbox_disabled', 403);
      requireThat(db.prepare('SELECT 1 FROM wallet_bindings WHERE subject=?').get(subject), 'verified_wallet_required', 403);
      return json(res, 200, idempotent(req, subject, bytes, () => ({ ...economy.settle(subject), ...economy.wallet(subject) })));
    }
    if (req.method === 'GET' && route === '/v1/voice-wallet/binding-challenge') {
      db.prepare('DELETE FROM wallet_challenges WHERE expires<?').run(now());
      requireThat(db.prepare('SELECT COUNT(*) n FROM wallet_challenges').get().n < 10000, 'challenge_capacity', 429);
      const challengeID = randomUUID(), expiresAt = new Date(Date.now() + 300000).toISOString();
      const message = `ATS-VOICE-WALLET-V1\n${origin.origin}\n${issuerID}\n${economy.policy.ledgerID}\nchainID:none\n${subject}\n${challengeID}\n${expiresAt}`;
      db.prepare('INSERT INTO wallet_challenges(id,subject,message,expires) VALUES(?,?,?,?)').run(challengeID, subject, message, expiresAt);
      return json(res, 200, { challengeID, message, expiresAt });
    }
    if (req.method === 'POST' && route === '/v1/voice-wallet/binding') {
      return json(res, 200, idempotent(req, subject, bytes, () => {
        const challenge = db.prepare('SELECT * FROM wallet_challenges WHERE id=? AND subject=?').get(String(value.challengeID), subject);
        requireThat(challenge && !challenge.used && Date.now() < Date.parse(challenge.expires), 'wallet_challenge_expired', 409);
        requireThat(typeof value.address === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value.address) && typeof value.signature === 'string' && /^0x[0-9a-fA-F]{130}$/.test(value.signature), 'invalid_wallet_proof');
        let recovered;
        try { recovered = getAddress(verifyMessage(challenge.message, value.signature)); } catch { throw fail(400, 'invalid_wallet_proof'); }
        requireThat(recovered.toLowerCase() === value.address.toLowerCase(), 'wallet_signature_mismatch', 403);
        const existing = db.prepare('SELECT address FROM wallet_bindings WHERE subject=?').get(subject);
        requireThat(!existing || existing.address === recovered, 'wallet_rebinding_not_supported', 409);
        requireThat(!db.prepare('SELECT 1 FROM wallet_bindings WHERE address=? AND subject<>?').get(recovered, subject), 'wallet_already_bound', 409);
        if (!existing) db.prepare('INSERT INTO wallet_bindings VALUES(?,?,?,?)').run(subject, recovered, JSON.stringify({ message: challenge.message, signature: value.signature }), now());
        db.prepare('UPDATE wallet_challenges SET used=1 WHERE id=?').run(challenge.id);
        audit(subject, 'wallet_binding', recovered);
        return economy.wallet(subject);
      }));
    }
    if (req.method === 'POST' && route === '/v1/voice-sandbox-credits') {
      requireThat(sandbox, 'sandbox_disabled', 403);
      requireThat(Number.isSafeInteger(value.amount) && value.amount > 0 && value.amount <= 100000, 'invalid_amount');
      return json(res, 200, idempotent(req, subject, bytes, () => {
        const id = randomUUID();
        return { ledgerID: id, ...economy.allocate(subject, value.amount, `allocation:${id}`) };
      }));
    }
    if (req.method === 'POST' && route === '/v1/voice-packages') {
      const m = validBundle(value, subject), manifest = JSON.stringify(m), manifestSHA256 = hash(manifest);
      const result = idempotent(req, subject, bytes, () => {
        moderation.requireAvailable();
        requireThat(value.economicPolicyID === economy.policy.policyID, 'economic_policy_acceptance_required', 409);
        requireThat(!db.prepare('SELECT 1 FROM packages WHERE lower(id)=lower(?) AND version=?').get(m.packageID, m.version), 'immutable_version_exists', 409);
        requireThat(!db.prepare('SELECT 1 FROM packages WHERE lower(id)=lower(?) AND holder<>?').get(m.packageID, subject), 'package_owner_mismatch', 403);
        requireThat(db.prepare('SELECT COUNT(*) n FROM packages').get().n < 10000 && db.prepare('SELECT COALESCE(SUM(length(bundle)+length(delegation)),0) n FROM packages').get().n + bytes.length * 3 <= 1024 ** 3, 'package_capacity', 507);
        const delegation = { grant: value.distribution, signedRequest: auth, requestSHA256: hash(bytes), requestPayloadBase64: bytes.toString('base64') };
        db.prepare('INSERT INTO packages(id,version,holder,manifest,manifest_sha,bundle,prices,terms,delegation,created) VALUES(?,?,?,?,?,?,?,?,?,?)').run(m.packageID, m.version, subject, manifest, manifestSHA256, JSON.stringify({ manifest: m, files: [{ path: 'manifest.json', data: Buffer.from(manifest).toString('base64') }, ...value.files] }), JSON.stringify(value.prices), JSON.stringify(value.terms), JSON.stringify(delegation), now());
        audit(subject, 'publish', `${m.packageID}/${m.version}`);
        return { packageID: m.packageID, packageVersion: m.version, manifestSHA256 };
      });
      return json(res, 201, { ...result, moderationStatus: packageFor(m.packageID, m.version).moderation_status });
    }
    const packageRoute = route.match(/^\/v1\/voice-packages\/([^/]+)\/versions\/([^/]+)(\/(?:content|reports))?$/);
    if (packageRoute) {
      const p = packageFor(packageRoute[1], packageRoute[2]);
      requireThat(p, 'package_not_found', 404);
      if (req.method === 'POST' && packageRoute[3] === '/reports') {
        requireThat(p.moderation_status === 'approved', 'package_not_found', 404);
        return json(res, 201, moderation.report(packageTarget(p), subject, value, {
          packageID: p.id, packageVersion: p.version, rightsHolderID: p.holder, name: JSON.parse(p.manifest).name, manifestSHA256: p.manifest_sha
        }));
      }
      if (req.method === 'DELETE' && !packageRoute[3]) {
        requireThat(p.holder === subject, 'holder_required', 403);
        return json(res, 200, idempotent(req, subject, bytes, () => { db.prepare('UPDATE packages SET active=0 WHERE id=? AND version=?').run(p.id, p.version); audit(subject, 'unlist', `${p.id}/${p.version}`); return { active: false }; }));
      }
      if (req.method === 'GET' && !packageRoute[3]) {
        const mayInspect = p.holder === subject || admins.has(subject);
        requireThat(mayInspect || ((sandbox || chain) && await hasEntitlement(subject, p)), 'personal_entitlement_required', 403);
        const current = packageFor(p.id, p.version);
        requireThat(mayInspect || (moderation.info && current?.moderation_status === 'approved'), 'content_unavailable', 404);
        return json(res, 200, packageDetails(current));
      }
      if (req.method === 'GET' && packageRoute[3] === '/content') {
        if (p.holder !== subject && !admins.has(subject)) {
          requireThat((sandbox || chain) && await hasEntitlement(subject, p), 'personal_entitlement_required', 403);
          requireThat(moderation.info && packageFor(p.id, p.version)?.moderation_status === 'approved', 'content_unavailable', 404);
        }
        requireThat(!req.headers.range, 'range_not_supported', 416);
        return json(res, 200, JSON.parse(p.bundle));
      }
    }
    if (req.method === 'POST' && route === '/v1/voice-purchases') {
      moderation.requireAvailable();
      let purchaseProof = null;
      if (chain) {
        purchaseProof = await readPurchase(chain, value.settlementTransaction);
        const preview = db.prepare('SELECT * FROM packages WHERE lower(id)=lower(?) AND version=?').get(String(value.packageID), String(value.packageVersion));
        requireThat(preview?.moderation_status === 'approved', 'package_not_found', 404);
        const holderBinding = db.prepare('SELECT address FROM wallet_bindings WHERE subject=?').get(preview.holder);
        requireThat(holderBinding && getAddress(holderBinding.address) === purchaseProof.holder && packageKey(preview.id, preview.version, holderBinding.address) === purchaseProof.packageId, 'package_owner_mismatch', 403);
        const previous = db.prepare('SELECT * FROM orders WHERE buyer=? AND package=? AND version=? AND kind=?').get(subject, preview.id, preview.version, value.licenseKind);
        if (previous) {
          await reconcileChainOrders(db, chain, [previous]);
          requireThat(previous.status === 'active', 'previous_order_revoked', 409);
        }
      } else {
        requireThat(sandbox, 'production_payment_not_configured', 503);
        requireThat(value.settlementTransaction == null, 'settlement_not_configured');
        const previous = db.prepare('SELECT * FROM orders WHERE buyer=? AND lower(package)=lower(?) AND version=? AND kind=?').get(subject, String(value.packageID), String(value.packageVersion), value.licenseKind);
        if (previous) {
          await reconcileChainOrders(db, chain, [previous]);
          requireThat(previous.status === 'active', 'previous_order_revoked', 409);
        }
      }
      return json(res, 201, idempotent(req, subject, bytes, () => {
        const p = db.prepare('SELECT * FROM packages WHERE lower(id)=lower(?) AND version=?').get(String(value.packageID), String(value.packageVersion));
        requireThat(p?.moderation_status === 'approved' && (purchaseProof || p.active === 1), 'package_not_found', 404);
        const amount = JSON.parse(p.prices)[value.licenseKind];
        requireThat(['commercial', 'noncommercial'].includes(value.licenseKind) && JSON.parse(p.manifest).licenseKinds.includes(value.licenseKind) && Number.isSafeInteger(amount), 'license_unavailable');
        const terms = JSON.parse(p.terms);
        requireThat(value.expectedPrice === amount && value.termsSHA256 === hash(terms.text), 'quote_changed', 409);
        const existing = db.prepare('SELECT * FROM orders WHERE buyer=? AND package=? AND version=? AND kind=?').get(subject, p.id, p.version, value.licenseKind);
        if (purchaseProof) {
          requireThat(packageKey(p.id, p.version, purchaseProof.holder) === purchaseProof.packageId && kindCode(value.licenseKind) === purchaseProof.kind && purchaseProof.ledgerUnits === BigInt(amount), 'settlement_amount_mismatch', 409);
          const binding = db.prepare('SELECT address FROM wallet_bindings WHERE subject=?').get(subject);
          requireThat(binding && getAddress(binding.address) === purchaseProof.buyer, 'verified_wallet_required', 403);
          const used = db.prepare('SELECT order_id FROM chain_settlements WHERE purchase_tx=?').get(purchaseProof.transaction);
          if (used) requireThat(existing && used.order_id === existing.id, 'settlement_replay', 409);
        }
        if (existing) {
          requireThat(existing.status === 'active', 'previous_order_revoked', 409);
          if (purchaseProof) requireThat(db.prepare('SELECT purchase_tx FROM chain_settlements WHERE order_id=?').get(existing.id)?.purchase_tx === purchaseProof.transaction, 'settlement_replay', 409);
          return { orderID: existing.id, certificate: JSON.parse(existing.certificate), balance: balance(subject), sandbox: !purchaseProof };
        }
        requireThat(db.prepare('SELECT COUNT(*) n FROM orders').get().n < 100000 && db.prepare('SELECT COUNT(*) n FROM orders WHERE buyer=?').get(subject).n < 1000, 'order_capacity', 507);
        if (!purchaseProof) requireThat(balance(subject) >= amount, 'insufficient_credit', 409);
        const orderID = randomUUID(), created = now();
        const payload = { schemaVersion: 1, certificateID: randomUUID(), orderID, buyerSubjectID: subject, packageID: p.id, packageVersion: p.version, manifestSHA256: p.manifest_sha, rightsHolderID: p.holder, license: { kind: value.licenseKind, personalOnly: true, transferable: false, sublicensable: false, termsVersion: terms.version, termsSHA256: hash(terms.text) }, issuerID, issuedAt: created, distributionGrantSHA256: hash(p.delegation), statusURL: `${origin.origin}/v1/voice-certificates/${orderID}/status`, sandbox: !purchaseProof };
        if (purchaseProof) { payload.chainID = chain.chainID; payload.settlementTransaction = purchaseProof.transaction; payload.settlementContract = chain.address; }
        const certificate = envelope(payload);
        db.prepare('INSERT INTO orders VALUES(?,?,?,?,?,?,?,?,?)').run(orderID, subject, p.id, p.version, value.licenseKind, amount, 'active', JSON.stringify(certificate), created);
        if (purchaseProof) db.prepare('INSERT INTO chain_settlements VALUES(?,?,?,?,?,?)').run(orderID, purchaseProof.orderId, purchaseProof.transaction, null, chain.chainID, chain.address);
        else economy.reserve(subject, p.holder, amount, orderID, created);
        audit(subject, 'purchase', orderID);
        return { orderID, certificate, balance: balance(subject), sandbox: !purchaseProof, ...(purchaseProof ? { onchainOrderID: purchaseProof.orderId } : {}) };
      }));
    }
    if (req.method === 'GET' && route === '/v1/voice-certificates') {
      const orders = db.prepare('SELECT * FROM orders WHERE buyer=? ORDER BY created DESC LIMIT 1000').all(subject);
      await reconcileChainOrders(db, chain, orders);
      return json(res, 200, { items: orders.map(o => ({ orderID: o.id, status: o.status, certificate: JSON.parse(o.certificate) })) });
    }
    const certRoute = route.match(/^\/v1\/voice-certificates\/([a-f0-9-]+)(\/(status|pdf|refund))?$/);
    if (certRoute) {
      const o = db.prepare('SELECT * FROM orders WHERE id=?').get(certRoute[1]);
      requireThat(o && (o.buyer === subject || admins.has(subject)), 'certificate_not_found', 404);
      if (req.method === 'POST' && certRoute[3] === 'refund') {
        requireThat(admins.has(subject), 'admin_required', 403);
        const chainRow = db.prepare('SELECT * FROM chain_settlements WHERE order_id=?').get(o.id);
        if (chainRow) requireThat(chain && chainRow.chain_id === chain.chainID && getAddress(chainRow.contract) === getAddress(chain.address), 'settlement_configuration_unavailable', 503);
        const refundProof = chainRow ? await readRefund(chain, value.settlementTransaction) : null;
        if (refundProof) requireThat(refundProof.orderId === chainRow.onchain_order_id, 'settlement_order_mismatch', 409);
        return json(res, 200, idempotent(req, subject, bytes, () => {
          const current = db.prepare('SELECT * FROM orders WHERE id=?').get(o.id);
          if (current.status === 'active') {
            if (chainRow) {
              requireThat(refundProof && refundProof.atomicAmount === quoteLedger(BigInt(current.amount)).atomic, 'settlement_amount_mismatch', 409);
              const binding = db.prepare('SELECT address FROM wallet_bindings WHERE subject=?').get(current.buyer);
              requireThat(binding && getAddress(binding.address) === refundProof.buyer, 'verified_wallet_required', 403);
              db.prepare('UPDATE chain_settlements SET refund_tx=? WHERE order_id=? AND refund_tx IS NULL').run(refundProof.transaction, current.id);
              db.prepare("UPDATE orders SET status='refunded' WHERE id=?").run(current.id);
            } else {
              economy.refund(current);
              db.prepare("UPDATE orders SET status='refunded' WHERE id=?").run(current.id);
            }
            audit(subject, 'refund', current.id);
          }
          return { orderID: current.id, status: 'refunded' };
        }));
      }
      if (req.method === 'GET') await reconcileChainOrders(db, chain, [o]);
      if (req.method === 'GET' && certRoute[3] === 'pdf') {
        const pdf = pdfCertificate(o);
        res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'Content-Disposition': `attachment; filename="${o.id}.pdf"`, 'Cache-Control': 'no-store' }); return res.end(pdf);
      }
      if (req.method === 'GET') return json(res, 200, certRoute[3] === 'status' ? { orderID: o.id, status: o.status } : { orderID: o.id, status: o.status, certificate: JSON.parse(o.certificate) });
    }
    throw fail(404, 'route_not_found');
  } catch (e) { if (!res.headersSent) json(res, e.status ?? 500, { error: e.code ?? 'internal_error' }); else res.destroy(); }
});
server.requestTimeout = 30000;
server.headersTimeout = 10000;
server.maxRequestsPerSocket = 100;
server.listen(port, '0.0.0.0', () => console.log(JSON.stringify({ service: 'voice-market', port, issuerID, sandbox, settlementChainID: chain?.chainID ?? null })));
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => server.close(() => { db.close(); process.exit(0); }));
