import { verify } from 'node:crypto';
import { boundedFetch, verifyEnvelope, rawKey, edKey, sha, digest, now, hashDownload } from './common.mjs';

export class Catalog {
  constructor(db, chain, identity, nodes, config) {
    Object.assign(this, { db, chain, identity, nodes, config });
    this.pendingChecks = new Map();
    db.exec(`CREATE TABLE IF NOT EXISTS metadata(hash TEXT PRIMARY KEY,bytes TEXT NOT NULL,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS catalog_checks(hash TEXT NOT NULL,node TEXT NOT NULL,checked INTEGER NOT NULL,valid INTEGER NOT NULL,PRIMARY KEY(hash,node));`);
  }
  async source(nodeURL, resourceID) {
    const node = this.nodes.find(node => node.url === nodeURL);
    if (!node || !/^[0-9a-f-]{36}$/i.test(resourceID)) throw new Error('unapproved_resource_source');
    // Only explicitly operator-approved nodes are contacted. Descriptor-provided origins cannot extend this list.
    for (let cursor = 0; cursor <= 9900; cursor += 100) {
      const { bytes } = await boundedFetch(`${node.url}/v1/mesh/snapshot?cursor=${cursor}`, 6 * 1024 * 1024);
      const snapshot = verifyEnvelope(JSON.parse(bytes), new Set([node.providerID])).payload;
      if (snapshot.type !== 'ats-mesh-snapshot-v1' || snapshot.providerID !== node.providerID || snapshot.originURL !== node.url || !Array.isArray(snapshot.items) || snapshot.items.length > 100 || Math.abs(now() - snapshot.generatedAt) > 300) throw new Error('invalid_source_snapshot');
      for (const envelope of snapshot.items) {
        const descriptor = verifyEnvelope(envelope, new Set([node.providerID])).payload;
        if (descriptor.resource?.id !== resourceID) continue;
        if (descriptor.type !== 'ats-publication-v1' || descriptor.originURL !== node.url || descriptor.originProviderID !== node.providerID) throw new Error('invalid_source_descriptor');
        const proof = descriptor.publisherProof, key = rawKey(proof.publicKey), body = Buffer.from(proof.bodyBytes, 'base64');
        if (body.length > 16384 || proof.audience !== node.url || proof.path !== '/v1/uploads' || proof.method !== 'POST') throw new Error('invalid_publisher_proof');
        const message = `ATS-NODE-V1\n${proof.audience}\nPOST\n/v1/uploads\n${proof.timestamp}\n${proof.nonce}\n${sha(body)}`;
        if (!verify(null, Buffer.from(message), edKey(key), Buffer.from(proof.signature, 'base64'))) throw new Error('invalid_publisher_proof');
        const original = JSON.parse(body), r = descriptor.resource;
        const string = (v, max, required = false) => {
          if ((v === undefined || v === null) && !required) return '';
          if (typeof v !== 'string' || v.length > max || (required && !v.trim()) || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(v)) throw new Error('invalid_signed_metadata');
          return v.trim();
        };
        if (!Array.isArray(original.tags) || original.tags.length > 16) throw new Error('invalid_signed_tags');
        const normalized = { title: string(original.title, 300, true), summary: string(original.summary, 4000), language: string(original.language, 64) || null, tags: [...new Set(original.tags.map(v => string(v, 64, true)))], encrypted: original.encrypted };
        if (r.publisherID !== sha(key) || r.sha256 !== original.sha256 || r.byteCount !== original.byteCount || original.visibility !== 'public' || r.visibility !== 'public') throw new Error('substituted_publication');
        for (const name of ['title', 'summary', 'language', 'encrypted']) if (r[name] !== normalized[name]) throw new Error('substituted_metadata');
        if (JSON.stringify(r.tags) !== JSON.stringify(normalized.tags)) throw new Error('substituted_metadata');
        if (!digest(r.sha256) || !Number.isSafeInteger(r.byteCount) || r.byteCount <= 0 || r.byteCount > this.config.maximumAuditBytes || typeof r.title !== 'string' || r.title.length > 500 || typeof r.summary !== 'string' || r.summary.length > 4000 || !Array.isArray(r.tags) || r.tags.length > 20) throw new Error('invalid_resource_metadata');
        const metadata = { schemaVersion: 1, title: r.title, summary: r.summary, language: r.language, tags: r.tags, publicationID: resourceID, publisherID: r.publisherID, sha256: r.sha256, byteCount: r.byteCount, encrypted: r.encrypted, sources: [{ nodeURL: node.url, providerID: node.providerID, resourceID }] };
        return { node, metadata };
      }
      if (snapshot.nextCursor === null) break;
      if (snapshot.nextCursor !== cursor + 100) throw new Error('invalid_source_cursor');
    }
    throw new Error('public_resource_not_found');
  }
  save(metadata) {
    const bytes = Buffer.from(JSON.stringify(metadata));
    if (bytes.length > 16384 || this.db.prepare('SELECT COUNT(*) AS n FROM metadata').get().n >= 100000) throw new Error('metadata_capacity_limit');
    const hash = sha(bytes);
    this.db.prepare('INSERT OR IGNORE INTO metadata VALUES(?,?,?)').run(hash, bytes.toString('base64'), now());
    return { hash: `0x${hash}`, bytes };
  }
  async check(metadata) {
    const hash = sha(Buffer.from(JSON.stringify(metadata)));
    const existing = this.pendingChecks.get(hash);
    if (existing) return existing;
    const fresh = this.db.prepare('SELECT node FROM catalog_checks WHERE hash=? AND valid=1 AND checked>?').get(hash, now() - this.config.catalogCheckSeconds / 2);
    if (fresh) {
      const node = this.nodes.find(n => n.providerID === fresh.node && metadata.sources.some(s => s.providerID === n.providerID && s.nodeURL === n.url));
      if (node) return node;
    }
    if (this.pendingChecks.size >= 2) throw new Error('audit_capacity_busy');
    const operation = (async () => {
      for (const source of metadata.sources) {
        const node = this.nodes.find(n => n.url === source.nodeURL && n.providerID === source.providerID);
        if (!node) continue;
        await hashDownload(`${node.url}/v1/resources/${source.resourceID}/download`, metadata.byteCount, metadata.sha256);
        this.db.prepare('INSERT OR REPLACE INTO catalog_checks VALUES(?,?,?,1)').run(hash, node.providerID, now());
        return node;
      }
      throw new Error('no_approved_source');
    })();
    this.pendingChecks.set(hash, operation);
    try { return await operation; } finally { this.pendingChecks.delete(hash); }
  }

