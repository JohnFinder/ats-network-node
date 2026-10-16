import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEther, MaxUint256 } from 'ethers';
import { root, compile } from './compile.mjs';
import { deployContracts } from './deploy-v2.mjs';
import { connectLocal, tx } from './local-chain.mjs';
export async function deployV2Local() {
  const artifacts = compile();
  const {provider,signers} = await connectLocal();
  const addresses = await Promise.all(signers.map(s=>s.getAddress()));
  const deployed = await deployContracts({artifacts,provider,signer:signers[0],administrator:addresses[0],observers:addresses.slice(3),reviewSeconds:60,reportGraceSeconds:3600,unbondSeconds:60,localTestToken:true});
  for (const i of [1,2]) await tx(deployed.token.transfer(addresses[i],parseEther('1000')));
  for (const i of [0,1,2]) for (const target of [deployed.registry,deployed.storage,deployed.tasks,deployed.rewards]) await tx(deployed.token.connect(signers[i]).approve(await target.getAddress(),MaxUint256));
  fs.writeFileSync(path.join(root,'artifacts','deployment.v2.local.json'),JSON.stringify(deployed.manifest,null,2)+'\n');
  return {...deployed,signers,addresses};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) console.log(JSON.stringify((await deployV2Local()).manifest,null,2));
