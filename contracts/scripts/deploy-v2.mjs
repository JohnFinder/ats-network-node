import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractFactory, Contract, JsonRpcProvider, Wallet, getAddress, keccak256, parseUnits } from 'ethers';
import { compile, root } from './compile.mjs';

export async function deployContracts({ provider, signer, administrator, observers, threshold = 2, minimumBond = parseUnits('10',18), reviewSeconds = 3600, reportGraceSeconds = 604800, unbondSeconds = 604800, tokenAddress, confirmations = 1, artifacts = compile(), localTestToken = false }) {
  const chainId = (await provider.getNetwork()).chainId;
  const contracts = {}, records = {};
  async function deploy(name, args) {
    const contract = await new ContractFactory(artifacts[name].abi, artifacts[name].bytecode, signer).deploy(...args);
    const receipt = await contract.deploymentTransaction().wait(confirmations);
    const address = await contract.getAddress();
    records[name] = { address, abi: artifacts[name].abi, codeHash: keccak256(await provider.getCode(address)), deploymentBlock: receipt.blockNumber, deploymentBlockHash: receipt.blockHash, transactionHash: receipt.hash };
    contracts[name] = contract; return contract;
  }
  let token;
  if (localTestToken) {
    if (chainId !== 1337n && chainId !== 84532n) throw new Error('Test token only on explicitly supported development/test chains');
    token = await deploy('ATNTestToken', [administrator]); tokenAddress = await token.getAddress();
  } else {
    if (!tokenAddress || await provider.getCode(tokenAddress) === '0x') throw new Error('Existing reviewed token contract required');
    tokenAddress = getAddress(tokenAddress);
    token = new Contract(tokenAddress, artifacts.ATNTestToken.abi, signer);
    records.token = { address: tokenAddress, codeHash: keccak256(await provider.getCode(tokenAddress)), existing: true };
  }
  const identity = await deploy('ATSIdentityRegistry', []);
  const registry = await deploy('ATSPublicationRegistry', [await identity.getAddress(), tokenAddress]);
  const storage = await deploy('ATSStorageMarket', [tokenAddress, await registry.getAddress(), administrator, observers, threshold, minimumBond, reviewSeconds, reportGraceSeconds, unbondSeconds]);
  const tasks = await deploy('ATSPublisherTasks', [await storage.getAddress()]);
  const rewards = await deploy('ATSRewardVault', [tokenAddress, administrator, reviewSeconds]);
  const manifest = {
    schemaVersion: 2, network: chainId === 1337n ? 'LOCAL TEST ONLY' : chainId === 84532n ? 'BASE SEPOLIA TEST ONLY' : 'OPERATOR CONFIGURED',
    chainId: Number(chainId), confirmations, administrator, observers, threshold,
    minimumBond: minimumBond.toString(), reviewSeconds, reportGraceSeconds, unbondSeconds,
    compiler: artifacts.ATSStorageMarket.compiler, token: tokenAddress, identity: await identity.getAddress(),
    registry: await registry.getAddress(), storage: await storage.getAddress(), tasks: await tasks.getAddress(), rewards: await rewards.getAddress(),
    deploymentBlock: Math.min(...Object.values(records).filter(r => r.deploymentBlock !== undefined).map(r => r.deploymentBlock)), contracts: records,
    trust: { committee: 'trusted threshold retrieval observations', ed25519: 'off-chain dual signature verification required', replicaProofs: false, priceOracle: false, rewardRootGovernance: 'trusted administrator' },
    deployedAt: new Date().toISOString()
  };
  return { provider, token, identity, registry, storage, tasks, rewards, manifest };
}

