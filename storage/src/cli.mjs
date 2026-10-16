import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {createClient,createPublicClient,http,custom,getAddress} from 'viem';
import {privateKeyToAccount} from 'viem/accounts';
import {Synapse} from '@filoz/synapse-sdk';
import {calibration,mainnet} from '@filoz/synapse-core/chains';
import {json,networkPolicy,readPrivateKey,guardedAccount,units} from './policy.mjs';
import {snapshotFile,createPlan,executeUpload} from './adapter.mjs';
import {downloadVerified} from './download.mjs';
import {proofStatus} from './proof-status.mjs';

function argumentsFor(argv){
  const options={};for(let i=0;i<argv.length;i++){
    if(!argv[i].startsWith('--'))throw new Error('Only named options accepted');
    const key=argv[i].slice(2);if(['execute','allow-mainnet'].includes(key)){if(key in options)throw new Error('Duplicate option');options[key]=true;}
    else{if(key in options||!argv[i+1]||argv[i+1].startsWith('--'))throw new Error('Duplicate/missing option value');options[key]=argv[++i];}
  }
  const allowed=['execute','allow-mainnet','chain-id','rpc','file','address','copies','provider-ids','data-set-ids','output','plan','plan-hash','key-file','max-cost-units','max-monthly-units','receipt','confirmations','max-proof-age-epochs'];
  for(const k of Object.keys(options))if(!allowed.includes(k))throw new Error(`Unknown option --${k}`);return options;
}
async function readJSON(file){const s=await fs.stat(file);if(!s.isFile()||s.size>1024*1024)throw new Error('Input JSON must be regular <=1 MiB file');return JSON.parse(await fs.readFile(file,'utf8'));}
async function save(value,output){if(output)await fs.writeFile(output,json(value),{flag:'wx',mode:0o600});else console.log(json(value));}
export async function runCLI(argv=process.argv.slice(2)){
  const [command='help',...rest]=argv;
  if(command==='help'){console.log('ATS Filecoin adapter: plan --file FILE --address EVM [--output PLAN]; upload --file FILE --plan PLAN --plan-hash HASH --execute --key-file SECRET --max-cost-units N --max-monthly-units N --output RECEIPT; download --receipt RECEIPT --output FILE; proof-status --receipt RECEIPT. Defaults: Calibration 314159; read-only.');return;}
  if(!['plan','upload','download','proof-status'].includes(command))throw new Error('Unknown command');
  const o=argumentsFor(rest);
  if(command==='download'){if(!o.receipt||!o.output)throw new Error('Download requires --receipt and --output');console.log(json(await downloadVerified({receipt:await readJSON(o.receipt),destination:o.output})));return;}
  if(command==='upload'&&(!o.execute||!o.plan||!o['plan-hash']||!o['max-cost-units']||!o['max-monthly-units']||!o.output))throw new Error('Upload requires --execute, --plan, --plan-hash, both explicit budget bounds and --output receipt');
  const chainId=networkPolicy({chainId:o['chain-id']??314159,allowMainnet:o['allow-mainnet'],rpc:o.rpc});
  const chain=chainId===314159?calibration:mainnet;
  const rpc=o.rpc??chain.rpcUrls.default.http[0];
  // Read transport cannot send funds, grant permissions or ask an unlocked RPC wallet to sign.
  const publicClient=createPublicClient({chain,transport:http(rpc,{timeout:30000,retryCount:1})});
  const readTransport=custom({request:({method,params})=>{
    if(!['eth_chainId','eth_call','eth_getBalance','eth_getCode','eth_getBlockByNumber','eth_blockNumber','eth_getLogs','eth_getTransactionReceipt','eth_getTransactionByHash','eth_feeHistory','eth_gasPrice','eth_maxPriorityFeePerGas','eth_estimateGas','net_version'].includes(method))throw new Error('Adapter read transport refuses state-changing or signing RPC');
    return publicClient.request({method,params});
  }});
  const readClient=createPublicClient({chain,transport:readTransport});
  if(await readClient.getChainId()!==chainId)throw new Error('Actual RPC chain differs from requested network');
  if(command==='proof-status'){
    if(!o.receipt)throw new Error('Proof status requires --receipt');
    await save(await proofStatus({readClient,chain,receipt:await readJSON(o.receipt),confirmations:Number(o.confirmations??10),maxProofAgeEpochs:units(o['max-proof-age-epochs']??2880)}),o.output);return;
  }
  let account,setSigningIntent;
  let existingPlan;
  if(command==='upload'){
    if(!o.execute||!o.plan||!o['plan-hash']||!o['max-cost-units']||!o['max-monthly-units']||!o.output)throw new Error('Upload requires --execute, --plan, --plan-hash, both explicit budget bounds and --output receipt');
    // Do not incur a paid operation if the receipt cannot be created without overwrite.
    try{await fs.access(o.output);throw new Error('Receipt output already exists');}catch(e){if(e.code!=='ENOENT')throw e;}
    existingPlan=await readJSON(o.plan);
    const guarded=guardedAccount(privateKeyToAccount(await readPrivateKey(o['key-file'])),chain);account=guarded.account;setSigningIntent=guarded.setIntent;
  }else{if(o.execute||o['key-file'])throw new Error('Plan is strictly read-only; provide --address, never a key');account=getAddress(o.address);}
  const client=createClient({chain,account,transport:readTransport});
  const sdk=new Synapse({client,readClient,withCDN:false,pieceBatching:false,source:'ats-network-node'});
  const address=typeof account==='string'?account:account.address;
  const snapshot=await snapshotFile(o.file);
  try{
    if(command==='plan'){
      const ids=k=>o[k]?o[k].split(',').map(x=>units(x)):undefined;
      const {plan}=await createPlan({sdk,snapshot,chainId,address,copies:Number(o.copies??2),providerIds:ids('provider-ids'),dataSetIds:ids('data-set-ids')});await save(plan,o.output);
    }else{
      const outputHandle=await fs.open(o.output,'wx',0o600);
      try {
        const receipt=await executeUpload({sdk,snapshot,plan:existingPlan,expectedPlanHash:o['plan-hash'],chainId,address,execute:true,maxCostUnits:o['max-cost-units'],maxMonthlyUnits:o['max-monthly-units'],setSigningIntent});
        await outputHandle.writeFile(json(receipt));await outputHandle.sync();
        console.log(json({receipt:o.output,complete:receipt.complete,proofStatus:receipt.proofStatus}));
      } catch(error) {
        if(error.uploadReceipt){await outputHandle.truncate(0);await outputHandle.writeFile(json(error.uploadReceipt));await outputHandle.sync();}
        else await fs.rm(o.output,{force:true});
        throw error;
      } finally { await outputHandle.close(); }
    }
  }finally{await snapshot.cleanup();}
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{await runCLI();}catch(error){console.error(`Filecoin operation stopped: ${error.shortMessage??error.message}`);process.exitCode=1;}
}
