import * as Piece from '@filoz/synapse-core/piece';
import {findPieceIdsByCidCall} from '@filoz/synapse-core/pdp-verifier';
import {getDataSetCall} from '@filoz/synapse-core/warm-storage';
import {getAddress,keccak256} from 'viem';
import {units} from './policy.mjs';

/// Read a confirmed chain snapshot; this is NOT an ATS consensus proof verifier/oracle.
export async function proofStatus({readClient,chain,receipt,confirmations=10,maxProofAgeEpochs=2880n}){
  if(receipt.chainId!==chain.id||receipt.schemaVersion!==1||!Piece.tryFrom(receipt.pieceCid)||!Array.isArray(receipt.copies)||receipt.copies.length<1||receipt.copies.length>4)throw new Error('Invalid chain-bound receipt');
  if(!Number.isInteger(confirmations)||confirmations<1||confirmations>3000)throw new Error('Confirmation policy');
  maxProofAgeEpochs=units(maxProofAgeEpochs);if(maxProofAgeEpochs<1n||maxProofAgeEpochs>86400n)throw new Error('Proof age policy');
  const latest=await readClient.getBlockNumber();if(latest<BigInt(confirmations))throw new Error('Chain too young');
  const blockNumber=latest-BigInt(confirmations-1);const before=await readClient.getBlock({blockNumber});
  const copies=[];const piece=Piece.from(receipt.pieceCid);
  for(const copy of receipt.copies){
    const dataSetId=units(copy.dataSetId),pieceId=units(copy.pieceId),providerId=units(copy.providerId);
    const base={address:chain.contracts.pdp.address,abi:chain.contracts.pdp.abi,blockNumber};
    const [live,pieceIds,lastProven,nextChallenge,providers,dataSet]=await Promise.all([
      readClient.readContract({...base,functionName:'dataSetLive',args:[dataSetId]}),
      readClient.readContract({...findPieceIdsByCidCall({chain,dataSetId,pieceCid:piece,startPieceId:0n,limit:100n}),blockNumber}),
      readClient.readContract({...base,functionName:'getDataSetLastProvenEpoch',args:[dataSetId]}),
      readClient.readContract({...base,functionName:'getNextChallengeEpoch',args:[dataSetId]}),
      readClient.readContract({...base,functionName:'getDataSetStorageProvider',args:[dataSetId]}),
      readClient.readContract({...getDataSetCall({chain,dataSetId}),blockNumber})
    ]);
    const included=pieceIds.some(id=>id===pieceId);
    const providerMatches=getAddress(providers[0])===getAddress(copy.provider)&&dataSet.providerId===providerId;
    const payerMatches=getAddress(dataSet.payer)===getAddress(receipt.account);
    const recent=lastProven>0n&&lastProven<=blockNumber&&blockNumber-lastProven<=maxProofAgeEpochs;
    const beforeNextChallenge=nextChallenge>blockNumber;
    copies.push({providerId:String(providerId),dataSetId:String(dataSetId),pieceId:String(pieceId),live,included,providerMatches,payerMatches,lastProvenEpoch:String(lastProven),nextChallengeEpoch:String(nextChallenge),recent,beforeNextChallenge,chainObservationValid:Boolean(live&&included&&providerMatches&&payerMatches&&recent&&beforeNextChallenge)});
  }
  const after=await readClient.getBlock({blockNumber});if(!before.hash||before.hash!==after.hash)throw new Error('Chain reorganized during proof observation');
  const code=await readClient.getCode({address:chain.contracts.pdp.address,blockNumber});if(!code||code==='0x')throw new Error('Missing PDP verifier runtime');
  return {schemaVersion:1,chainId:chain.id,blockNumber:String(blockNumber),blockHash:after.hash,confirmations,pdpVerifier:chain.contracts.pdp.address,pdpRuntimeCodeHash:keccak256(code),pieceCid:receipt.pieceCid,copies,proofStatus:copies.every(c=>c.chainObservationValid)?'rpc-observed-pdp-current':'not-verified',proofVerified:false,rewardAdapterEnabled:false,limits:['RPC and configured Filecoin contract state are trusted','This report does not independently verify Filecoin consensus or PoRep/PoSt','No ATS reward eligibility is conferred by a self-submitted status report','Live funded upload/PDP proof cycle requires separate public-testnet acceptance']};
}
