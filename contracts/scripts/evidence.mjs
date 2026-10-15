import assert from 'node:assert/strict';
import { createHash, createPublicKey, verify } from 'node:crypto';

/** Verify exact signed bytes. A valid self-signature is not an independent service proof.
 * expectedNodeID must come from a separately trusted operator record, not this response.
 * providerAddress is only a declaration; require a separately verified EVM binding.
 */
export function verifyNodeEvidence(body, expectedNodeID) {
  assert.equal(typeof body.evidenceBytes, 'string');
  assert.equal(typeof body.publicKey, 'string');
  assert.equal(typeof body.signature, 'string');
  const bytes = Buffer.from(body.evidenceBytes, 'base64');
  const rawKey = Buffer.from(body.publicKey, 'base64');
  const signature = Buffer.from(body.signature, 'base64');
  assert.equal(rawKey.length, 32, 'raw Ed25519 public key');
  assert.equal(signature.length, 64, 'Ed25519 signature');
  assert(bytes.length > 0 && bytes.length <= 64 * 1024, 'bounded observation');
  const digest = createHash('sha256').update(bytes).digest('hex');
  assert.equal(digest, body.evidenceHash, 'exact evidence hash');
  const nodeID = createHash('sha256').update(rawKey).digest('hex');
  if (expectedNodeID) assert.equal(nodeID, expectedNodeID, 'pinned node identity');
  const key = createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), rawKey]), format: 'der', type: 'spki' });
  assert(verify(null, bytes, key, signature), 'valid node signature');
  const evidence = JSON.parse(bytes.toString('utf8'));
  assert.deepEqual(evidence, body.evidence, 'displayed evidence matches signed bytes');
  assert.equal(evidence.schemaVersion, 1);
  assert.equal(evidence.providerID, nodeID, 'declared provider identity');
  assert.match(evidence.resourceId, /^[a-f0-9]{64}$/);
  assert.equal(evidence.sha256, evidence.resourceId);
  assert.equal(evidence.status, 'self-reported-stored');
  assert(Number.isSafeInteger(evidence.byteCount) && evidence.byteCount > 0);
  const observed = Date.parse(evidence.observedAt);
  assert(Number.isFinite(observed) && Math.abs(Date.now() - observed) <= 15 * 60 * 1000, 'fresh observation');
  return { evidence, hash: `0x${digest}`, nodeID, identityPinned: Boolean(expectedNodeID) };
}

export async function fetchLocalEvidence() {
  let raw = process.env.ATS_NODE_EVIDENCE_URL;
  if (!raw && process.env.NODE_URL && process.env.NODE_RESOURCE_ID) {
    raw = `${process.env.NODE_URL.replace(/\/$/, '')}/v1/resources/${encodeURIComponent(process.env.NODE_RESOURCE_ID)}/evidence`;
  }
  if (!raw) {
    if (process.env.NODE_URL) throw new Error('NODE_URL requires NODE_RESOURCE_ID or ATS_NODE_EVIDENCE_URL');
    return null;
  }
  const url = new URL(raw);
  if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', 'node', 'storage'].includes(url.hostname) || url.username || url.password) {
    throw new Error('Verification evidence URL must be local');
  }
  const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(10000) });
  assert(response.ok, 'node evidence request');
  const rawBody = await response.text();
  assert(Buffer.byteLength(rawBody) <= 128 * 1024, 'bounded evidence response');
  const result = verifyNodeEvidence(JSON.parse(rawBody), process.env.EXPECTED_NODE_ID);
  assert.match(result.evidence.publicationID, /^[a-f0-9-]{36}$/i, 'resource UUID');
  const download = new URL(`/v1/resources/${encodeURIComponent(result.evidence.publicationID)}/download`, url.origin);
  const content = await fetch(download, { redirect: 'error', signal: AbortSignal.timeout(30000) });
  assert(content.ok && content.body, 'independent local retrieval succeeds');
  const sha = createHash('sha256');
  let received = 0;
  for await (const chunk of content.body) {
    received += chunk.byteLength;
    assert(received <= result.evidence.byteCount && received <= 1024 * 1024 * 1024, 'bounded download');
    sha.update(chunk);
  }
  assert.equal(received, result.evidence.byteCount, 'retrieved byte count');
  assert.equal(sha.digest('hex'), result.evidence.sha256, 'retrieved archive hash');
  return { ...result, independentlyDownloaded: true, retrievalVerified: true, retrievedBytes: received };

}
