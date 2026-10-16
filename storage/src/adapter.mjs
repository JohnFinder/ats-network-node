import fs from 'node:fs/promises';
import {createReadStream,createWriteStream,constants} from 'node:fs';
import {Readable,Transform} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import * as Piece from '@filoz/synapse-core/piece';
import {MAX_FILE_BYTES,json,digest,contextDescription,enforceUpload,costSummary} from './policy.mjs';

export async function snapshotFile(source,{maximumBytes=MAX_FILE_BYTES}={}){
  const sourceHandle=await fs.open(source,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  let directory;
  try{
    const stat=await sourceHandle.stat();
    if(!stat.isFile()||stat.size<127||stat.size>maximumBytes)throw new Error('Source must be regular file, 127 bytes..configured maximum (default 1 GiB)');
    directory=await fs.mkdtemp(path.join(os.tmpdir(),'ats-filecoin-'));await fs.chmod(directory,0o700);
    const target=path.join(directory,'snapshot');const sha=createHash('sha256');let count=0;
    const bounded=new Transform({transform(chunk,_encoding,done){count+=chunk.length;if(count>maximumBytes)return done(new Error('Snapshot exceeds bound'));sha.update(chunk);done(null,chunk);}});
    await pipeline(sourceHandle.createReadStream({autoClose:false}),bounded,createWriteStream(target,{flags:'wx',mode:0o600}));
    if(count!==stat.size)throw new Error('Source size changed during snapshot');
    const pieceCid=await Piece.calculate(createReadStream(target));
    return {path:target,file:{sha256:sha.digest('hex'),byteCount:count,pieceCid:pieceCid.toString()},pieceCid,cleanup:()=>fs.rm(directory,{recursive:true,force:true})};
  }catch(e){if(directory)await fs.rm(directory,{recursive:true,force:true});throw e;}
  finally{await sourceHandle.close();}
}

export async function createPlan({sdk,snapshot,chainId,address,copies=2,providerIds,dataSetIds,now=Date.now()}){
  if(!Number.isInteger(copies)||copies<1||copies>4)throw new Error('1..4 copies required');
  const contexts=await sdk.storage.createContexts({copies,providerIds,dataSetIds,withCDN:false,metadata:{application:'ats-network'}});
  const selected=contextDescription(contexts);
  if(selected.length!==copies)throw new Error('Provider count differs from requested copies');
  const costs=await sdk.storage.calculateMultiContextCosts(contexts,{pieceSizes:[BigInt(snapshot.file.byteCount)]});
  const summary=JSON.parse(json(costSummary(costs)));
  const committed={schemaVersion:1,adapter:'@filoz/synapse-sdk@2.0.2',chainId,account:address,file:snapshot.file,contexts:selected,costs:summary,createdAt:now,expiresAt:now+15*60*1000,proofStatus:'not-verified',pricePolicy:'Read-only estimate; service rates recur until external termination. No deposit or approval performed.'};
  return {plan:{...committed,planHash:digest(committed)},contexts,costs};
}
export async function executeUpload({sdk,snapshot,plan,expectedPlanHash,chainId,address,execute,maxCostUnits,maxMonthlyUnits,setSigningIntent,now=Date.now()}){
  // Select exactly the quoted providers. Dataset identity is compared before any signature/upload.
  const requested=plan.contexts;
  if(!Array.isArray(requested)||requested.length<1||requested.length>4)throw new Error('Invalid plan contexts');
  const contexts=await sdk.storage.createContexts({copies:requested.length,providerIds:requested.map(c=>BigInt(c.providerId)),withCDN:false,metadata:{application:'ats-network'}});
  const selected=contextDescription(contexts);
  const costs=await sdk.storage.calculateMultiContextCosts(contexts,{pieceSizes:[BigInt(snapshot.file.byteCount)]});
  const balance=await sdk.payments.balance();
  const current=enforceUpload({execute,maxCostUnits,maxMonthlyUnits,costs,accountBalance:balance,plan,expectedPlanHash,file:snapshot.file,contexts:selected,chainId,address,now});
  setSigningIntent({providers:selected.map(c=>c.provider),pieceBytes:snapshot.pieceCid.bytes});
  const transactions=[];
  let result;
  try { result=await sdk.storage.upload(Readable.toWeb(createReadStream(snapshot.path)),{
    contexts,pieceCid:snapshot.pieceCid,pieceMetadata:{'ats-sha256':snapshot.file.sha256},
    callbacks:{onPiecesAdded:(transaction,providerId)=>transactions.push({transactionHash:transaction,providerId:String(providerId)})}
  });
  } catch (error) { error.uploadReceipt={schemaVersion:1,adapter:'@filoz/synapse-sdk@2.0.2',chainId,account:address,planHash:expectedPlanHash,...snapshot.file,pieceCid:snapshot.file.pieceCid,complete:false,copies:[],transactions,needsReconciliation:true,proofStatus:'not-verified',createdAt:new Date().toISOString()};throw error; }
  if(result.pieceCid.toString()!==snapshot.file.pieceCid||result.size!==snapshot.file.byteCount){const error=new Error('Provider result differs from committed upload bytes');error.uploadReceipt={schemaVersion:1,chainId,account:address,planHash:expectedPlanHash,...snapshot.file,complete:false,copies:[],transactions,needsReconciliation:true,proofStatus:'not-verified'};throw error;}
  // Keep a receipt even when one copy fails; no fabricated success or verified-proof flag.
  return {schemaVersion:1,adapter:'@filoz/synapse-sdk@2.0.2',chainId,account:address,planHash:expectedPlanHash,sha256:snapshot.file.sha256,byteCount:snapshot.file.byteCount,pieceCid:result.pieceCid.toString(),complete:result.complete,requestedCopies:result.requestedCopies,copies:result.copies.map(c=>({...c,providerId:String(c.providerId),dataSetId:String(c.dataSetId),pieceId:String(c.pieceId),provider:selected.find(p=>p.providerId===String(c.providerId))?.provider??null})),transactions,failedAttempts:result.failedAttempts.map(f=>({providerId:String(f.providerId),role:f.role,error:'Provider copy failed; inspect operator logs',explicit:Boolean(f.explicit)})),costsAtSubmission:JSON.parse(json(current)),createdAt:new Date().toISOString(),proofStatus:'not-verified',limits:['Transaction commitment is not proof of ongoing storage','No automatic deposit, approval, renewal or termination','Estimated budget is not a contract-enforced fiat price ceiling']};
}
