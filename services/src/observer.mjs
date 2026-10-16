import { readFile } from 'node:fs/promises';
import { Wallet, Contract, ZeroHash } from 'ethers';
import { boundedFetch, rawKey, edKey, sha, now, hashDownload } from './common.mjs';
import { verify, randomInt } from 'node:crypto';

export class Observer {
  constructor(db, chain, catalog, identity, config, signer) {
    Object.assign(this, { db, chain, catalog, identity, config, signer });
    this.market = new Contract(chain.contracts.storage.address, chain.contracts.storage.abi, signer);
    this.status = { state: 'starting', address: signer.address };
    db.exec(`CREATE TABLE IF NOT EXISTS observations(orderID TEXT NOT NULL,period INTEGER NOT NULL,slot INTEGER NOT NULL,target INTEGER NOT NULL,checked INTEGER NOT NULL,successful INTEGER NOT NULL,evidence TEXT NOT NULL,PRIMARY KEY(orderID,period,slot));
      CREATE TABLE IF NOT EXISTS observer_reports(candidate TEXT PRIMARY KEY,orderID TEXT NOT NULL,payload TEXT NOT NULL,txHash TEXT,created INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS observer_actions(key TEXT PRIMARY KEY,txHash TEXT,created INTEGER NOT NULL);`);
  }
  static async create(db, chain, catalog, identity, config) {
    if (!config.observerKeyFile && !config.observerPrivateKey) return null;
    const raw = config.observerKeyFile ? (await readFile(config.observerKeyFile, 'utf8')).trim() : config.observerPrivateKey;
    const signer = new Wallet(raw, chain.provider);
    if (!(await chain.contracts.storage.reader.observers(signer.address))) throw new Error('observer_not_authorized');
    return new Observer(db, chain, catalog, identity, config, signer);
  }
  async audit(order, orderID, index, slot, target, metadata, periodEnd) {
    let success = false, errorCode = null, providerID = null;
    const checked = now();
    try {
      const providerBinding = await this.chain.confirmedCall('identity', 'bindings', order.provider);
      if (!(await this.chain.confirmedCall('identity', 'isActive', order.provider))) throw new Error('provider_binding_inactive');
      providerID = providerBinding.fingerprint.slice(2);
      const dualBinding = await this.catalog.bindingVerifier(providerID, order.provider);
      if (!dualBinding.edProofVerified || dualBinding.wallet.toLowerCase() !== order.provider.toLowerCase()) throw new Error('provider_dual_signature_not_verified');
      const node = this.catalog.nodes.find(n => n.providerID === providerID);
      if (!node || !metadata.sources.some(s => s.providerID === providerID && s.nodeURL === node.url)) throw new Error('unapproved_order_provider');
      const source = metadata.sources.find(s => s.providerID === providerID);
      const { bytes } = await boundedFetch(`${node.url}/v1/resources/${source.resourceID}/evidence`, 32768);
      const envelope = JSON.parse(bytes), key = rawKey(envelope.publicKey), proof = Buffer.from(envelope.evidenceBytes, 'base64');
      if (sha(key) !== providerID || proof.length > 16384 || sha(proof) !== envelope.evidenceHash || !verify(null, proof, edKey(key), Buffer.from(envelope.signature, 'base64'))) throw new Error('untrusted_provider_evidence');
      const evidence = JSON.parse(proof);
      if (evidence.sha256 !== metadata.sha256 || evidence.byteCount !== metadata.byteCount || evidence.publicationID !== source.resourceID || evidence.providerID !== providerID || Math.abs(now() - Date.parse(evidence.observedAt) / 1000) > 300) throw new Error('substituted_provider_evidence');
      await hashDownload(`${node.url}/v1/resources/${source.resourceID}/download`, metadata.byteCount, metadata.sha256);
      if (Number((await this.chain.provider.getBlock('latest')).timestamp) >= periodEnd) throw new Error('audit_completed_after_period');
      success = true;
    } catch (error) { errorCode = String(error.code ?? error.message).slice(0, 100); }
    const report = this.identity.envelope({ schemaVersion: 1, type: 'ats-observation-v1', observer: this.signer.address, chainId: this.chain.manifest.chainId, market: this.market.target, orderID, periodIndex: index, slot, target, observedAt: checked, providerID, archiveHash: order.archiveHash, byteCount: metadata.byteCount, success, errorCode, policy: 'full-sha256-v1' });
    this.db.prepare('INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?,?,?)').run(orderID, index, slot, target, checked, success ? 1 : 0, JSON.stringify(report));
  }
  async tick() {
    try {
      if (this.chain.status.state !== 'ready') { this.status.state = 'waiting_for_chain'; return; }
      if (!(await this.market.observers(this.signer.address))) { this.status.state = 'unauthorized'; return; }
      const balance = await this.chain.provider.getBalance(this.signer.address);
      if (balance === 0n) { this.status.state = 'insufficient_gas'; return; }
      const latest = await this.chain.provider.getBlock('latest'), clock = Number(latest.timestamp);
      const opened = this.chain.events('OrderOpened').filter(e => e.contract === 'storage');
      let work = 0;
      for (const event of opened) {
        if (work >= this.config.maxObserverWork) break;
        const id = event.args.orderId;
        const order = await this.chain.confirmedCall('storage', 'orders', id);
        if (order.closed || order.provider.toLowerCase() === this.signer.address.toLowerCase()) continue;
        const index = Number(order.settledPeriods), [from, to] = await this.market.periodTimes(id, index);
        const publication = await this.chain.confirmedCall('publication', 'publications', order.publicationId);
        const row = this.db.prepare('SELECT bytes FROM metadata WHERE hash=?').get(publication.metadataHash.slice(2));
        if (!row) continue;
        const metadata = JSON.parse(Buffer.from(row.bytes, 'base64'));
        if (metadata.sha256 !== order.archiveHash.slice(2) || metadata.byteCount > this.config.maximumAuditBytes) continue;
        // Persisted randomly jittered schedule; never fill missed historic samples after a restart.
        const scheduleKey = `audit-schedule:${id}:${index}`;
        let schedule = this.db.prepare('SELECT value FROM service_state WHERE key=?').get(scheduleKey);
        if (!schedule) {
          const length = Number(to - from), samples = this.config.auditSamples;
          const targets = Array.from({ length: samples }, (_, slot) => Number(from) + Math.floor(length * (slot + 0.2 + randomInt(0, 600) / 1000) / samples));
          this.db.prepare('INSERT OR IGNORE INTO service_state VALUES(?,?)').run(scheduleKey, JSON.stringify(targets));
          schedule = { value: JSON.stringify(targets) };
        }
        const targets = JSON.parse(schedule.value);
        for (let slot = 0; slot < targets.length && work < this.config.maxObserverWork; slot++) {
          if (this.db.prepare('SELECT 1 FROM observations WHERE orderID=? AND period=? AND slot=?').get(id, index, slot)) continue;
          const target = targets[slot];
          if (clock < target) continue;
          const window = Math.max(5, Math.floor(Number(to - from) / targets.length / 2));
          if (clock >= Number(to) || clock > target + window) {
            const missed = this.identity.envelope({ schemaVersion: 1, type: 'ats-observation-v1', orderID: id, periodIndex: index, slot, target, success: false, errorCode: 'missed_observation_window' });
            this.db.prepare('INSERT OR IGNORE INTO observations VALUES(?,?,?,?,?,?,?)').run(id, index, slot, target, now(), 0, JSON.stringify(missed));
          } else { await this.audit(order, id, index, slot, target, metadata, Number(to)); work++; }
        }
        if (clock < Number(to)) continue;
        const grace = Number(await this.market.reportGrace());
        if (clock > Number(to) + grace || clock - Number(to) > 3600) continue;
        const observations = this.db.prepare('SELECT * FROM observations WHERE orderID=? AND period=? ORDER BY slot').all(id, index);
        if (observations.length !== this.config.auditSamples) continue;
        const successful = observations.reduce((sum, value) => sum + value.successful, 0);
        // Shared policy commitment permits independent matching votes. Exact signed local
        // audit evidence is exposed separately; this remains a TRUSTED observer committee.
        const commitment = { schemaVersion: 1, policy: 'full-sha256-v1', chainId: this.chain.manifest.chainId, market: this.market.target, orderID: id, periodIndex: index, from: from.toString(), to: to.toString(), archiveHash: order.archiveHash, samples: observations.length, successful };
        const report = { orderId: id, periodIndex: index, from, to, observedAt: to, samples: observations.length, successful, evidenceHash: `0x${sha(Buffer.from(JSON.stringify(commitment)))}` };
        const candidate = await this.market.reportCandidate(report);
        const pending = await this.market.pending(id);
        if (pending.candidate !== ZeroHash && pending.generation === await this.market.committeeGeneration() && pending.round === await this.market.rounds(id)) {
          if (this.config.settle && !pending.challenged && clock >= Number(pending.readyAt)) {
            // Never settle a provider self-report: only contract-approved committee reports.
            if (BigInt(await this.market.approvals(pending.candidate)) >= BigInt(await this.market.threshold())) {
              await (await this.market.settlePeriod(id)).wait(this.config.transactionConfirmations);
            }
          }
          continue;
        }
        if (await this.market.votes(candidate, this.signer.address)) continue;
        const signed = this.identity.envelope({ ...commitment, observer: this.signer.address, candidate, observations: observations.map(o => JSON.parse(o.evidence)) });
        this.db.prepare('INSERT OR IGNORE INTO observer_reports VALUES(?,?,?,?,?)').run(candidate, id, JSON.stringify(signed), null, now());
        const canonicalBlock = await this.chain.provider.getBlock(event.height);
        if (canonicalBlock?.hash !== event.blockHash) throw new Error('order_event_reorged_before_vote');
        const liveOrder = await this.market.orders(id);
        for (const name of ['requester', 'provider', 'publicationId', 'archiveHash', 'start', 'end', 'period', 'settledPeriods', 'amount', 'remaining', 'closed']) if (String(liveOrder[name]) !== String(order[name])) throw new Error('live_order_changed_before_vote');
        const tx = await this.market.attestPeriod(report);
        this.db.prepare('UPDATE observer_reports SET txHash=? WHERE candidate=?').run(tx.hash, candidate);
        await tx.wait(this.config.transactionConfirmations);
        work++;
      }
      this.status = { state: 'ready', address: this.signer.address, work, balanceWei: balance.toString() };
    } catch (error) {
      this.status = { state: error.code === 'INSUFFICIENT_FUNDS' ? 'insufficient_gas' : 'retry_pending', address: this.signer.address, error: String(error.code ?? error.shortMessage ?? error.message).slice(0, 100) };
    }
  }
}
