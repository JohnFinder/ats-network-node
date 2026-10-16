import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import https from 'node:https';
import dns from 'node:dns/promises';
import net from 'node:net';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import * as Piece from '@filoz/synapse-core/piece';
import {MAX_FILE_BYTES} from './policy.mjs';
export function publicAddress(address){
  if(net.isIP(address)===4){const [a,b]=address.split('.').map(Number);return !(a===0||a===10||a===127||a>=224||(a===100&&b>=64&&b<=127)||(a===169&&b===254)||(a===172&&b>=16&&b<=31)||(a===192&&(b===168||b===0||b===2))||(a===198&&(b===18||b===19||b===51))||(a===203&&b===0));}
  if(net.isIP(address)===6){const a=address.toLowerCase();if(a.startsWith('::ffff:'))return publicAddress(a.slice(7));return /^[23]/.test(a)&&!a.startsWith('2001:db8')&&!/^2001:0{0,3}:/.test(a)&&!a.startsWith('2002:');}
  return false;
}
export async function openPublicResponse(raw){
  const url=new URL(raw);
  if(url.protocol!=='https:'||url.username||url.password||url.hash||!url.hostname)throw new Error('Retrieval URL must use public HTTPS without credentials/fragments');
  const hostname=url.hostname.replace(/^\[|\]$/g,'');
  const addresses=net.isIP(hostname)?[{address:hostname,family:net.isIP(hostname)}]:await dns.lookup(hostname,{all:true});
  if(!addresses.length||addresses.some(a=>!publicAddress(a.address)))throw new Error('Retrieval resolves to a non-public address');
  const pinned=addresses[0];
  return new Promise((resolve,reject)=>{
    const request=https.get(url,{headers:{'Accept-Encoding':'identity'},signal:AbortSignal.timeout(600000),lookup:(_hostname,options,done)=>options.all?done(null,[pinned]):done(null,pinned.address,pinned.family)},response=>{
      if(response.statusCode!==200){response.resume();reject(new Error('Retrieval must return 200 directly; redirects refused'));return;}resolve(response);
    });request.setTimeout(30000,()=>request.destroy(new Error('Retrieval inactivity timeout')));request.on('error',reject);
  });
}
export async function downloadVerified({receipt,destination,openResponse=openPublicResponse,maximumBytes=MAX_FILE_BYTES}){
  if(receipt.schemaVersion!==1||!Number.isSafeInteger(receipt.byteCount)||receipt.byteCount<127||receipt.byteCount>maximumBytes||!/^[a-f0-9]{64}$/.test(receipt.sha256)||!Piece.tryFrom(receipt.pieceCid))throw new Error('Invalid bounded content receipt');
  const urls=[...new Set((receipt.copies??[]).map(c=>c.retrievalUrl))];if(urls.length<1||urls.length>4)throw new Error('Receipt requires 1..4 retrieval sources');
  let last;
  for(const url of urls){
    const temporary=path.join(path.dirname(destination),`.ats-download-${randomUUID()}`);let handle,response;
    try{
      response=await openResponse(url);const advertised=response.headers?.['content-length'];
      if(advertised!==undefined&&(!/^[0-9]+$/.test(advertised)||Number(advertised)!==receipt.byteCount))throw new Error('Unexpected content length');
      handle=await fs.open(temporary,'wx',0o600);const sha=createHash('sha256');let bytes=0;
      for await(const chunk of response){bytes+=chunk.length;if(bytes>receipt.byteCount||bytes>maximumBytes)throw new Error('Retrieval exceeds declared bound');sha.update(chunk);let offset=0;while(offset<chunk.length){const written=await handle.write(chunk,offset,chunk.length-offset);offset+=written.bytesWritten;}}
      await handle.close();handle=null;
      if(bytes!==receipt.byteCount||sha.digest('hex')!==receipt.sha256)throw new Error('Retrieved bytes failed full SHA-256 verification');
      if((await Piece.calculate(createReadStream(temporary))).toString()!==receipt.pieceCid)throw new Error('Retrieved bytes failed official PieceCID verification');
      // Atomic no-clobber publication: a failed verification never becomes the destination.
      await fs.link(temporary,destination);await fs.unlink(temporary);
      return {verified:true,sha256:receipt.sha256,pieceCid:receipt.pieceCid,byteCount:bytes,source:url};
    }catch(error){last=error;response?.destroy?.();if(handle)await handle.close();await fs.rm(temporary,{force:true});if(error.code==='EEXIST')throw new Error('Destination already exists; refusing overwrite');}
  }
  throw new Error(`No receipt source passed verification: ${last?.message??'unavailable'}`);
}
