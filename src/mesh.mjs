import { createHash, createPublicKey, randomUUID, sign, verify } from 'node:crypto';
import { mkdir, open, rename, rm, stat, statfs } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import path from 'node:path';

const sha = b => createHash('sha256').update(b).digest('hex');
const now = () => Math.floor(Date.now()/1000);
const digest = /^[a-f0-9]{64}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (status, code) => Object.assign(new Error(code), {status, code});
function base64(s, max) {
  if (typeof s !== 'string' || s.length > max * 2) throw fail(400,'invalid_mesh_signature');
  const b = Buffer.from(s,'base64');
  if (b.length > max || b.toString('base64') !== s) throw fail(400,'invalid_mesh_signature');
  return b;
}
export function signed(payload, privateKey, publicKey) {
  const bytes = Buffer.from(JSON.stringify(payload));
  return { payloadBytes: bytes.toString('base64'), publicKey: publicKey.toString('base64'), signature: sign(null, bytes, privateKey).toString('base64') };
}
export function verified(envelope, allowed, maximum=262144) {
  if (!envelope || typeof envelope !== 'object') throw fail(400,'invalid_mesh_signature');
  const bytes=base64(envelope.payloadBytes,maximum), key=base64(envelope.publicKey,32), sig=base64(envelope.signature,64);
  if (key.length!==32 || sig.length!==64 || !allowed.has(sha(key))) throw fail(403,'untrusted_signer');
  const publicKey=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),key]),format:'der',type:'spki'});
  if (!verify(null,bytes,publicKey,sig)) throw fail(400,'invalid_mesh_signature');
  let payload; try {payload=JSON.parse(bytes.toString('utf8'));} catch {throw fail(400,'invalid_mesh_payload');}
  return {payload, signer:sha(key)};
}
function privateAddress(ip) {
  if (ip.includes(':')) {
    const n=ip.toLowerCase();
    if (n.startsWith('::ffff:')) return privateAddress(n.slice(7));
    return n==='::' || n==='::1' || /^f[cd]/.test(n) || /^fe[89ab]/.test(n) || n.startsWith('ff') || !/^[234]/.test(n);
  }
  const a=ip.split('.').map(Number);
  return a[0]===0 || a[0]===10 || a[0]===127 || a[0]>=224 || (a[0]===169 && a[1]===254) || (a[0]===172 && a[1]>=16 && a[1]<=31) || (a[0]===192 && (a[1]===168 || a[1]===0)) || (a[0]===100 && a[1]>=64 && a[1]<=127) || (a[0]===198 && (a[1]===18 || a[1]===19));
}
// Every outbound request is built from an operator allowlisted origin, never resource metadata.
async function request(peer, pathname, headers={}, allowPrivate=false) {
  const u=new URL(pathname,peer.url);
  if (u.origin!==peer.url || !pathname.startsWith('/v1/')) throw fail(400,'invalid_peer_url');
  const hostname=u.hostname.replace(/^\[|\]$/g,'');
  const addresses=isIP(hostname)?[{address:hostname,family:isIP(hostname)}]:await lookup(hostname,{all:true});
  if (!addresses.length || (!allowPrivate && addresses.some(a=>privateAddress(a.address)))) throw fail(403,'private_peer_address');
  const a=addresses[0];
  return await new Promise((resolve,reject)=>{
    const req=(u.protocol==='https:'?https:http).get(u,{headers,lookup:(_host,opts,cb)=>opts?.all?cb(null,[a]):cb(null,a.address,a.family)},res=>resolve(res));
    const deadline=setTimeout(()=>req.destroy(fail(504,'peer_timeout')),30000);deadline.unref();req.on('close',()=>clearTimeout(deadline));req.setTimeout(15000,()=>req.destroy(fail(504,'peer_timeout')));req.on('error',reject);
  });
}
async function readJSON(peer, pathname, maximum, allowPrivate) {
  const res=await request(peer,pathname,{},allowPrivate);
  if(res.statusCode!==200){res.destroy();throw fail(502,'peer_response');}
  const chunks=[];let size=0;
  for await(const c of res){size+=c.length;if(size>maximum){res.destroy();throw fail(413,'snapshot_too_large');}chunks.push(c);}
  try{return JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw fail(502,'invalid_peer_json');}
}
export async function createMesh({db,dataDir,providerID,providerPublicKey,providerKey,publicURL,maxFile,totalQuota,maxEntries,resourceResponse,metadata}) {
  const allowPrivate=process.env.NODE_ALLOW_PRIVATE_PEERS==='1';
  let peers;try{peers=JSON.parse(process.env.NODE_PEERS??'[]');}catch{throw new Error('Invalid NODE_PEERS');}
  if(!Array.isArray(peers)||peers.length>32)throw new Error('NODE_PEERS supports at most 32 pinned peers');
  peers=peers.map(p=>{
    const u=new URL(p.url);
    if(u.username||u.password||u.search||u.hash||u.pathname!=='/'||!digest.test(p.providerID)||p.providerID===providerID||!['https:',...(allowPrivate?['http:']:[])].includes(u.protocol))throw new Error('Invalid pinned NODE_PEERS origin or providerID');
    return {url:u.origin,providerID:p.providerID};
  });
  if(new Set(peers.map(p=>p.url)).size!==peers.length||new Set(peers.map(p=>p.providerID)).size!==peers.length)throw new Error('Duplicate NODE_PEERS');
  const pins=new Map([[providerID,publicURL.origin],...peers.map(p=>[p.providerID,p.url])]);
  const allowed=new Set(pins.keys());
  const number=(name,fallback,max)=>{const n=Number(process.env[name]??fallback);if(!Number.isSafeInteger(n)||n<1||n>max)throw new Error(`Invalid ${name}`);return n;};
  const desired=number('NODE_DESIRED_REPLICAS',2,33), interval=number('NODE_MESH_INTERVAL_SECONDS',60,86400);
  const maxReplicaBytes=number('NODE_REPLICA_QUOTA_BYTES',Math.min(totalQuota,10*1024**3),totalQuota);
  const staleSeconds=number('NODE_PEER_STALE_SECONDS',3600,7*86400);
  const draining=process.env.NODE_DRAIN==='1';
  await mkdir(path.join(dataDir,'replicas'),{recursive:true,mode:0o700});
  db.exec(`CREATE TABLE IF NOT EXISTS publication_auth(id TEXT PRIMARY KEY, proof TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mesh_records(key TEXT PRIMARY KEY, origin TEXT NOT NULL,id TEXT NOT NULL,descriptor TEXT NOT NULL,resource TEXT NOT NULL,seen INTEGER NOT NULL,bytes INTEGER NOT NULL,sha TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS mesh_deleted(key TEXT PRIMARY KEY,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mesh_sources(key TEXT NOT NULL,peer TEXT NOT NULL,seen INTEGER NOT NULL,PRIMARY KEY(key,peer));
    CREATE INDEX IF NOT EXISTS mesh_origin ON mesh_records(origin,seen);
    CREATE TABLE IF NOT EXISTS mesh_replicas(key TEXT PRIMARY KEY,bytes INTEGER NOT NULL,sha TEXT NOT NULL,status TEXT NOT NULL,updated INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS retention_quotes(id TEXT PRIMARY KEY,owner TEXT NOT NULL,resource TEXT NOT NULL,until INTEGER NOT NULL,expires INTEGER NOT NULL,bytes INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS retention_orders(id TEXT PRIMARY KEY,owner TEXT NOT NULL,resource TEXT NOT NULL,until INTEGER NOT NULL,receipt TEXT NOT NULL,created INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS retention_nonces(domain TEXT PRIMARY KEY,nonce INTEGER NOT NULL,until INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS mesh_tombstones(id TEXT PRIMARY KEY,created INTEGER NOT NULL);`);
  let syncing=false,lastSync=null,lastError=null;const peerStatus=new Map();
  const proofFrom=(req,url,bytes)=>({bodyBytes:bytes.toString('base64'),audience:req.headers['x-ats-audience'],method:'POST',path:url.pathname+url.search,timestamp:req.headers['x-ats-timestamp'],nonce:req.headers['x-ats-nonce'],publicKey:req.headers['x-ats-public-key'],signature:req.headers['x-ats-signature']});
  function validDescriptor(envelope){
    const {payload:p,signer}=verified(envelope,allowed,32768);
    if(p.type!=='ats-publication-v1'||p.schemaVersion!==1||p.originProviderID!==signer||p.originURL!==pins.get(signer)||!uuid.test(p.resource?.id)||p.resource.visibility!=='public'||!Number.isSafeInteger(p.created)||p.created>now()+300)throw fail(400,'invalid_publication_descriptor');
    const proof=p.publisherProof,b=base64(proof?.bodyBytes,16384),key=base64(proof?.publicKey,32),sig=base64(proof?.signature,64);
    if(key.length!==32||sig.length!==64||proof.audience!==p.originURL||proof.method!=='POST'||proof.path!=='/v1/uploads'||!/^\d{1,12}$/.test(proof.timestamp)||!uuid.test(proof.nonce))throw fail(400,'invalid_publisher_proof');
    const msg=`ATS-NODE-V1\n${proof.audience}\nPOST\n/v1/uploads\n${proof.timestamp}\n${proof.nonce}\n${sha(b)}`;
    const pk=createPublicKey({key:Buffer.concat([Buffer.from('302a300506032b6570032100','hex'),key]),format:'der',type:'spki'});
    if(!verify(null,Buffer.from(msg),pk,sig))throw fail(400,'invalid_publisher_proof');
    let original;try{original=JSON.parse(b.toString('utf8'));}catch{throw fail(400,'invalid_publisher_proof');}
    if(Object.keys(original).some(k=>!['sha256','byteCount','title','summary','language','tags','visibility','encrypted'].includes(k)))throw fail(400,'unknown_public_metadata_field');
    const m=metadata(original),r=p.resource;
    if(m.visibility!=='public'||r.publisherID!==sha(key)||r.sha256!==original.sha256||r.byteCount!==original.byteCount||!digest.test(r.sha256)||r.byteCount>maxFile)throw fail(400,'substituted_publication');
    for(const k of ['title','summary','language','encrypted','visibility'])if(r[k]!==m[k])throw fail(400,'substituted_metadata');
    if(JSON.stringify(r.tags)!==JSON.stringify(m.tags)||r.createdAt!==new Date(p.created*1000).toISOString())throw fail(400,'substituted_metadata');
    // Sources and statistics are derived locally; untrusted descriptor URLs/counts never control network requests.
    const safe={id:r.id,title:m.title,summary:m.summary,language:m.language,tags:m.tags,encrypted:m.encrypted,visibility:'public',sha256:r.sha256,byteCount:r.byteCount,publisherID:sha(key),createdAt:r.createdAt,sources:[`${p.originURL}/v1/resources/${r.id}/download`],downloads:0,originProviderID:signer,originURL:p.originURL,publisherAuthentication:'signed-upload-request',descriptorHash:sha(Buffer.from(JSON.stringify(envelope)))};
    const k=sha(`${signer}:${r.id}`);
    return {key:k,origin:signer,id:r.id,resource:safe,envelope};
  }
  const localDescriptor=r=>{
    const auth=db.prepare('SELECT proof FROM publication_auth WHERE id=?').get(r.id);
    if(!auth)return null;
    return signed({schemaVersion:1,type:'ats-publication-v1',originProviderID:providerID,originURL:publicURL.origin,created:r.created,resource:{...resourceResponse(r),downloads:0},publisherProof:JSON.parse(auth.proof)},providerKey,providerPublicKey);
  };
  const snapshot=offset=>{
    const own=db.prepare("SELECT * FROM resources WHERE visibility='public' ORDER BY id LIMIT 1000").all().map(localDescriptor).filter(Boolean);
    const remote=db.prepare('SELECT descriptor FROM mesh_records WHERE seen>? ORDER BY key LIMIT 1000').all(now()-7*86400).map(r=>JSON.parse(r.descriptor));
    const entries=[...own,...remote].slice(0,1000);
    return signed({schemaVersion:1,type:'ats-mesh-snapshot-v1',providerID,originURL:publicURL.origin,generatedAt:now(),items:entries.slice(offset,offset+100),replicaKeys:db.prepare("SELECT key FROM mesh_replicas WHERE status='ready' ORDER BY key LIMIT 1000").all().map(r=>r.key),tombstones:db.prepare('SELECT id FROM mesh_tombstones ORDER BY created DESC LIMIT 1000').all().map(r=>r.id),nextCursor:entries.length>offset+100?offset+100:null},providerKey,providerPublicKey);
  };
  const recordPath=key=>path.join(dataDir,'replicas',key);
  async function replicate(record){
    const existing=db.prepare('SELECT * FROM mesh_replicas WHERE key=?').get(record.key);
    if(existing?.status==='ready'&&await stat(recordPath(record.key)).then(s=>s.size===record.resource.byteCount).catch(()=>false))return;
    const reserved=db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM mesh_replicas').get().n;
    const local=db.prepare("SELECT COALESCE(SUM(bytes),0) AS n FROM uploads WHERE status='complete' OR expires>=?").get(now()).n;
    if(!existing&&(reserved+record.resource.byteCount>maxReplicaBytes||local+reserved+record.resource.byteCount>totalQuota))return;
    const disk=await statfs(dataDir);if(disk.bavail*disk.bsize<record.resource.byteCount+16*1024**2)return;
    db.prepare("INSERT INTO mesh_replicas(key,bytes,sha,status,updated) VALUES(?,?,?,'partial',?) ON CONFLICT(key) DO UPDATE SET updated=excluded.updated").run(record.key,record.resource.byteCount,record.resource.sha256,now());
    const partial=`${recordPath(record.key)}.partial`;
    let offset=await stat(partial).then(s=>s.size).catch(()=>0);
    if(offset>record.resource.byteCount){await rm(partial,{force:true});offset=0;}
    const sourcePeers=[...peers.filter(p=>p.providerID===record.origin).map(p=>({peer:p,path:`/v1/resources/${record.id}/download`})),...db.prepare('SELECT peer FROM mesh_sources WHERE key=? AND seen>?').all(record.key,now()-staleSeconds).map(s=>({peer:peers.find(p=>p.providerID===s.peer),path:`/v1/mesh/objects/${record.key}`})).filter(s=>s.peer)];
    let transferred=offset===record.resource.byteCount;
    for(const source of sourcePeers){
      if(transferred)break;
      try{
        offset=await stat(partial).then(s=>s.size).catch(()=>0);
        const response=await request(source.peer,source.path,offset?{Range:`bytes=${offset}-`,'If-Range':`"${record.resource.sha256}"`}:{},allowPrivate);
        const expected=record.resource.byteCount-offset;
        if(response.statusCode!==(offset?206:200)||response.headers.etag!==`"${record.resource.sha256}"`||Number(response.headers['content-length'])!==expected||(offset&&response.headers['content-range']!==`bytes ${offset}-${record.resource.byteCount-1}/${record.resource.byteCount}`)){response.destroy();throw fail(502,'invalid_replica_response');}
        const output=await open(partial,offset?'a':'w',0o600);let received=0;
        try{for await(const chunk of response){received+=chunk.length;if(received>expected){response.destroy();throw fail(413,'replica_too_large');}let w=0;while(w<chunk.length)w+=(await output.write(chunk,w,chunk.length-w)).bytesWritten;}await output.sync();}finally{await output.close();}
        if(received!==expected)throw fail(502,'incomplete_replica');
        transferred=true;
      }catch{lastError='replica_source_failed';}
    }
    if(!transferred)throw fail(502,'replica_sources_unavailable');
    const hash=createHash('sha256');let count=0,prefix=Buffer.alloc(0);
    for await(const chunk of createReadStream(partial)){hash.update(chunk);count+=chunk.length;if(prefix.length<8)prefix=Buffer.concat([prefix,chunk.subarray(0,8-prefix.length)]);}
    if(count!==record.resource.byteCount||hash.digest('hex')!==record.resource.sha256||prefix.toString('ascii')!=='ATSBOOK1'){await rm(partial,{force:true});db.prepare('DELETE FROM mesh_replicas WHERE key=?').run(record.key);throw fail(422,'replica_integrity_failure');}
    await rename(partial,recordPath(record.key));
    db.prepare("UPDATE mesh_replicas SET status='ready',updated=? WHERE key=?").run(now(),record.key);
  }
  async function sync(){
    if(syncing)return;syncing=true;
    try{
      for(const peer of peers){
        try{
          const announcement=verified(await readJSON(peer,'/v1/mesh/announcement',16384,allowPrivate),new Set([peer.providerID]),8192).payload;
          if(announcement.schemaVersion!==1||announcement.type!=='ats-node-announcement-v1'||announcement.providerID!==peer.providerID||announcement.publicURL!==peer.url||!Number.isSafeInteger(announcement.generatedAt)||Math.abs(now()-announcement.generatedAt)>300||typeof announcement.draining!=='boolean')throw fail(400,'invalid_peer_announcement');
          let cursor=0,total=0;
          do{
            const envelope=await readJSON(peer,`/v1/mesh/snapshot?cursor=${cursor}`,6*1024**2,allowPrivate);
            const {payload:p}=verified(envelope,new Set([peer.providerID]),4*1024**2);
            if(p.type!=='ats-mesh-snapshot-v1'||p.schemaVersion!==1||p.providerID!==peer.providerID||p.originURL!==peer.url||!Number.isSafeInteger(p.generatedAt)||Math.abs(now()-p.generatedAt)>300||!Array.isArray(p.items)||p.items.length>100||!Array.isArray(p.tombstones)||p.tombstones.length>1000||!Array.isArray(p.replicaKeys)||p.replicaKeys.length>1000||p.replicaKeys.some(k=>!digest.test(k)))throw fail(400,'invalid_snapshot');
            for(const id of p.tombstones){if(!uuid.test(id))throw fail(400,'invalid_tombstone');const key=sha(`${peer.providerID}:${id}`);db.prepare('INSERT OR REPLACE INTO mesh_deleted VALUES(?,?)').run(key,now());db.prepare('DELETE FROM mesh_records WHERE key=?').run(key);await rm(recordPath(key),{force:true});await rm(`${recordPath(key)}.partial`,{force:true});db.prepare('DELETE FROM mesh_replicas WHERE key=?').run(key);}
            for(const e of p.items){const r=validDescriptor(e);if(r.origin===providerID||db.prepare('SELECT 1 FROM mesh_deleted WHERE key=?').get(r.key))continue;const old=db.prepare('SELECT descriptor FROM mesh_records WHERE key=?').get(r.key);
              if(old){const previous=validDescriptor(JSON.parse(old.descriptor));if(previous.resource.sha256!==r.resource.sha256||JSON.stringify(previous.envelope)!==JSON.stringify(e))throw fail(409,'descriptor_conflict');}
              if(!old&&db.prepare('SELECT COUNT(*) AS n FROM mesh_records').get().n>=Math.min(maxEntries,1000))break;
              db.prepare('INSERT INTO mesh_records(key,origin,id,descriptor,resource,seen,bytes,sha) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(key) DO UPDATE SET seen=excluded.seen').run(r.key,r.origin,r.id,JSON.stringify(e),JSON.stringify(r.resource),now(),r.resource.byteCount,r.resource.sha256);
            }
            db.prepare('DELETE FROM mesh_sources WHERE peer=?').run(peer.providerID);
            for(const key of p.replicaKeys)if(db.prepare('SELECT 1 FROM mesh_records WHERE key=?').get(key))db.prepare('INSERT INTO mesh_sources VALUES(?,?,?)').run(key,peer.providerID,now());
            total+=p.items.length;const next=p.nextCursor;
            if(next!==null&&(!Number.isSafeInteger(next)||next!==cursor+100))throw fail(400,'invalid_cursor');
            cursor=next;
          }while(cursor!==null&&cursor<1000&&total<=1000);
          peerStatus.set(peer.providerID,{online:true,lastSuccess:now(),draining:announcement.draining});
        }catch{peerStatus.set(peer.providerID,{online:false,lastAttempt:now()});}
      }
      db.prepare('DELETE FROM mesh_deleted WHERE created<?').run(now()-30*86400);
      db.prepare('DELETE FROM mesh_deleted WHERE key IN (SELECT key FROM mesh_deleted ORDER BY created DESC LIMIT -1 OFFSET ?)').run(maxEntries);
      db.prepare('DELETE FROM mesh_sources WHERE seen<?').run(now()-7*86400);
      // Old catalogue entries are withdrawn; existing replicas keep public bytes available for a bounded grace period.
      for(const row of db.prepare('SELECT key FROM mesh_records WHERE seen<?').all(now()-7*86400)){
        db.prepare('DELETE FROM mesh_records WHERE key=?').run(row.key);db.prepare('DELETE FROM mesh_replicas WHERE key=?').run(row.key);await rm(recordPath(row.key),{force:true});await rm(`${recordPath(row.key)}.partial`,{force:true});
      }
      if(!draining){
        const candidates=[providerID,...peers.filter(p=>peerStatus.get(p.providerID)?.online&&!peerStatus.get(p.providerID)?.draining).map(p=>p.providerID)];
        for(const row of db.prepare('SELECT descriptor FROM mesh_records WHERE seen>? ORDER BY key LIMIT 1000').all(now()-staleSeconds)){
          const r=validDescriptor(JSON.parse(row.descriptor));
          const selected=candidates.toSorted((a,b)=>sha(`${r.key}:${a}`).localeCompare(sha(`${r.key}:${b}`))).slice(0,desired);
          if(selected.includes(providerID))try{await replicate(r);}catch{lastError='replica_transfer_failed';}
        }
      }
      lastSync=now();
    }finally{syncing=false;}
  }
  function publicItems(onlyKey=null){return db.prepare('SELECT * FROM mesh_records WHERE seen>? AND (? IS NULL OR key=?) ORDER BY key LIMIT 1000').all(now()-7*86400,onlyKey,onlyKey).map(row=>{
    const r=JSON.parse(row.resource),replica=db.prepare("SELECT 1 FROM mesh_replicas WHERE key=? AND status='ready'").get(row.key);
    for(const source of db.prepare('SELECT peer FROM mesh_sources WHERE key=? AND seen>?').all(row.key,now()-staleSeconds)){const peer=peers.find(p=>p.providerID===source.peer);if(peer)r.sources.push(`${peer.url}/v1/mesh/objects/${row.key}`);}
    if(replica)r.sources.unshift(`${publicURL.origin}/v1/mesh/objects/${row.key}`);
    // Keep the local verified copy first and the original source second, within client bounds.
    r.sources=[...new Set(r.sources)].slice(0,8);
    r.replicas=replica?[{providerID,url:publicURL.origin,sourceResourceID:row.key,verifiedAt:new Date(db.prepare('SELECT updated FROM mesh_replicas WHERE key=?').get(row.key).updated*1000).toISOString(),status:'hash-verified-custody'}]:[];
    r.originDescriptor=JSON.parse(row.descriptor);
    return {...r,originAvailable:peerStatus.get(row.origin)?.online??false,replicaProviderID:replica?providerID:null};
  });}
  function catalogue(url){
    const query=url.searchParams.get('q')??'',sort=url.searchParams.get('sort')??'recent',limit=Number(url.searchParams.get('limit')??30),cursor=Number(url.searchParams.get('cursor')??0);
    if(query.length>200||!['recent','downloads','trending'].includes(sort)||!Number.isSafeInteger(limit)||limit<1||limit>100||!Number.isSafeInteger(cursor)||cursor<0||cursor>1000000)throw fail(400,'invalid_search');
    const terms=query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean), clauses=terms.map(()=>"LOWER(COALESCE(json_extract(metadata,'$.title'),'') || ' ' || COALESCE(json_extract(metadata,'$.summary'),'') || ' ' || COALESCE(json_extract(metadata,'$.language'),'') || ' ' || COALESCE(json_extract(metadata,'$.tags'),'')) LIKE ? ESCAPE '\\'");
    const filters=terms.map(t=>`%${t.replace(/[\\%_]/g,'\\$&')}%`);
    // SQLite selects only this page. Do not load every local manifest into the HTTP process.
    const order=sort==='downloads'?'downloads DESC,created DESC':sort==='trending'?'score DESC,created DESC':'created DESC';
    const rows=db.prepare(`WITH combined AS (
      SELECT 'local' AS kind,r.id AS key,r.metadata AS metadata,r.created,r.downloads,
      COALESCE((SELECT SUM(1.0/(1.0+(?-e.created)/172800.0)) FROM download_events e WHERE e.resource=r.id AND e.created>=?),0) AS score
      FROM resources r WHERE visibility='public'
      UNION ALL
      SELECT 'remote',m.key,m.resource,CAST(strftime('%s',json_extract(m.resource,'$.createdAt')) AS INTEGER),0,0 FROM mesh_records m
      WHERE m.seen>? AND NOT EXISTS(SELECT 1 FROM resources r WHERE r.id=m.id)
    ) SELECT kind,key FROM combined ${clauses.length?'WHERE '+clauses.join(' AND '):''} ORDER BY ${order},key LIMIT ? OFFSET ?`).all(now(),now()-30*86400,now()-7*86400,...filters,limit+1,cursor);
    const items=rows.slice(0,limit).map(row=>{
      if(row.kind==='local'){const r=db.prepare('SELECT * FROM resources WHERE id=?').get(row.key);return {...resourceResponse(r),originProviderID:providerID,originURL:publicURL.origin,publisherAuthentication:db.prepare('SELECT 1 FROM publication_auth WHERE id=?').get(r.id)?'signed-upload-request':'legacy-node-record',originDescriptor:localDescriptor(r),replicas:[]};}
      return publicItems(row.key)[0];
    }).filter(Boolean);
    return {items,nextCursor:rows.length>limit?String(cursor+limit):null,rankingScope:'local-observed-activity',federation:true};
  }
  async function route(req,res,url,{body,parse,authenticate,json}){
    if(req.method==='GET'&&url.pathname==='/v1/mesh/resources'){json(res,200,signed({schemaVersion:1,type:'ats-mesh-catalogue-v1',providerID,issuedAt:now(),expiresAt:now()+300,...catalogue(url)},providerKey,providerPublicKey));return true;}
    if(req.method==='GET'&&url.pathname==='/v1/stats'){json(res,200,{schemaVersion:1,draining,published:db.prepare('SELECT visibility,COUNT(*) AS count,COALESCE(SUM(bytes),0) AS byteCount FROM resources GROUP BY visibility').all(),activeLeases:db.prepare('SELECT COUNT(*) AS count FROM retention_orders WHERE until>?').get(now()).count,replicas:db.prepare('SELECT status,COUNT(*) AS count,COALESCE(SUM(bytes),0) AS byteCount FROM mesh_replicas GROUP BY status').all(),quotaBytes:totalQuota});return true;}
    if(req.method==='GET'&&url.pathname==='/v1/mesh/announcement'){json(res,200,signed({schemaVersion:1,type:'ats-node-announcement-v1',providerID,publicURL:publicURL.origin,generatedAt:now(),draining,desiredReplicas:desired,peers:peers.map(p=>p.providerID)},providerKey,providerPublicKey));return true;}
    if(req.method==='GET'&&url.pathname==='/v1/mesh/snapshot'){
      const offset=Number(url.searchParams.get('cursor')??0);if(!Number.isSafeInteger(offset)||offset<0||offset>1000000||offset%100)throw fail(400,'invalid_cursor');json(res,200,snapshot(offset));return true;
    }
    if(req.method==='GET'&&url.pathname==='/v1/mesh/status'){json(res,200,{schemaVersion:1,draining,desiredReplicas:desired,replicaProof:'observed-custody-not-independent-replicas',lastSync,lastError,syncing,peers:peers.map(p=>({...p,...peerStatus.get(p.providerID)})),catalogueCount:db.prepare('SELECT COUNT(*) AS n FROM mesh_records').get().n,replicas:db.prepare('SELECT status,COUNT(*) AS count,COALESCE(SUM(bytes),0) AS byteCount FROM mesh_replicas GROUP BY status').all()});return true;}
    if(req.method==='POST'&&url.pathname==='/v1/mesh/sync'){
      const bytes=await body(req,1024);const owner=authenticate(req,url,bytes);if(!(process.env.NODE_ADMIN_PUBLIC_KEYS??'').split(',').includes(owner))throw fail(403,'administrator_required');void sync();json(res,202,{scheduled:true});return true;
    }
    const object=/^\/v1\/mesh\/objects\/([a-f0-9]{64})$/.exec(url.pathname);
    if(req.method==='GET'&&object){
      const key=object[1],r=db.prepare("SELECT * FROM mesh_replicas WHERE key=? AND status='ready'").get(key),record=db.prepare('SELECT 1 FROM mesh_records WHERE key=?').get(key);if(!r||!record)throw fail(404,'replica_not_found');
      let start=0,end=r.bytes-1,status=200;
      if(req.headers.range){const match=/^bytes=(\d+)-(\d*)$/.exec(req.headers.range);if(!match)throw fail(416,'invalid_range');start=Number(match[1]);end=match[2]?Math.min(Number(match[2]),end):end;if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||start>end||start>=r.bytes)throw fail(416,'invalid_range');status=206;}
      const file=await open(recordPath(key),'r');if((await file.stat()).size!==r.bytes){await file.close();throw fail(503,'replica_unavailable');}
      res.writeHead(status,{'Content-Type':'application/vnd.anyaudiobooks.book','Content-Length':end-start+1,'Accept-Ranges':'bytes',ETag:`"${r.sha}"`,'Cache-Control':'public, max-age=3600','X-Content-Type-Options':'nosniff',...(status===206?{'Content-Range':`bytes ${start}-${end}/${r.bytes}`}:{})});
      const {pipeline}=await import('node:stream/promises');await pipeline(file.createReadStream({start,end,autoClose:true}),res);return true;
    }
    if(req.method==='POST'&&url.pathname==='/v1/retention/quotes'){
      const bytes=await body(req,4096),owner=authenticate(req,url,bytes),v=parse(bytes),r=db.prepare('SELECT * FROM resources WHERE id=? AND owner=?').get(v.resourceID,owner);
      if(draining)throw fail(503,'node_draining');if(!r)throw fail(404,'resource_not_found');
      if(!Number.isSafeInteger(v.retainUntil)||v.retainUntil<now()+3600||v.retainUntil>now()+366*86400)throw fail(400,'invalid_retention_period');
      db.prepare('DELETE FROM retention_quotes WHERE expires<?').run(now());if(db.prepare('SELECT COUNT(*) AS n FROM retention_quotes WHERE owner=?').get(owner).n>=32)throw fail(429,'publisher_quote_capacity');if(db.prepare('SELECT COUNT(*) AS n FROM retention_quotes').get().n>=maxEntries)throw fail(429,'quote_capacity');
      const id=randomUUID();db.prepare('INSERT INTO retention_quotes VALUES(?,?,?,?,?,?)').run(id,owner,r.id,v.retainUntil,now()+900,r.bytes);
      json(res,201,signed({schemaVersion:1,type:'ats-retention-quote',quoteID:id,providerID,resourceID:r.id,publisherID:owner,sha256:r.sha,byteCount:r.bytes,retainUntil:v.retainUntil,expiresAt:now()+900,priceMode:'external-settlement-required'},providerKey,providerPublicKey));return true;
    }
    if(req.method==='POST'&&url.pathname==='/v1/retention/orders'){
      const bytes=await body(req,16384),owner=authenticate(req,url,bytes),v=parse(bytes);
      const q=db.prepare('SELECT * FROM retention_quotes WHERE id=? AND owner=? AND expires>?').get(v.quoteID,owner,now());if(!q)throw fail(404,'quote_expired_or_missing');
      const trusted=new Set((process.env.NODE_SETTLEMENT_PUBLIC_KEYS??'').split(',').filter(Boolean));
      const {payload:p}=verified(v.settlementReceipt,trusted,8192),r=db.prepare('SELECT * FROM resources WHERE id=? AND owner=?').get(q.resource,owner);
      if(!r||p.schemaVersion!==1||p.type!=='ats-retention-lease'||p.providerID!==providerID||p.resourceID!==q.resource||p.publisherID!==owner||p.sha256!==r.sha||p.byteCount!==r.bytes||p.retainUntil!==q.until||!uuid.test(p.orderID))throw fail(400,'invalid_settlement_receipt');
      if(!Number.isSafeInteger(p.chainId)||p.chainId<1||!/^0x[0-9a-fA-F]{40}$/.test(p.market??'')||typeof p.serviceOrderID!=='string'||!/^0x[0-9a-fA-F]{64}$/.test(p.serviceOrderID)||!Number.isSafeInteger(p.leaseNonce)||p.leaseNonce<1||!Number.isSafeInteger(p.issuedAt)||p.issuedAt<now()-3600||p.issuedAt>now()+300)throw fail(400,'invalid_lease_domain');
      const domain=`${p.chainId}:${p.market.toLowerCase()}:${p.serviceOrderID.toLowerCase()}`,prior=db.prepare('SELECT * FROM retention_nonces WHERE domain=?').get(domain);
      const existing=db.prepare('SELECT * FROM retention_orders WHERE id=?').get(p.orderID);
      if(existing&&existing.receipt===JSON.stringify(v.settlementReceipt)){json(res,200,{orderID:p.orderID,resourceID:r.id,retainUntil:q.until,status:q.until>now()?'active':'expired'});return true;}
      if(prior&&(p.leaseNonce<=prior.nonce||p.retainUntil<prior.until))throw fail(409,'lease_replay_or_regression');
      if(db.prepare('SELECT COUNT(*) AS n FROM retention_orders').get().n>=maxEntries)throw fail(429,'order_capacity');
      if(draining)throw fail(503,'node_draining');
      const conflict=db.prepare('SELECT * FROM retention_orders WHERE id=?').get(p.orderID);if(conflict&&conflict.receipt!==JSON.stringify(v.settlementReceipt))throw fail(409,'order_conflict');
      db.exec('BEGIN IMMEDIATE');
      try{db.prepare('INSERT INTO retention_orders VALUES(?,?,?,?,?,?)').run(p.orderID,owner,r.id,q.until,JSON.stringify(v.settlementReceipt),now());db.prepare('INSERT INTO retention_nonces VALUES(?,?,?) ON CONFLICT(domain) DO UPDATE SET nonce=excluded.nonce,until=excluded.until').run(domain,p.leaseNonce,p.retainUntil);db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
      json(res,201,{orderID:p.orderID,resourceID:r.id,retainUntil:q.until,status:'active',renewal:'new-funded-quote-required'});return true;
    }
    if(req.method==='GET'&&url.pathname==='/v1/retention/orders'){
      const owner=authenticate(req,url,Buffer.alloc(0));json(res,200,{items:db.prepare('SELECT id AS orderID,resource AS resourceID,until AS retainUntil FROM retention_orders WHERE owner=? ORDER BY until DESC LIMIT 100').all(owner).map(r=>({...r,status:r.retainUntil>now()?'active':'expired'}))});return true;
    }
    return false;
  }
  const timer=setInterval(()=>sync().catch(()=>{lastError='mesh_sync_failed';}),interval*1000);timer.unref();
  const initial=setTimeout(()=>sync().catch(()=>{lastError='mesh_sync_failed';}),200);initial.unref();
  return {route,publicItems,catalogue,draining,reservedBytes:()=>db.prepare('SELECT COALESCE(SUM(bytes),0) AS n FROM mesh_replicas').get().n,proofFrom,recordAuth:(id,proof)=>db.prepare('INSERT INTO publication_auth VALUES(?,?)').run(id,JSON.stringify(proof)),remove:(id,isPublic)=>{db.prepare('DELETE FROM publication_auth WHERE id=?').run(id);if(!isPublic)return;db.prepare('INSERT OR REPLACE INTO mesh_tombstones VALUES(?,?)').run(id,now());db.prepare('DELETE FROM mesh_tombstones WHERE created<?').run(now()-30*86400);db.prepare('DELETE FROM mesh_tombstones WHERE id IN (SELECT id FROM mesh_tombstones ORDER BY created DESC LIMIT -1 OFFSET ?)').run(maxEntries);},hasLease:id=>!!db.prepare('SELECT 1 FROM retention_orders WHERE resource=? AND until>?').get(id,now()),close:()=>{clearInterval(timer);clearTimeout(initial);}};
}
