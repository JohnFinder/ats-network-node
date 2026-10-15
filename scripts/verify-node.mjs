#!/usr/bin/env node
// Synthetic transfer fixtures only. No user documents, real tokens or live node required.
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, sign, verify, randomBytes, randomUUID, createPublicKey } from 'node:crypto';
import { readFile, writeFile, chmod } from 'node:fs/promises';

const origin = process.env.NODE_URL || 'http://127.0.0.1:18787';
const endpoint = new URL(origin);
if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) && process.env.ALLOW_REMOTE_VERIFY !== '1') throw Error('Only local verification allowed by default');
const statePath = process.env.VERIFY_STATE || '/tmp/ats-network-verification-state.json';
const phase = process.argv[2] || 'full';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const keys = () => {
  const key = generateKeyPairSync('ed25519');
  return { private: key.privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'), public: key.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64') };
};
function headers(identity, method, route, body, nonce = randomUUID(), audience = endpoint.origin) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const message = `ATS-NODE-V1\n${audience}\n${method}\n${route}\n${timestamp}\n${nonce}\n${sha(body)}`;
  return { 'Content-Type': 'application/json', 'X-ATS-Audience': audience, 'X-ATS-Public-Key': identity.public, 'X-ATS-Timestamp': timestamp,
    'X-ATS-Nonce': nonce, 'X-ATS-Signature': sign(null, Buffer.from(message), { key: Buffer.from(identity.private, 'base64'), format: 'der', type: 'pkcs8' }).toString('base64') };
}
async function request(identity, method, route, value, expected = 200, provided) {
  const body = value === undefined ? Buffer.alloc(0) : Buffer.isBuffer(value) ? value : Buffer.from(JSON.stringify(value));
  const response = await fetch(origin + route, { method, headers: provided || (identity ? headers(identity, method, route, body) : {}), body: method === 'GET' ? undefined : body });
  const parsed = await response.json();
  assert.equal(response.status, expected, `${method} ${route}: ${JSON.stringify(parsed)}`);
  return parsed;
}
const metadata = (bytes, visibility, title = 'ATS fixture') => ({ sha256: sha(bytes), byteCount: bytes.length, title,
  summary: 'Synthetic Docker acceptance fixture; not an audiobook.', language: 'en', tags: ['fixture'], visibility, encrypted: true });
const fixture = length => Buffer.concat([Buffer.from('ATSBOOK1'), randomBytes(length - 8)]);
let checks = 0;
const pass = name => { checks++; console.log(`PASS ${name}`); };

async function create(identity, bytes, visibility, title) {
  return request(identity, 'POST', '/v1/uploads', metadata(bytes, visibility, title), 201);
}
async function upload(identity, session, bytes) {
  for (let i = 0; i < Math.ceil(bytes.length / session.partSize); ++i) {
    const chunk = bytes.subarray(i * session.partSize, Math.min((i + 1) * session.partSize, bytes.length));
    const part = await request(identity, 'PUT', `/v1/uploads/${session.id}/parts/${i}`, chunk);
    assert.equal(part.sha256, sha(chunk));
  }
  return request(identity, 'POST', `/v1/uploads/${session.id}/complete`, {});
}

