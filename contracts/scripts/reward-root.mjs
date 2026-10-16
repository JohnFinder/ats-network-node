import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {AbiCoder, getAddress, keccak256, concat, ZeroAddress} from 'ethers';

const uint=(value)=>{if(!/^(0|[1-9][0-9]*)$/.test(String(value)))throw new Error('Canonical unsigned integer required');const n=BigInt(value);if(n>=2n**256n)throw new Error('Integer range');return n;};
const hash=(value)=>{if(!/^0x[0-9a-fA-F]{64}$/.test(value))throw new Error('Expected bytes32');return value.toLowerCase();};
export function rewardRoot(input){
  if(!Array.isArray(input.claims)||input.claims.length<1||input.claims.length>100000)throw new Error('1..100000 claims');
  const chainId=uint(input.chainId),epoch=uint(input.epoch),budget=uint(input.budget),vault=getAddress(input.vault);
  if(chainId===0n||epoch===0n||budget===0n||vault===ZeroAddress)throw new Error('Empty domain/budget');
  const caps=Object.fromEntries(Object.entries(input.categoryCaps??{}).map(([k,v])=>[k,uint(v)]));
  if(Object.keys(caps).length===0||Object.values(caps).reduce((a,b)=>a+b,0n)>budget)throw new Error('Category caps must fit fixed budget');
  const usedIndex=new Set(),usedAwards=new Set(),categoryUsed={};let total=0n;
  const claims=input.claims.map(c=>{
    const index=uint(c.index),recipient=getAddress(c.recipient),amount=uint(c.amount),evidenceHash=hash(c.evidenceHash),awardID=hash(c.awardID);
    if(usedIndex.has(String(index))||usedAwards.has(awardID)||recipient===ZeroAddress||amount===0n||evidenceHash==='0x'+'0'.repeat(64)||awardID==='0x'+'0'.repeat(64))throw new Error('Duplicate/empty claim');
    if(!(c.category in caps))throw new Error('Unbudgeted category');
    usedIndex.add(String(index));usedAwards.add(awardID);total+=amount;categoryUsed[c.category]=(categoryUsed[c.category]??0n)+amount;
    if(categoryUsed[c.category]>caps[c.category]||total>budget)throw new Error('Budget exceeded; rejected rather than reallocating unused awards');
    const leaf=keccak256(keccak256(AbiCoder.defaultAbiCoder().encode(['uint256','address','uint256','uint256','address','uint256','bytes32'],[chainId,vault,epoch,index,recipient,amount,evidenceHash])));
    return {index:String(index),recipient,amount:String(amount),evidenceHash,awardID,category:c.category,leaf};
  });
  const sorted=claims.map((c,i)=>({...c,original:i})).sort((a,b)=>a.leaf.localeCompare(b.leaf));
  const tree=Array(2*claims.length-1);
  for(let i=0;i<sorted.length;i++){tree[tree.length-1-i]=sorted[i].leaf;sorted[i].treeIndex=tree.length-1-i;}
  for(let i=claims.length-2;i>=0;i--)tree[i]=keccak256(concat([tree[2*i+1],tree[2*i+2]].sort()));
  for(const c of sorted){let i=c.treeIndex;const proof=[];while(i>0){proof.push(tree[i%2===0?i-1:i+1]);i=Math.floor((i-1)/2);}claims[c.original].proof=proof;}
  return {schemaVersion:1,chainId:String(chainId),vault,epoch:String(epoch),root:tree[0],budget:String(budget),allocated:String(total),unallocated:String(budget-total),categoryCaps:Object.fromEntries(Object.entries(caps).map(([k,v])=>[k,String(v)])),claims,trust:'Root selection and evidence interpretation remain a disclosed trusted governance process; this builder does not certify service or identity.'};
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{const file=process.argv[2];if(!file||fs.statSync(file).size>16*1024*1024)throw new Error('Provide JSON input <=16 MiB');console.log(JSON.stringify(rewardRoot(JSON.parse(fs.readFileSync(file,'utf8'))),null,2));}
  catch(e){console.error(`Reward root refused: ${e.message}`);process.exitCode=1;}
}
