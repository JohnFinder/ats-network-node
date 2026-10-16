import { spawnSync, spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, chmodSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { HDNodeWallet } from '../services/node_modules/ethers/lib.esm/index.js';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const prefix = `ats-services-verify-${process.pid}`, network = `${prefix}-net`, temporary = mkdtempSync(path.join(os.tmpdir(), 'ats-services-docker-'));
const containers = [], volumes = [];
function docker(args, { quiet = true, fail = true } = {}) {
  const result = spawnSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0 && fail) throw new Error(`docker ${args.slice(0, 3).join(' ')} failed:\n${result.stderr?.slice(-8000)}\n${result.stdout?.slice(-8000)}`);
  if (!quiet && result.stdout) process.stdout.write(result.stdout); return ((result.stdout ?? '') + (args[0] === 'logs' ? (result.stderr ?? '') : '')).trim();
}
const pause = ms => new Promise(r => setTimeout(r, ms));
async function waitHTTP(container, url, expected = 200) {
  for (let i = 0; i < 180; i++) {
    const result = docker(['exec', container, 'node', '-e', `fetch(${JSON.stringify(url)}).then(async r=>{if(r.status!==${expected})process.exit(1);console.log(await r.text())}).catch(()=>process.exit(1))`], { fail: false });
    if (result && !result.includes('error')) { try { return JSON.parse(result); } catch {} }
    await pause(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
}
function volume(label) { const name = `${prefix}-${label}`; docker(['volume', 'create', name]); volumes.push(name); return name; }
function run(name, image, env = {}, mounts = [], command = []) {
  const actual = `${prefix}-${name}`;
  docker(['run', '-d', '--name', actual, '--network', network, '--network-alias', name, '--memory', '512m', ...Object.entries(env).flatMap(([k,v]) => ['-e', `${k}=${v}`]), ...mounts.flatMap(v => ['-v', v]), image, ...command]);
  containers.push(actual); return actual;
}
try {
  mkdirSync(path.join(temporary, 'deployment'), { mode: 0o777 }); chmodSync(path.join(temporary, 'deployment'), 0o777);
  mkdirSync(path.join(temporary, 'secrets'), { mode: 0o755 });
  const phrase = 'myth like bonus scare over problem client lizard pioneer submit female collect';
  const wallets = Array.from({length:6},(_,i)=>HDNodeWallet.fromPhrase(phrase, undefined, `m/44'/60'/0'/0/${i}`));
  for (let i=0;i<wallets.length;i++) writeFileSync(path.join(temporary,'secrets',`dev-${i}.key`), wallets[i].privateKey, {mode:0o644});
  console.log('Building isolated operator acceptance images…');
  docker(['build','-t',`${prefix}-contracts`,path.join(root,'contracts')]);
  docker(['build','-t',`${prefix}-services`,path.join(root,'services')]);
  docker(['build','-t',`${prefix}-node`,root]);
  docker(['network','create',network]);
  const chain = run('chain', `${prefix}-contracts`, {CHAIN_LISTEN:'0.0.0.0'});
  for(let i=0;i<60;i++){const r=docker(['exec',chain,'node','-e',"fetch('http://127.0.0.1:8545',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'eth_chainId',params:[]})}).then(r=>r.json()).then(r=>{if(r.result!=='0x539')process.exit(1);console.log('ready')}).catch(()=>process.exit(1))"],{fail:false});if(r==='ready')break;if(i===59)throw new Error('chain startup failed');await pause(500);}
  docker(['run','--rm','--network',network,'-e','ATS_CHAIN_RPC=http://chain:8545','-v',`${temporary}/deployment:/contracts/artifacts`,`${prefix}-contracts`,'node','scripts/deploy-v2.mjs','--execute']);
  const nodeData=volume('node');
  const node=run('node',`${prefix}-node`,{NODE_PUBLIC_URL:'http://node:8787',NODE_ALLOW_PRIVATE_PEERS:'1',NODE_PROVIDER_ADDRESS:wallets[1].address},[`${nodeData}:/data`]);
  const nodeInfo=await waitHTTP(node,'http://127.0.0.1:8787/v1/node');
  const env={SERVICE_RPC_URL:'http://chain:8545',SERVICE_CHAIN_ID:'1337',SERVICE_DEPLOYMENT_MANIFEST:'/deployment/deployment.v2.1337.json',SERVICE_ALLOW_HTTP:'true',SERVICE_CONFIRMATIONS:'0',SERVICE_POLL_MS:'250',SERVICE_APPROVED_NODES:JSON.stringify([{url:'http://node:8787',providerID:nodeInfo.providerID}]),SERVICE_DATA_DIR:'/data'};
  const mounts=[`${temporary}/deployment:/deployment:ro`,`${temporary}/secrets:/secrets:ro`];
  const services=run('services',`${prefix}-services`,{...env,SERVICE_PUBLIC_URL:'http://services:8790'},[...mounts,`${volume('services')}:/data`]);
  const info=await waitHTTP(services,'http://127.0.0.1:8790/health');
  docker(['rm','-f',node]);
  const nodeRestarted=run('node',`${prefix}-node`,{NODE_PUBLIC_URL:'http://node:8787',NODE_ALLOW_PRIVATE_PEERS:'1',NODE_PROVIDER_ADDRESS:wallets[1].address,NODE_SETTLEMENT_PUBLIC_KEYS:info.serviceID},[`${nodeData}:/data`]);
  await waitHTTP(nodeRestarted,'http://127.0.0.1:8787/v1/node');
  const operatorIntent=JSON.parse(docker(['exec',nodeRestarted,'node','src/bind-wallet.mjs','--services','http://services:8790','--wallet',wallets[1].address,'--service-id',info.serviceID,'--development-http']));
  if(operatorIntent.providerID!==nodeInfo.providerID)throw new Error('operator binding CLI identity mismatch');
  console.log('PASS operator binding CLI signs in-place and emits scoped external-wallet link');
  const approved=JSON.stringify([{url:'http://services:8790',serviceID:info.serviceID}]);
  for(let i=0;i<2;i++) run(`observer-${i+1}`,`${prefix}-services`,{...env,SERVICE_PUBLIC_URL:`http://observer-${i+1}:8790`,SERVICE_APPROVED_INDEXERS:approved,SERVICE_OBSERVER_KEY_FILE:`/secrets/dev-${i+3}.key`},[...mounts,`${volume(`observer-${i+1}`)}:/data`]);
  run('coordinator',`${prefix}-services`,{...env,SERVICE_PUBLIC_URL:'http://coordinator:8790',SERVICE_SETTLEMENT_KEY_FILE:'/secrets/dev-5.key'},[...mounts,`${volume('coordinator')}:/data`]);
  const check=run('checks',`${prefix}-services`,{SERVICE_RPC_URL:'http://chain:8545'},[...mounts,`${nodeData}:/provider:ro`],['node','scripts/verify-network.mjs']);
  console.log('Running real isolated multi-observer, funded-order and coordinator checks…');
  let logs='';
  for(let i=0;i<360;i++){
    const state=docker(['inspect','-f','{{.State.Status}}:{{.State.ExitCode}}',check]);
    logs=docker(['logs',check],{fail:false});
    if(state.startsWith('exited:')){if(state!=='exited:0')throw new Error(`Acceptance failed:\n${logs}\n${docker(['logs',check],{fail:false})}`);break;}
    if(i===359)throw new Error(`Acceptance timed out:\n${logs}`);await pause(1000);
  }
  console.log(logs);
  docker(['restart',services]); await waitHTTP(services,'http://127.0.0.1:8790/health');
  docker(['exec',services,'node','scripts/verify.mjs'],{quiet:false});
  docker(['exec','-e','SERVICE_DEPLOYMENT_MANIFEST=/deployment/deployment.v2.1337.json',services,'node','scripts/verify.mjs','--reorg'],{quiet:false});
  console.log(JSON.stringify({status:'passed',deployment:'isolated Docker local-chain only',checks:['two-independent-observer-identities','permissionless-coordinator','service-restart','reorg-rebuild', 'see fixture checks above']}));
} catch(error) {
  console.error(error.message);
  for(const container of containers) console.error(`${container}: ${docker(['logs','--tail','25',container],{fail:false}).slice(-6000)}`);
  process.exitCode=1;
} finally {
  for(const container of containers.reverse()) docker(['rm','-f',container],{fail:false});
  for(const name of volumes) docker(['volume','rm',name],{fail:false});
  docker(['network','rm',network],{fail:false});
  rmSync(temporary,{recursive:true,force:true});
}
