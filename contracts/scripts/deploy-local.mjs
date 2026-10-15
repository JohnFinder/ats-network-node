import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ContractFactory, parseEther, MaxUint256 } from 'ethers';
import { compile, root } from './compile.mjs';
import { connectLocal, tx } from './local-chain.mjs';

export async function deployLocal() {
  const { provider, signers } = await connectLocal();
  const addresses = await Promise.all(signers.map(s => s.getAddress()));
  const artifacts = compile();
  const token = await new ContractFactory(artifacts.ATNTestToken.abi, artifacts.ATNTestToken.bytecode, signers[0]).deploy(addresses[0]);
  await token.waitForDeployment();
  const market = await new ContractFactory(artifacts.ATSServiceMarket.abi, artifacts.ATSServiceMarket.bytecode, signers[0])
    .deploy(await token.getAddress(), addresses[0], addresses.slice(3), 2, parseEther('10'), 60, 60);
  await market.waitForDeployment();
  await tx(token.transfer(addresses[1], parseEther('1000')));
  await tx(token.transfer(addresses[2], parseEther('1000')));
  await tx(token.approve(await market.getAddress(), MaxUint256));
  await tx(token.connect(signers[1]).approve(await market.getAddress(), MaxUint256));
  const deployment = {
    schemaVersion: 1, network: 'LOCAL TEST ONLY', chainId: 1337,
    token: await token.getAddress(), market: await market.getAddress(),
    administrator: addresses[0], provider: addresses[1], publisher: addresses[2], attestors: addresses.slice(3),
    approvalThreshold: 2, reviewSeconds: 60, unbondSeconds: 60,
    supply: (await token.totalSupply()).toString(), deployedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(root, 'artifacts', 'deployment.local.json'), `${JSON.stringify(deployment, null, 2)}\n`);
  return { provider, signers, addresses, token, market, deployment };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify((await deployLocal()).deployment, null, 2));
}