  async list(query = '', cursor = 0, limit = 50) {
    if (this.chain.status.state !== 'ready') throw new Error('chain_unavailable');
    const items = [];
    const published = this.chain.events('Published').filter(event => event.contract === 'publication').reverse();
    for (const event of published) {
      const args = event.args, row = this.db.prepare('SELECT bytes FROM metadata WHERE hash=?').get(args.metadataHash.slice(2));
      if (!row) continue;
      const metadata = JSON.parse(Buffer.from(row.bytes, 'base64'));
      if (metadata.publisherID !== args.fingerprint?.slice(2) || metadata.sha256 !== args.archiveHash.slice(2)) continue;
      // Rebuild from canonical event log every query; rollback cannot leave materialized phantom publications.
      if (query && ![metadata.title, metadata.summary, metadata.language, ...metadata.tags].join(' ').toLocaleLowerCase().includes(query.toLocaleLowerCase())) continue;
      const checks = this.db.prepare('SELECT node,checked FROM catalog_checks WHERE hash=? AND valid=1 AND checked>?').all(args.metadataHash.slice(2), now() - this.config.catalogCheckSeconds);
      if (!checks.length) continue;
      items.push({ id: metadata.publicationID, ...metadata, visibility: 'public', sources: metadata.sources.filter(s => checks.some(c => c.node === s.providerID)).map(s => `${s.nodeURL}/v1/resources/${s.resourceID}/download`), createdAt: new Date(this.db.prepare('SELECT value FROM service_state WHERE key=?').get(`blocktime:${event.height}`)?.value * 1000 || 0).toISOString(), chainPublicationID: args.publicationId, publisherWallet: args.publisher, confirmedBlock: event.height, confirmedBlockHash: event.blockHash, metadataHash: args.metadataHash, downloads: null, rankingSource: 'chain-confirmed-newest', sourceChecks: checks });
    }
    return { schemaVersion: 1, type: 'ats-chain-catalog-v1', chainId: this.chain.manifest.chainId, generatedAt: now(), indexedHeight: this.chain.status.indexedHeight, items: items.slice(cursor, cursor + limit), nextCursor: items.length > cursor + limit ? cursor + limit : null };
  }
  async refresh() {
    // One bounded resource per cycle. Limits malicious large catalogs and avoids monopolizing bandwidth.
    const events = this.chain.events('Published').filter(e => e.contract === 'publication');
    for (const event of events) {
      const hash = event.args.metadataHash.slice(2);
      let row = this.db.prepare('SELECT bytes FROM metadata WHERE hash=?').get(hash);
      if (!row) {
        for (const peer of this.config.indexers ?? []) {
          try {
            const { bytes } = await boundedFetch(`${peer.url}/v2/metadata/${hash}`, 65536);
            const payload = verifyEnvelope(JSON.parse(bytes), new Set([peer.serviceID])).payload;
            const raw = Buffer.from(payload.metadataBytes, 'base64');
            if (payload.type !== 'ats-publication-metadata-v1' || payload.metadataHash !== hash || raw.length > 16384 || sha(raw) !== hash) throw new Error('invalid_remote_metadata');
            const metadata = JSON.parse(raw);
            if (metadata.sha256 !== event.args.archiveHash.slice(2) || metadata.publisherID !== event.args.fingerprint.slice(2) || !Array.isArray(metadata.sources) || metadata.sources.length > 32) throw new Error('metadata_chain_mismatch');
            for (const source of metadata.sources) {
              const trusted = await this.source(source.nodeURL, source.resourceID);
              if (sha(Buffer.from(JSON.stringify(trusted.metadata))) !== hash) throw new Error('metadata_source_mismatch');
            }
            this.save(metadata); row = { bytes: raw.toString('base64') }; break;
          } catch { /* A failed pinned peer cannot choose another endpoint or supply substituted bytes. */ }
        }
      }
      if (!row) continue;
      const checked = this.db.prepare('SELECT MAX(checked) AS last FROM catalog_checks WHERE hash=? AND valid=1').get(hash).last ?? 0;
      if (now() - checked < this.config.catalogCheckSeconds / 2) continue;
      try { await this.check(JSON.parse(Buffer.from(row.bytes, 'base64'))); }
      catch { this.db.prepare('DELETE FROM catalog_checks WHERE hash=?').run(hash); }
      break;
    }
  }
}
