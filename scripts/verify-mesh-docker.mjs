#!/usr/bin/env node
// Three isolated Docker nodes, synthetic fixtures and ephemeral keys. No real funds/data.
import assert from 'node:assert/strict';
import {createHash,generateKeyPairSync,randomBytes,randomUUID,sign,verify,createPublicKey} from 'node:crypto';
import {mkdtemp,writeFile,appendFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';

const project=`ats-mesh-verify-${process.pid}`,work=await mkdtemp(path.join(tmpdir(),'ats-mesh-fixtures-'));
const report=process.env.VERIFY_MESH_LOG??path.join(tmpdir(),`${project}.log`);
const env={...process.env},ports=[Number(env.VERIFY_MESH_A_PORT??18871),Number(env.VERIFY_MESH_B_PORT??18872),Number(env.VERIFY_MESH_C_PORT??18873)];
for(const p of ports)assert(Number.isSafeInteger(p)&&p>1024&&p<65536);
for(const [i,n]of ['A','B','C'].entries())env[`MESH_${n}_PORT`]=String(ports[i]);
const host=i=>`http://127.0.0.1:${ports[i]}`,origin=i=>`http://node-${'abc'[i]}:8787`;
const sha=b=>createHash('sha256').update(b).digest('hex');
const key=generateKeyPairSync('ed25519'),raw=key.publicKey.export({format:'der',type:'spki'}).subarray(-32),owner=sha(raw);
env.MESH_ADMIN_ID=owner;
let checks=0,failed=false;
async function log(s){console.log(s);await appendFile(report,s+'\n');}
async function pass(s){checks++;await log(`PASS ${s}`);}
async function compose(...args){return await new Promise((resolve,reject)=>{
  const p=spawn('docker',['compose','-p',project,'-f','compose.full.yaml',...args],{env,stdio:['ignore','pipe','pipe']});let output='';
  for(const stream of [p.stdout,p.stderr])stream.on('data',b=>{output+=b.toString();process.stdout.write(b);});
  p.on('error',reject);p.on('exit',code=>{appendFile(report,output).then(()=>code===0?resolve(output):reject(Error(`compose ${args[0]} failed ${code}`)));});
});}
function headers(i,method,route,b){const timestamp=String(Math.floor(Date.now()/1000)),nonce=randomUUID();return {'Content-Type':'application/json','X-ATS-Audience':origin(i),'X-ATS-Public-Key':raw.toString('base64'),'X-ATS-Timestamp':timestamp,'X-ATS-Nonce':nonce,'X-ATS-Signature':sign(null,Buffer.from(`ATS-NODE-V1\n${origin(i)}\n${method}\n${route}\n${timestamp}\n${nonce}\n${sha(b)}`),key.privateKey).toString('base64')};}
async function req(i,method,route,value,expected=200,auth=true){const b=value===undefined?Buffer.alloc(0):Buffer.isBuffer(value)?value:Buffer.from(JSON.stringify(value));const r=await fetch(host(i)+route,{method,headers:auth?headers(i,method,route,b):{},body:method==='GET'?undefined:b,signal:AbortSignal.timeout(15000)});const result=await r.json();assert.equal(r.status,expected,`${method} ${i} ${route}: ${JSON.stringify(result)}`);return result;}
const get=(i,route)=>req(i,'GET',route,undefined,200,false);
function decode(e,id){const b=Buffer.from(e.payloadBytes,'base64'),k=Buffer.from(e.publicKey,'base64');assert.equal(sha(k),id);assert(verify(null,b,createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),k]),format:'der',type:'spki'}),Buffer.from(e.signature,'base64')));return JSON.parse(b);}
async function waitFor(name,f,timeout=60000){const until=Date.now()+timeout;while(Date.now()<until){try{const v=await f();if(v)return v;}catch{}await new Promise(r=>setTimeout(r,500));}throw Error(`Timeout ${name}`);}
const fixture=n=>Buffer.concat([Buffer.from('ATSBOOK1'),randomBytes(n-8)]);
const meta=(b,visibility,title)=>({sha256:sha(b),byteCount:b.length,title,summary:'Synthetic mesh fixture; not a playable audiobook.',language:'en',tags:['meshfixture'],visibility,encrypted:true});
async function upload(i,b,visibility,title){const session=await req(i,'POST','/v1/uploads',meta(b,visibility,title),201);for(let n=0;n<Math.ceil(b.length/session.partSize);n++)await req(i,'PUT',`/v1/uploads/${session.id}/parts/${n}`,b.subarray(n*session.partSize,(n+1)*session.partSize));return await req(i,'POST',`/v1/uploads/${session.id}/complete`,{});}
let ids;
try{
  await log(`START ${new Date().toISOString()} project=${project} synthetic-only; report=${report}`);
  await compose('up','-d','--build','--wait','node-a','node-b','node-c');
  ids=await Promise.all([0,1,2].map(async i=>(await get(i,'/v1/node')).providerID));
  for(const i of [0,1,2])env[`MESH_${'ABC'[i]}_PEERS`]=JSON.stringify([0,1,2].filter(j=>j!==i).map(j=>({url:origin(j),providerID:ids[j]})));
  await compose('up','-d','--force-recreate','--wait','node-a','node-b','node-c');
  await waitFor('pinned peers',async()=>{const s=await get(1,'/v1/mesh/status');return s.peers.length===2&&s.peers.every(p=>p.online);});
  await pass('three persistent provider identities mutually pinned; signed announcements accepted');
  const bytes=fixture(8*1024**2+131072),session=await req(0,'POST','/v1/uploads',meta(bytes,'public','Public mesh resumable'),201);
  await req(0,'PUT',`/v1/uploads/${session.id}/parts/0`,bytes.subarray(0,session.partSize));
  await compose('restart','node-a');await compose('up','-d','--wait','node-a');
  const status=await req(0,'GET',`/v1/uploads/${session.id}`);assert.equal(status.parts.length,1);assert.equal(status.parts[0].sha256,sha(bytes.subarray(0,session.partSize)));
  await req(0,'PUT',`/v1/uploads/${session.id}/parts/1`,bytes.subarray(session.partSize));const resource=await req(0,'POST',`/v1/uploads/${session.id}/complete`,{});
  await pass('publisher upload resumes exact persisted part after container restart');
  const hidden=[];for(const visibility of ['private','unlisted'])hidden.push(await upload(0,fixture(4096),visibility,`Hidden ${visibility} mesh`));
  const replicaKey=sha(`${ids[0]}:${resource.id}`);
  await waitFor('public federated catalogue',async()=>{const p=decode(await get(1,'/v1/mesh/resources?q=Public&limit=100'),ids[1]);return p.items.some(r=>r.id===resource.id);});
  const page=decode(await get(1,'/v1/mesh/resources?q=Public&limit=100'),ids[1]),remote=page.items.find(r=>r.id===resource.id);
  assert.equal(remote.publisherID,owner);assert.equal(remote.originProviderID,ids[0]);const desc=decode(remote.originDescriptor,ids[0]);assert.equal(desc.resource.sha256,sha(bytes));assert.equal(desc.resource.visibility,'public');
  await pass('signed cross-node catalogue preserves publisher proof, origin and exact archive metadata');
  for(const i of [1,2])await waitFor(`replica ${i}`,async()=>{const s=await get(i,'/v1/mesh/status');return s.replicas.some(r=>r.status==='ready'&&r.count>=1);});
  for(const i of [1,2]){const response=await fetch(host(i)+`/v1/mesh/objects/${replicaKey}`);assert.equal(response.status,200);assert.equal(sha(Buffer.from(await response.arrayBuffer())),sha(bytes));const p=decode(await get(i,'/v1/mesh/resources?limit=100'),ids[i]);for(const h of hidden)assert(!p.items.some(r=>r.id===h.id));const snap=decode(await get(i,'/v1/mesh/snapshot'),ids[i]);for(const e of snap.items){const r=JSON.parse(Buffer.from(e.payloadBytes,'base64'));assert(!hidden.some(h=>h.id===r.resource.id));}}
  await pass('two remote replicas fully hash-verified; private/unlisted absent from catalogues and forwarded descriptors');
  await compose('stop','node-a');
  const offlinePage=decode(await get(1,'/v1/mesh/resources?q=Public'),ids[1]);const fallback=offlinePage.items.find(r=>r.id===resource.id);assert(fallback.sources.some(s=>s.startsWith(origin(1)+'/v1/mesh/objects/')));
  let response=await fetch(host(1)+`/v1/mesh/objects/${replicaKey}`,{headers:{Range:'bytes=0-7'}});assert.equal(response.status,206);assert.equal(await response.text(),'ATSBOOK1');
  await pass('public resource remains listed and downloadable through replica while origin is stopped');
  // Seed a durable prefix from a previously verified copy. This deterministically exercises recovery
  // from an interrupted replica state without relying on timing a fast local Ethernet transfer.
  await compose('stop','node-c');
  const seed=`const fs=require('fs'),{DatabaseSync}=require('node:sqlite');const p='/data/replicas/${replicaKey}';const bytes=fs.readFileSync(p);fs.writeFileSync(p+'.partial',bytes.subarray(0,65536),{mode:384});fs.unlinkSync(p);const db=new DatabaseSync('/data/node.sqlite');db.prepare("UPDATE mesh_replicas SET status='partial' WHERE key=?").run('${replicaKey}');db.close();console.log('Seeded durable replica prefix:65536');`;
  await compose('run','--rm','--no-deps','--entrypoint','node','node-c','-e',seed);
  await compose('up','-d','--wait','node-c');
  await waitFor('repair from remaining peer',async()=>{const s=await get(2,'/v1/mesh/status');return s.replicas.some(r=>r.status==='ready'&&r.count>=1);});
  response=await fetch(host(2)+`/v1/mesh/objects/${replicaKey}`);assert.equal(sha(Buffer.from(await response.arrayBuffer())),sha(bytes));
  await pass('restarted node repairs seeded durable partial replica via another peer with origin offline');
  env.MESH_B_DRAIN='1';await compose('up','-d','--force-recreate','--wait','node-b');
  await req(1,'POST','/v1/uploads',meta(fixture(4096),'public','Drained upload'),503);response=await fetch(host(1)+`/v1/mesh/objects/${replicaKey}`);assert.equal(response.status,200);await response.arrayBuffer();
  await pass('draining node refuses new uploads and continues serving retained replicas');
  env.MESH_C_PEERS=JSON.stringify([{url:origin(1),providerID:'f'.repeat(64)}]);await compose('up','-d','--force-recreate','--wait','node-c');
  await waitFor('wrong pin rejection',async()=>{const s=await get(2,'/v1/mesh/status');return s.peers.length===1&&s.peers[0].online===false;});
  await pass('wrong provider fingerprint rejects peer announcement despite reachable endpoint');
  await log(`COMPLETE ${checks} checks; ${new Date().toISOString()}; signed outer bytes and synthetic archive magic only; no playback/independent-replica proof claimed.`);
}catch(error){failed=true;await log(`FAIL ${error.stack??error}`);try{await compose('logs','--tail=100','node-a','node-b','node-c');}catch{}process.exitCode=1;}
finally{
  if(env.KEEP_VERIFY_CONTAINERS==='1')await log(`Preserved ${project}, fixture directory ${work}; cleanup: docker compose -p ${project} -f compose.full.yaml down -v`);
  else{try{await compose('down','-v','--remove-orphans');}catch(error){await log(`Cleanup failed: ${error.message}`);process.exitCode=1;}await rm(work,{recursive:true,force:true});}
  await log(`REPORT ${report}; result=${failed?'FAIL':'PASS'}`);
}
