import fs from 'node:fs';
import path from 'node:path';
import { createHash, createPublicKey, verify as verifyEd25519 } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Contract, JsonRpcProvider, getAddress, keccak256, verifyTypedData } from 'ethers';
import { root } from './compile.mjs';

export const bindingTypes = { Bind: [
  {name:'wallet',type:'address'}, {name:'fingerprint',type:'bytes32'}, {name:'edProofHash',type:'bytes32'}, {name:'nonce',type:'uint256'}, {name:'expiresAt',type:'uint64'}
] };
export function bindingStatement({chainId, registry, wallet, fingerprint, nonce, expiresAt}) {
  return `ATS-WALLET-BIND-V1\n${BigInt(chainId)}\n${getAddress(registry).toLowerCase()}\n${getAddress(wallet).toLowerCase()}\n${fingerprint.replace(/^0x/,'').toLowerCase()}\n${BigInt(nonce)}\n${BigInt(expiresAt)}`;
}
export function prepareBinding({chainId, registry, wallet, publicKey, nonce, expiresAt}) {
  const rawKey = Buffer.from(publicKey, 'base64');
  if (rawKey.length !== 32 || rawKey.toString('base64') !== publicKey) throw new Error('Canonical raw32 Ed25519 key base64 required');
  const fingerprint = `0x${createHash('sha256').update(rawKey).digest('hex')}`;
  const input = {chainId:Number(chainId), registry:getAddress(registry), wallet:getAddress(wallet), fingerprint, nonce:String(nonce), expiresAt:Number(expiresAt)};
  if (!Number.isSafeInteger(input.chainId) || input.chainId <= 0 || !Number.isSafeInteger(input.expiresAt)) throw new Error('Numeric range');
  return {schemaVersion:1, ...input, publicKey, statement:bindingStatement(input)};
}
export function walletRequest(prepared, edSignature) {
  const signature = Buffer.from(edSignature, 'base64');
  if (signature.length !== 64 || signature.toString('base64') !== edSignature) throw new Error('Canonical Ed25519 signature base64 required');
  const expected = prepareBinding(prepared);
  if (prepared.statement !== expected.statement) throw new Error('Binding statement mismatch');
  const key = createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),Buffer.from(prepared.publicKey,'base64')]),format:'der',type:'spki'});
  if (!verifyEd25519(null, Buffer.from(expected.statement,'utf8'), key, signature)) throw new Error('Ed25519 signature invalid');
  const value = {wallet:expected.wallet,fingerprint:expected.fingerprint,edProofHash:keccak256(signature),nonce:expected.nonce,expiresAt:expected.expiresAt};
  return {...expected, edSignature, domain:{name:'ATSIdentityRegistry',version:'1',chainId:expected.chainId,verifyingContract:expected.registry},types:bindingTypes,value};
}
export function verifyBinding(request, {now = Math.floor(Date.now()/1000)} = {}) {
  const expected = walletRequest(request, request.edSignature);
  if (JSON.stringify(request.domain) !== JSON.stringify(expected.domain) || JSON.stringify(request.types) !== JSON.stringify(bindingTypes) || JSON.stringify(request.value) !== JSON.stringify(expected.value)) throw new Error('EIP-712 domain/types/value mismatch');
  if (expected.expiresAt <= now || expected.expiresAt > now+366*86400) throw new Error('Expired/overlong binding');
  if (getAddress(verifyTypedData(expected.domain,bindingTypes,expected.value,request.walletSignature)) !== expected.wallet) throw new Error('Wallet signature invalid');
  return {...expected, walletSignature:request.walletSignature};
}
async function cli() {
  const [mode, inputFile] = process.argv.slice(2);
  if (!['statement','wallet-request','verify','submit'].includes(mode) || !inputFile) throw new Error('Usage: binding.mjs statement|wallet-request|verify|submit INPUT.json');
  const input = JSON.parse(fs.readFileSync(inputFile,'utf8'));
  if (mode === 'statement') return prepareBinding(input);
  if (mode === 'wallet-request') return walletRequest(input,input.edSignature);
  const verified = verifyBinding(input);
  if (mode === 'verify') return {valid:true,wallet:verified.wallet,fingerprint:verified.fingerprint,expiresAt:verified.expiresAt};
  const rpc = new URL(process.env.ATS_CHAIN_RPC ?? 'http://127.0.0.1:8545');
  if (rpc.username || rpc.password || (rpc.protocol !== 'https:' && !(verified.chainId === 1337 && rpc.protocol === 'http:' && ['127.0.0.1','localhost','chain'].includes(rpc.hostname)))) throw new Error('Unsafe RPC');
  const provider = new JsonRpcProvider(rpc.href);
  if ((await provider.getNetwork()).chainId !== BigInt(verified.chainId)) throw new Error('Wrong chain');
  // Only local development may use unlocked RPC accounts. Public networks use the services relay
  // or wallet eth_sendTransaction; this helper deliberately never accepts an EVM private key.
  if (verified.chainId !== 1337) throw new Error('Submit signed request to an operator relay or your external wallet; no public unlocked-account signing');
  const abi = JSON.parse(fs.readFileSync(path.join(root,'artifacts','ATSIdentityRegistry.json'),'utf8')).abi;
  const registry = new Contract(verified.registry,abi,await provider.getSigner(0));
  if (await registry.nonces(verified.wallet) !== BigInt(verified.nonce)) throw new Error('Nonce already consumed');
  const receipt = await (await registry.bindFor(verified.wallet,verified.fingerprint,verified.value.edProofHash,verified.nonce,verified.expiresAt,verified.walletSignature)).wait();
  return {transactionHash:receipt.hash,blockNumber:receipt.blockNumber};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { console.log(JSON.stringify(await cli(),null,2)); } catch(error) { console.error(`Binding stopped: ${error.shortMessage ?? error.message}`); process.exitCode=1; }
}
