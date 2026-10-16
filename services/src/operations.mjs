import { Interface, TypedDataEncoder, getAddress } from 'ethers';
import { now } from './common.mjs';

const zero = `0x${'0'.repeat(64)}`, addr = '0x0000000000000000000000000000000000000001';
export function walletOperations(chain) {
  const operations = [];
  function add(contract, method, label, example, explanation) {
    if (!chain.contracts[contract]?.interface.getFunction(method)) return;
    const inputs = chain.contracts[contract].interface.getFunction(method).inputs.map(input => ({ name: input.name || 'value', type: input.type, components: input.components?.map(c => ({ name: c.name, type: c.type })) }));
    operations.push({ id: `${contract}.${method}`, contract, method, label, inputs, example, explanation });
  }
  const amount = '1000000000000000000';
  add('storage', 'stake', 'Deposit node bond', [amount], 'Deposit exact token base units into the storage bond. A separate token approval may be required. Active orders lock a portion of the bond.');
  add('storage', 'requestUnbond', 'Request bond withdrawal', [], 'Begins the on-chain withdrawal delay; fails while orders lock the bond.');
  add('storage', 'withdrawBond', 'Withdraw available bond', [], 'Withdraws only after the configured delay and when no bond is locked.');
  add('storage', 'refundRemaining', 'Refund expired order', ['1'], 'Returns unresolved prepaid balance only after the contract retention and grace deadlines.');
  add('storage', 'settlePeriod', 'Settle approved storage period', ['1'], 'Requires observer threshold, elapsed review and no unresolved challenge.');
  add('storage', 'challengePeriod', 'Challenge storage report', ['1', zero], 'Requester/provider/administrator supplies a nonzero SHA-256 evidence or reason commitment during review.');
  add('storage', 'resolveChallenge', 'Resolve challenged report (administrator)', ['1', false, zero], 'Trusted administrator action. Review the evidence off chain; rejecting starts a new report round.');
  add('publication', 'payRoyalty', 'Pay publisher royalty or tip', [zero, amount], 'Transfers exact token base units to the immutable publication royalty split. Separate token approval required.');
  add('identity', 'revoke', 'Revoke this wallet identity binding', [], 'Revokes the connected wallet binding and advances its nonce. It does not erase already published data.');
  // Advanced task/reward methods are derived from the reviewed deployment ABI.
  const names = { openRetainedTask: 'Fund availability milestone', attestRetainedTask: 'Approve availability milestone (observer)', openTask: 'Fund a publisher task', attestTask: 'Approve publisher task (observer)', challengeTask: 'Challenge publisher task', resolveTask: 'Resolve publisher task (administrator)', reopenAfterRotation: 'Reopen task after committee change', claimTask: 'Claim publisher task payment', refundTask: 'Refund expired task', proposeEpoch: 'Fund reward epoch', claimReward: 'Claim allocated reward', closeEpoch: 'Close expired reward epoch' };
  for (const contract of ['tasks', 'rewards']) for (const fragment of chain.contracts[contract]?.interface.fragments ?? []) {
    if (fragment.type !== 'function' || !['nonpayable', 'payable'].includes(fragment.stateMutability) || !names[fragment.name]) continue;
    const example = fragment.inputs.map(input => input.type.endsWith('[]') ? [] : input.type === 'address' ? addr : input.type === 'bool' ? false : input.type.startsWith('bytes') ? zero : '1');
    add(contract, fragment.name, names[fragment.name], example, 'Advanced operation: exact arguments are defined by the reviewed deployment ABI. Token amounts use base units; all eligibility, review and budget checks are enforced on chain.');
  }
  for (const target of ['storage', 'publication', 'tasks', 'rewards']) if (chain.contracts.token && chain.contracts[target]) operations.push({ id: `approve.${target}`, contract: 'token', method: 'approve', label: `Approve exact tokens for ${target}`, inputs: [{ name: 'amount', type: 'uint256' }], example: [amount], explanation: `Authorizes only ${chain.contracts[target].address} to spend the exact amount of the deployment token. Enter 0 to revoke; no unlimited approval is generated.` });
  const quote = { requester: addr, provider: addr, publicationId: zero, archiveHash: zero, start: now() + 600, end: now() + 4200, period: 60, amount, salt: zero, expiresAt: now() + 300 };
  operations.push({ id: 'storage.signQuote', contract: 'storage', method: 'signQuote', label: 'Sign provider storage quote', inputs: [{ name: 'quote', type: 'tuple' }], example: [quote], explanation: 'Provider signs an exact prepaid retention quote. This does not transfer funds. Share the resulting quote and signature with the requester.' });
  add('storage', 'openOrder', 'Purchase quoted storage', [quote, '0x'], 'Requester supplies the provider-signed quote and exact signature. Prepaid amount is transferred into escrow; separate approval required.');
  return operations;
}
export function previewOperation(chain, operation, args) {
  const allowed = walletOperations(chain).find(value => value.id === operation);
  if (!allowed || !Array.isArray(args) || args.length > 20 || JSON.stringify(args).length > 16384) throw new Error('invalid_wallet_operation');
  if (operation === 'storage.signQuote') {
    if (args.length !== 1) throw new Error('invalid_quote');
    const message = args[0];
    const types = { Quote: [{ name: 'requester', type: 'address' }, { name: 'provider', type: 'address' }, { name: 'publicationId', type: 'bytes32' }, { name: 'archiveHash', type: 'bytes32' }, { name: 'start', type: 'uint64' }, { name: 'end', type: 'uint64' }, { name: 'period', type: 'uint64' }, { name: 'amount', type: 'uint256' }, { name: 'salt', type: 'bytes32' }, { name: 'expiresAt', type: 'uint64' }] };
    const domain = { name: 'ATSStorageMarket', version: '1', chainId: chain.manifest.chainId, verifyingContract: chain.contracts.storage.address };
    TypedDataEncoder.hash(domain, types, message);
    return { mode: 'signQuote', domain, types, message, chainId: chain.manifest.chainId, explanation: allowed.explanation };
  }
  if (operation.startsWith('approve.')) {
    const target = operation.split('.')[1];
    if (args.length !== 1 || !/^\d{1,78}$/.test(String(args[0]))) throw new Error('invalid_approval_amount');
    args = [chain.contracts[target].address, args[0]];
  }
  const contract = chain.contracts[allowed.contract], data = contract.interface.encodeFunctionData(allowed.method, args);
  return { mode: 'transaction', chainId: chain.manifest.chainId, token: chain.manifest.token, to: getAddress(contract.address), codeHash: contract.codeHash, method: allowed.method, args, data, value: '0', explanation: allowed.explanation };
}
