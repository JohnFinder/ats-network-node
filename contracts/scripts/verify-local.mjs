import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { parseEther, keccak256, concat, toUtf8Bytes } from 'ethers';
import { root } from './compile.mjs';
import { deployLocal } from './deploy-local.mjs';
import { fetchLocalEvidence } from './evidence.mjs';
import { tx, advance } from './local-chain.mjs';

const { provider, signers, addresses, token, market, deployment } = await deployLocal();
const checks = [];
function passed(label) { checks.push(label); console.log(`PASS ${label}`); }
async function rejects(label, operation) {
  let rejected = false;
  try { await tx(operation()); } catch { rejected = true; }
  assert(rejected, label); passed(label);
}
async function balanced(label) {
  assert.equal(await token.balanceOf(await market.getAddress()), await market.accountedBalance()); passed(label);
}
const hash = value => keccak256(toUtf8Bytes(value));
let archiveHash = hash('local verification document');
let evidence = hash('trusted observation: local demonstration only');
const observation = await fetchLocalEvidence();
if (observation) {
  archiveHash = `0x${observation.evidence.resourceId}`;
  evidence = observation.hash;
  passed(`node signed evidence imported; identity pinned=${observation.identityPinned}; wallet binding not inferred`);
}
const resource = await market.publicationID(addresses[2], archiveHash);
await tx(market.connect(signers[2]).publish(archiveHash, hash('metadata manifest'), '0x' + '0'.repeat(64)));
await rejects('immutable scoped publication cannot be overwritten', () => market.connect(signers[2]).publish(archiveHash, hash('other metadata'), '0x' + '0'.repeat(64)));
await tx(market.publish(archiveHash, hash('independent publisher metadata'), '0x' + '0'.repeat(64)));
assert.notEqual(resource, await market.publicationID(addresses[0], archiveHash));
passed('same archive can have distinct publisher-scoped publication IDs');
assert.equal(await token.totalSupply(), await token.CAP()); passed('fixed capped initial supply');
await tx(market.connect(signers[1]).stake(parseEther('100')));
await balanced('stake accounted');
const now = Number((await provider.getBlock('latest')).timestamp);
await tx(market.openService(addresses[1], resource, parseEther('20'), now + 3600));
await tx(market.connect(signers[1]).acceptService(1));
await rejects('active service prevents unbond', () => market.connect(signers[1]).requestUnbond());
await rejects('unauthorized service attestation rejected', () => market.connect(signers[2]).attestService(1, evidence));
await tx(market.connect(signers[3]).attestService(1, evidence));
assert.equal((await market.services(1)).state, 2n); passed('single attestor cannot settle');
await rejects('duplicate attestor vote rejected', () => market.connect(signers[3]).attestService(1, evidence));
const providerBefore = await token.balanceOf(addresses[1]);
await tx(market.setAttestor(addresses[5], false));
await tx(market.setAttestor(addresses[5], true));
await tx(market.connect(signers[4]).attestService(1, evidence));
assert.equal((await market.services(1)).state, 2n); passed('committee rotation invalidates pending old votes');
await tx(market.connect(signers[3]).attestService(1, evidence));
assert.equal(await token.balanceOf(addresses[1]), providerBefore + parseEther('20'));
passed('two trusted attestations settle prepaid service');
await rejects('service settlement cannot replay', () => market.connect(signers[5]).attestService(1, evidence));
await balanced('settled service accounted');
const later = Number((await provider.getBlock('latest')).timestamp);
await tx(market.openService(addresses[1], resource, parseEther('5'), later + 10));
await tx(market.connect(signers[1]).acceptService(2));
await advance(provider, 11);
await tx(market.refundService(2));
assert.equal((await market.services(2)).state, 4n); passed('expired service refunded and bond unlocked');
await tx(market.openBounty(hash('sponsored public domain audiobook specification'), parseEther('30'), later + 7200));
await tx(market.connect(signers[3]).attestBounty(1, addresses[2], resource, evidence));
await tx(market.connect(signers[4]).attestBounty(1, addresses[2], resource, evidence));
await rejects('publisher bounty review delay enforced', () => market.claimBounty(1));
await advance(provider, 61);
const publisherBefore = await token.balanceOf(addresses[2]);
await tx(market.claimBounty(1));
assert.equal(await token.balanceOf(addresses[2]), publisherBefore + parseEther('30')); passed('fixed sponsored publisher bounty paid');
await rejects('publisher bounty cannot replay', () => market.claimBounty(1));
const leaf0 = await market.rewardLeaf(1, 0, addresses[1], parseEther('7'), evidence);
const leaf1 = await market.rewardLeaf(1, 1, addresses[2], parseEther('3'), evidence);
const rootHash = keccak256(concat([leaf0, leaf1].sort()));
await tx(market.proposeEpoch(rootHash, parseEther('10'), 86400));
await rejects('epoch review delay enforced', () => market.claimReward(1, 0, addresses[1], parseEther('7'), evidence, [leaf1]));
await advance(provider, 61);
await rejects('altered recipient proof rejected', () => market.claimReward(1, 0, addresses[0], parseEther('7'), evidence, [leaf1]));
await tx(market.claimReward(1, 0, addresses[1], parseEther('7'), evidence, [leaf1]));
await rejects('reward claim cannot replay', () => market.claimReward(1, 0, addresses[1], parseEther('7'), evidence, [leaf1]));
await tx(market.claimReward(1, 1, addresses[2], parseEther('3'), evidence, [leaf0]));
assert.equal((await market.epochs(1)).remaining, 0n); passed('bounded prefunded Merkle rewards paid');
await balanced('all payout categories accounted');
await tx(market.proposeEpoch(hash('cancelled proposed root'), parseEther('2'), 86400));
await tx(market.closeEpoch(2));
assert.equal((await market.epochs(2)).closed, true); passed('administrator can cancel challenged epoch before activation');
await tx(market.connect(signers[1]).requestUnbond());
await rejects('unbond delay enforced', () => market.connect(signers[1]).withdrawBond());
await advance(provider, 61);
await tx(market.connect(signers[1]).withdrawBond());
assert.equal(await market.bond(addresses[1]), 0n); passed('unbond delay releases unlocked stake');
await balanced('final contract balance equals liabilities');
const result = { schemaVersion: 1, status: 'passed', kind: 'LOCAL TEST TOKEN ONLY',
  verifiedAt: new Date().toISOString(), checks, deployment, nodeObservation: observation,
  limits: ['Trusted administrator and attestor committee', 'No independent replica or copyright proof', 'No mainnet deployment or real funds', 'No claim that download counts are Sybil resistant'] };
fs.writeFileSync(path.join(root, 'artifacts', 'verification.local.json'), JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ status: result.status, checks: checks.length, network: result.kind }));
