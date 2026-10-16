// Self-contained local-chain acceptance. No external RPC or real assets are used.
import assert from 'node:assert/strict';
import ganache from 'ganache';
import { TypedDataEncoder, keccak256, toUtf8Bytes, ZeroHash } from 'ethers';
import { deployV2Local } from './deploy-v2-local.mjs';
import { tx, advance } from './local-chain.mjs';
const local=ganache.server({chain:{chainId:1337,hardfork:'shanghai'},wallet:{deterministic:true},logging:{quiet:true}});
await local.listen(0,'127.0.0.1');
process.env.ATS_CHAIN_RPC=`http://127.0.0.1:${local.address().port}`;
let provider;let checks=0;
const pass=x=>{checks++;console.log(`PASS ${x}`);};
const hash=x=>keccak256(toUtf8Bytes(x));
async function rejects(label,fn){let rejected=false;try{const result=await fn();if(result?.wait)await result.wait();}catch{rejected=true;}assert(rejected,label);pass(label);}
try{
  const deployed=await deployV2Local();({provider}=deployed);
  const {signers,addresses,token,identity,registry,storage,tasks}=deployed;
  const now=async()=>Number((await provider.getBlock('latest')).timestamp);
  const typed=(wallet,domain,types,value)=>provider.send('eth_signTypedData_v4',[wallet,TypedDataEncoder.getPayload(domain,types,value)]);
  const domain=async(name,contract)=>({name,version:'1',chainId:1337,verifyingContract:await contract.getAddress()});
  const bindTypes={Bind:[{name:'wallet',type:'address'},{name:'fingerprint',type:'bytes32'},{name:'edProofHash',type:'bytes32'},{name:'nonce',type:'uint256'},{name:'expiresAt',type:'uint64'}]};
  for(const i of [1,2]){const value={wallet:addresses[i],fingerprint:hash(`testfp${i}`),edProofHash:hash(`testproof${i}`),nonce:0,expiresAt:await now()+365*86400};await tx(identity.bindFor(value.wallet,value.fingerprint,value.edProofHash,0,value.expiresAt,await typed(value.wallet,await domain('ATSIdentityRegistry',identity),bindTypes,value)));}
  const pubTypes={Publish:[{name:'wallet',type:'address'},{name:'archiveHash',type:'bytes32'},{name:'metadataHash',type:'bytes32'},{name:'previous',type:'bytes32'},{name:'royaltiesHash',type:'bytes32'},{name:'nonce',type:'uint256'},{name:'expiresAt',type:'uint64'}]};
  const recipients=[addresses[2],addresses[0]],bps=[8000,2000];
  async function publish(label,nonce){const value={wallet:addresses[2],archiveHash:hash(label),metadataHash:hash(`metadata${label}`),previous:ZeroHash,royaltiesHash:await registry.royaltiesHash(recipients,bps),nonce,expiresAt:await now()+3600};await tx(registry.publishFor(value.wallet,value.archiveHash,value.metadataHash,ZeroHash,recipients,bps,nonce,value.expiresAt,await typed(value.wallet,await domain('ATSPublicationRegistry',registry),pubTypes,value)));return {id:await registry.publicationID(value.wallet,value.archiveHash),hash:value.archiveHash};}
  const publication=await publish('retained-publication',0),other=await publish('different-publication',1);
  // The ordinary 20% milestone remains independent of the 80% retained-service milestone.
  const deadline=await now()+40*86400;
  await tx(tasks.openTask(hash('milestone1-content-acceptance'),20,deadline));
  await tx(tasks.openRetainedTask(hash('milestone2-thirty-service-days'),80,deadline,30*86400));
  for(const i of [3,4])await tx(tasks.connect(signers[i]).attestTask(1,publication.id,hash('accepted-content')));
  await advance(provider,61);const plainBefore=await token.balanceOf(addresses[2]);await tx(tasks.claimTask(1));assert.equal(await token.balanceOf(addresses[2]),plainBefore+16n);pass('independently prefunded first milestone pays before retained milestone');
  await tx(storage.connect(signers[1]).stake(100000000000000000000n));
  const quoteTypes={Quote:[{name:'requester',type:'address'},{name:'provider',type:'address'},{name:'publicationId',type:'bytes32'},{name:'archiveHash',type:'bytes32'},{name:'start',type:'uint64'},{name:'end',type:'uint64'},{name:'period',type:'uint64'},{name:'amount',type:'uint256'},{name:'salt',type:'bytes32'},{name:'expiresAt',type:'uint64'}]};
  const start=await now()+120,day=86400;
  async function order(p,label){const q={requester:addresses[0],provider:addresses[1],publicationId:p.id,archiveHash:p.hash,start,end:start+32*day,period:day,amount:3200,salt:hash(label),expiresAt:start-10};const id=await storage.nextOrder();await tx(storage.openOrder(q,await typed(addresses[1],await domain('ATSStorageMarket',storage),quoteTypes,q)));return id;}
  const acceptedOrder=await order(publication,'good-order'),wrongPublication=await order(other,'wrong-publication'),otherOrder=await order(publication,'unused-order');
  await rejects('retained task cannot bypass service requirement using ordinary attest API',()=>tasks.connect(signers[3]).attestTask(2,publication.id,hash('evidence')));
  await rejects('retained task rejects an order for a different publication',()=>tasks.connect(signers[3]).attestRetainedTask(2,publication.id,hash('evidence'),wrongPublication));
  const evidence=hash('content-and-retention-evidence');
  assert.notEqual(await tasks.retainedCandidateHash(2,publication.id,evidence,acceptedOrder),await tasks.retainedCandidateHash(2,publication.id,evidence,otherOrder));
  await tx(tasks.connect(signers[3]).attestRetainedTask(2,publication.id,evidence,otherOrder));
  for(const i of [4,3])await tx(tasks.connect(signers[i]).attestRetainedTask(2,publication.id,evidence,acceptedOrder));
  assert.equal(await tasks.retentionOrder(2),acceptedOrder);pass('candidate commits order ID and a wrong first vote cannot poison valid threshold');
  await advance(provider,61);
  await rejects('review delay alone never unlocks thirty-day availability award',()=>tasks.claimTask(2));
  async function settle(index,successful){const to=start+(index+1)*day;await advance(provider,Math.max(0,to+1-await now()));const report={orderId:acceptedOrder,periodIndex:index,from:start+index*day,to,observedAt:await now(),samples:10,successful,evidenceHash:hash(`sample-period-${index}`)};for(const i of [3,4])await tx(storage.connect(signers[i]).attestPeriod(report));await advance(provider,61);await tx(storage.settlePeriod(acceptedOrder));}
  await settle(0,0);
  await tx(tasks.openRetainedTask(hash('late-task-cannot-reuse-history'),1,deadline,30*day));
  await rejects('retained task cannot reuse a service order that started before task funding',()=>tasks.connect(signers[3]).attestRetainedTask(3,publication.id,evidence,acceptedOrder));
  assert.equal(await storage.paidServiceSeconds(acceptedOrder),0n);pass('failed settled period earns zero service seconds');
  await settle(1,5);assert.equal(await storage.paidServiceSeconds(acceptedOrder),BigInt(day/2));pass('partial service accrues only its settled successful fraction');
  for(let index=2;index<31;index++)await settle(index,10);
  assert.equal(await storage.paidServiceSeconds(acceptedOrder),BigInt(29.5*day));
  await rejects('over thirty calendar days still cannot claim with less than thirty successful service days',()=>tasks.claimTask(2));
  await settle(31,10);assert.equal(await storage.paidServiceSeconds(acceptedOrder),BigInt(30.5*day));
  assert.equal(await storage.paidServiceSeconds(otherOrder),0n);pass('parallel or unused orders do not accelerate accepted-order service clock');
  const beforePublisher=await token.balanceOf(addresses[2]),beforeSponsor=await token.balanceOf(addresses[0]);
  await tx(tasks.claimTask(2));assert.equal(await token.balanceOf(addresses[2]),beforePublisher+64n);assert.equal(await token.balanceOf(addresses[0]),beforeSponsor+16n);assert.equal(await tasks.escrow(),1n);pass('earned retained milestone pays immutable publication split and clears funded escrow');
  await rejects('retained milestone cannot pay twice',()=>tasks.claimTask(2));
  await advance(provider,Math.max(0,deadline+121-await now()));await tx(tasks.refundTask(3));assert.equal(await tasks.escrow(),0n);pass('unfulfilled retained milestone refunds only its own prefunded escrow on expiry');
  console.log(JSON.stringify({status:'passed',checks,kind:'LOCAL TEST TOKEN ONLY',policy:'cumulative-successful-paid-service-seconds-per-single-order',minimumSeconds:30*day,limits:['Trusted observer committee','No independent replica proof','Not necessarily consecutive uptime','Explicit sponsor funding per milestone']}));
}finally{if(provider)await provider.destroy();await local.close();}
