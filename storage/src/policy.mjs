import fs from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {getAddress} from 'viem';
export const MAX_FILE_BYTES=1024*1024*1024;
export const json=value=>JSON.stringify(value,(_key,v)=>typeof v==='bigint'?v.toString():v,2)+'\n';
export const digest=value=>createHash('sha256').update(json(value)).digest('hex');
export function units(value,name='amount'){
  if(!/^(0|[1-9][0-9]*)$/.test(String(value)))throw new Error(`${name} must use canonical nonnegative integer units`);
  const n=BigInt(value);if(n>=2n**256n)throw new Error(`${name} too large`);return n;
}
export function networkPolicy({chainId=314159,allowMainnet=false,rpc}){
  const id=Number(chainId);
  if(id!==314159&&!(id===314&&allowMainnet))throw new Error('Calibration 314159 only by default; mainnet 314 requires explicit --allow-mainnet');
  if(rpc){const u=new URL(rpc);if(u.protocol!=='https:'||u.username||u.password)throw new Error('RPC requires HTTPS without URL credentials');}
  return id;
}
export function contextDescription(contexts){
  if(!Array.isArray(contexts)||contexts.length<1||contexts.length>4)throw new Error('1..4 contexts required');
  const rows=contexts.map(c=>({providerId:String(c.provider.id),provider:getAddress(c.serviceProvider),dataSetId:c.dataSetId===undefined?null:String(c.dataSetId),serviceURL:c.provider.pdp.serviceURL,withCDN:Boolean(c.withCDN)}));
  if(new Set(rows.map(r=>r.providerId)).size!==rows.length)throw new Error('Duplicate provider contexts');
  for(const r of rows){const url=new URL(r.serviceURL);if(url.protocol!=='https:'||url.username||url.password)throw new Error('Storage provider must offer HTTPS');}
  return rows;
}
export function costSummary(costs){
  const output={perEpoch:units(costs.rates.perEpoch),perMonth:units(costs.rates.perMonth),fees:units(costs.fees.total),lockups:units(costs.lockups.total),depositNeeded:units(costs.depositNeeded),needsFwssMaxApproval:Boolean(costs.needsFwssMaxApproval),ready:Boolean(costs.ready)};
  output.conservative30DayEstimate=output.fees+output.lockups+output.perMonth;
  return output;
}
export function enforceUpload({execute,maxCostUnits,maxMonthlyUnits,costs,accountBalance,plan,expectedPlanHash,file,contexts,chainId,address,now=Date.now()}){
  if(!execute)throw new Error('Paid upload disabled without --execute');
  if(maxCostUnits===undefined||maxMonthlyUnits===undefined)throw new Error('Explicit --max-cost-units and --max-monthly-units required');
  const max=units(maxCostUnits),monthly=units(maxMonthlyUnits);if(max===0n||monthly===0n)throw new Error('Budget must be positive');
  const {planHash,...committed}=plan??{};
  if(!/^[a-f0-9]{64}$/.test(expectedPlanHash??'')||planHash!==expectedPlanHash||digest(committed)!==expectedPlanHash)throw new Error('Explicit plan hash differs from exact plan contents');
  if(committed.schemaVersion!==1||committed.chainId!==chainId||getAddress(committed.account)!==getAddress(address))throw new Error('Plan domain/account mismatch');
  if(!Number.isSafeInteger(committed.expiresAt)||committed.expiresAt<=now||committed.expiresAt>now+15*60*1000)throw new Error('Plan expired or expiry out of bounds');
  if(committed.file.sha256!==file.sha256||committed.file.byteCount!==file.byteCount||committed.file.pieceCid!==file.pieceCid)throw new Error('File changed since quote');
  if(JSON.stringify(committed.contexts)!==JSON.stringify(contexts))throw new Error('Selected providers/datasets differ from quoted contexts');
  const summary=costSummary(costs);
  if(summary.conservative30DayEstimate>max||summary.perMonth>monthly)throw new Error('Current quoted costs exceed explicit budget');
  if(units(accountBalance)>max)throw new Error('Use an isolated prefunded account whose escrow is within max-cost-units');
  if(!summary.ready||summary.depositNeeded>0n||summary.needsFwssMaxApproval)throw new Error('Account not prepared: fund/review approvals externally; this adapter never deposits or grants approvals');
  return summary;
}
export async function readPrivateKey(file){
  if(!file)throw new Error('Upload requires --key-file pointing to an operator-owned secret file');
  const stat=await fs.lstat(file);
  if(!stat.isFile()||stat.isSymbolicLink()||stat.size>256||(stat.mode&0o077)!==0)throw new Error('Secret must be a regular non-symlink file, <=256 bytes, mode 0600/0400');
  const value=(await fs.readFile(file,'utf8')).trim();
  if(!/^0x[a-fA-F0-9]{64}$/.test(value))throw new Error('Secret must contain one hex secp256k1 private key');return value;
}
export function guardedAccount(account,chain){
  let allowedProviders=new Set(),pieceHex=null,calls=0;
  const deny=async()=>{throw new Error('Adapter forbids transaction/message signing and approval/deposit operations');};
  return {setIntent({providers,pieceBytes}){allowedProviders=new Set(providers.map(x=>getAddress(x)));pieceHex='0x'+Buffer.from(pieceBytes).toString('hex');},account:{...account,signMessage:deny,signTransaction:deny,signAuthorization:deny,
    async signTypedData(data){
      if(++calls>32||!pieceHex||data.domain?.name!=='FilecoinWarmStorageService'||String(data.domain?.version)!=='1'||Number(data.domain?.chainId)!==chain.id||getAddress(data.domain?.verifyingContract)!==getAddress(chain.contracts.fwss.address))throw new Error('Unexpected storage signing domain');
      if(data.primaryType==='CreateDataSet'){
        if(!allowedProviders.has(getAddress(data.message.payee)))throw new Error('Unquoted provider signing request');
      }else if(data.primaryType==='AddPieces'){
        if(data.message.pieceData?.length!==1||data.message.pieceData[0].data.toLowerCase()!==pieceHex)throw new Error('Unquoted piece signing request');
      }else throw new Error('Only CreateDataSet/AddPieces EIP-712 signatures allowed');
      return account.signTypedData(data);
    }
  }};
}