if (phase === 'prepare' || phase === 'full') {
  const identity = keys(), outsider = keys(), bytes = fixture(8 * 1024 * 1024 + 131072);
  const info = await request(null, 'GET', '/v1/node');
  assert.equal(info.rewards.automaticMinting, false); pass('node declares external accounting, no automatic mint');
  const session = await create(identity, bytes, 'public', 'Resumable public fixture');
  const first = bytes.subarray(0, session.partSize);
  await request(identity, 'PUT', `/v1/uploads/${session.id}/parts/0`, first);
  const state = { identity, outsider, bytes: bytes.toString('base64'), session, providerID: info.providerID, checks };
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 }); await chmod(statePath, 0o600);
  pass('first part persisted; restart node before resume phase');
  if (phase === 'prepare') process.exit(0);
}
if (phase === 'resume' || phase === 'full') {
  const state = JSON.parse(await readFile(statePath));
  const { identity, outsider, session } = state; const bytes = Buffer.from(state.bytes, 'base64');
  const info = await request(null, 'GET', '/v1/node');
  assert.equal(info.providerID, state.providerID); pass('provider identity survives restart');
  const before = await request(identity, 'GET', `/v1/uploads/${session.id}`);
  assert.equal(before.parts.length, 1); assert.equal(before.parts[0].sha256, sha(bytes.subarray(0, session.partSize))); pass('resume status preserves exact completed part');
  await request(outsider, 'GET', `/v1/uploads/${session.id}`, undefined, 404); pass('other identity cannot inspect upload');
  const foreign = headers(identity, 'GET', `/v1/uploads/${session.id}`, Buffer.alloc(0), randomUUID(), 'https://different-node.invalid');
  await request(identity, 'GET', `/v1/uploads/${session.id}`, undefined, 401, foreign); pass('valid signature for different node rejected');
  await request(identity, 'POST', `/v1/uploads/${session.id}/complete`, {}, 409); pass('incomplete archive cannot publish');
  const replayRoute = `/v1/uploads/${session.id}`; const replayHeaders = headers(identity, 'GET', replayRoute, Buffer.alloc(0));
  await request(identity, 'GET', replayRoute, undefined, 200, replayHeaders);
  await request(identity, 'GET', replayRoute, undefined, 409, replayHeaders); pass('signed request replay rejected');
  const badHeaders = headers(identity, 'PUT', `/v1/uploads/${session.id}/parts/1`, Buffer.from('wrong'));
  await request(identity, 'PUT', `/v1/uploads/${session.id}/parts/1`, bytes.subarray(session.partSize), 401, badHeaders); pass('body mutation invalidates signature');
  const resource = await upload(identity, before, bytes);
  assert.equal(resource.sha256, sha(bytes)); assert.equal(resource.visibility, 'public');
  const again = await request(identity, 'POST', `/v1/uploads/${session.id}/complete`, {});
  assert.equal(again.id, resource.id); pass('completion is idempotent');
  const page = await request(null, 'GET', '/v1/resources?q=Resumable&sort=recent&limit=1');
  assert(page.items.some(v => v.id === resource.id)); pass('completed public archive automatically searchable');
  const response = await fetch(origin + `/v1/resources/${resource.id}/download`, { headers: { Range: 'bytes=0-7' } });
  assert.equal(response.status, 206); assert.equal(await response.text(), 'ATSBOOK1'); pass('HTTP range retrieval');
  const ticket = await request(outsider, 'POST', `/v1/resources/${resource.id}/downloads`, {}, 201);
  await request(outsider, 'POST', `/v1/downloads/${ticket.id}/complete`, { sha256: resource.sha256 }, 409); pass('unserved download cannot increment count');
  const downloaded = await fetch(ticket.downloadURL); const received = Buffer.from(await downloaded.arrayBuffer());
  assert.equal(received.length, bytes.length); assert.equal(sha(received), resource.sha256); pass('complete download exact size and digest');
  // Allow the HTTP response completion callback to record served ranges.
  const receipt = await request(outsider, 'POST', `/v1/downloads/${ticket.id}/complete`, { sha256: resource.sha256 });
  assert.equal(receipt.counted, true);
  const duplicate = await request(outsider, 'POST', `/v1/downloads/${ticket.id}/complete`, { sha256: resource.sha256 });
  assert.equal(duplicate.counted, false); pass('completion receipt counted once');
  for (const sort of ['downloads', 'trending']) {
    const result = await request(null, 'GET', `/v1/resources?sort=${sort}&limit=1`); assert.equal(result.items[0].id, resource.id);
  }
  pass('downloads and trending ranking respond to observed delivery');
  const evidence = await request(null, 'GET', `/v1/resources/${resource.id}/evidence`);
  const encoded = Buffer.from(evidence.evidenceBytes, 'base64'); assert.equal(sha(encoded), evidence.evidenceHash);
  const publicKey = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(evidence.publicKey, 'base64')]), format: 'der', type: 'spki' });
  assert(verify(null, encoded, publicKey, Buffer.from(evidence.signature, 'base64')));
  assert.equal(sha(Buffer.from(evidence.publicKey, 'base64')), state.providerID); pass('signed node evidence verifies against pinned identity');
  for (const visibility of ['private', 'unlisted']) {
    const secretBytes = fixture(4096);
    const s = await create(identity, secretBytes, visibility, `Hidden ${visibility}`); const hidden = await upload(identity, s, secretBytes);
    const listed = await request(null, 'GET', '/v1/resources?q=Hidden&limit=100'); assert.equal(listed.items.length, 0);
    if (visibility === 'private') {
      await request(null, 'GET', `/v1/resources/${hidden.id}`, undefined, 401);
      await request(outsider, 'GET', `/v1/resources/${hidden.id}`, undefined, 404);
      const t = await request(identity, 'POST', `/v1/resources/${hidden.id}/downloads`, {}, 201);
      const r = await fetch(t.downloadURL); assert.equal(r.status, 200); assert.equal(sha(Buffer.from(await r.arrayBuffer())), hidden.sha256);
    } else {
      const r = await fetch(origin + `/v1/resources/${hidden.id}/download`); assert.equal(r.status, 200);
    }
  }
  pass('private/unlisted excluded; private owner-scoped ticket works');
  const corrupt = fixture(256); const wrong = { ...metadata(corrupt, 'public', 'Corrupt fixture'), sha256: '0'.repeat(64) };
  const s = await request(identity, 'POST', '/v1/uploads', wrong, 201);
  await request(identity, 'PUT', `/v1/uploads/${s.id}/parts/0`, corrupt);
  await request(identity, 'POST', `/v1/uploads/${s.id}/complete`, {}, 422); pass('incorrect declared digest rejected at finalization');
  await request(identity, 'DELETE', `/v1/uploads/${s.id}`); pass('unfinished upload cancellation');
  await request(outsider, 'DELETE', `/v1/resources/${resource.id}`, {}, 404); pass('other identity cannot delete publication');
  const paged = await request(null, 'GET', '/v1/resources?limit=1&cursor=not-a-cursor', undefined, 400); assert(paged.error); pass('invalid pagination rejected');
  state.publicResourceID = resource.id; state.resourceSHA256 = resource.sha256; state.checks = checks; delete state.bytes;
  await writeFile(statePath, JSON.stringify(state), { mode: 0o600 });
  console.log(JSON.stringify({ phase, checks, publicResourceID: resource.id, providerID: state.providerID, statePath }));
}