export async function deployConfigured({ execute = false } = {}) {
  const artifacts = execute ? compile() : undefined;
  const requestedChain = Number(process.env.ATS_DEPLOY_CHAIN_ID ?? '1337');
  if (!Number.isSafeInteger(requestedChain) || requestedChain <= 0) throw new Error('Invalid chain ID');
  const builtin = [1337, 84532];
  if (!builtin.includes(requestedChain)) {
    const allowed = (process.env.ATS_ALLOWED_CHAIN_IDS ?? '').split(',').map(Number);
    if (process.env.ATS_ALLOW_PRODUCTION_DEPLOY !== 'I_ACCEPT_EXTERNAL_AUDIT_AND_REAL_FUNDS_RESPONSIBILITY' || !allowed.includes(requestedChain)) throw new Error('Production disabled: explicit allow-list and acknowledgement required');
  }
  const rpc = new URL(process.env.ATS_CHAIN_RPC ?? 'http://127.0.0.1:8545');
  if (rpc.username || rpc.password || (rpc.protocol !== 'https:' && !(rpc.protocol === 'http:' && requestedChain === 1337 && ['127.0.0.1','localhost','[::1]','chain'].includes(rpc.hostname)))) throw new Error('RPC must use HTTPS, except local development');
  const provider = new JsonRpcProvider(rpc.href, undefined, { cacheTimeout: -1 });
  if ((await provider.getNetwork()).chainId !== BigInt(requestedChain)) throw new Error('RPC chain ID differs from explicit configuration');
  const isLocal = requestedChain === 1337;
  const secret = process.env.ATS_DEPLOYER_PRIVATE_KEY;
  if (!isLocal && !secret) throw new Error('External deployment key must come from ATS_DEPLOYER_PRIVATE_KEY environment only');
  const signer = secret ? new Wallet(secret, provider) : await provider.getSigner(0);
  const signerAddress = await signer.getAddress();
  const administrator = getAddress(process.env.ATS_ADMINISTRATOR ?? (isLocal ? signerAddress : ''));
  const observers = process.env.ATS_OBSERVERS ? JSON.parse(process.env.ATS_OBSERVERS).map(getAddress) : isLocal ? await Promise.all([3,4,5].map(async i => (await provider.getSigner(i)).getAddress())) : [];
  const threshold = Number(process.env.ATS_OBSERVER_THRESHOLD ?? '2');
  if (observers.length < threshold || observers.length > 32 || new Set(observers).size !== observers.length || threshold < 2 || threshold > 32) throw new Error('Explicit distinct observer committee required');
  const confirmations = Number(process.env.ATS_CONFIRMATIONS ?? (isLocal ? '1' : '12'));
  if (!Number.isInteger(confirmations) || confirmations < 1 || confirmations > 256) throw new Error('Invalid confirmations');
  const options = { artifacts, provider, signer, administrator, observers, threshold, confirmations,
    reviewSeconds: Number(process.env.ATS_REVIEW_SECONDS ?? (isLocal ? '60' : '86400')),
    reportGraceSeconds: Number(process.env.ATS_REPORT_GRACE_SECONDS ?? (isLocal ? '3600' : '604800')),
    unbondSeconds: Number(process.env.ATS_UNBOND_SECONDS ?? (isLocal ? '60' : '604800')),
    minimumBond: BigInt(process.env.ATS_MINIMUM_BOND_UNITS ?? '10000000000000000000'),
    tokenAddress: process.env.ATS_TOKEN_ADDRESS, localTestToken: isLocal || (requestedChain === 84532 && process.env.ATS_DEPLOY_TEST_TOKEN === '1') };
  if (!execute) return { planOnly: true, chainId: requestedChain, administrator, observers, confirmations, usesTestToken: options.localTestToken, token: options.tokenAddress ?? null };
  const result = await deployContracts(options);
  fs.mkdirSync(path.join(root, 'artifacts'), { recursive: true });
  fs.writeFileSync(path.join(root, 'artifacts', `deployment.v2.${requestedChain}.json`), JSON.stringify(result.manifest, null, 2) + '\n', { mode: 0o600 });
  return result.manifest;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await deployConfigured({execute: process.argv.includes('--execute')}), null, 2)); }
  catch (error) { console.error(`Deployment stopped: ${String(error.shortMessage ?? error.message).replaceAll(process.env.ATS_DEPLOYER_PRIVATE_KEY ?? 'SECRET_NOT_CONFIGURED', '[REDACTED]')}`); process.exitCode = 1; }
}
