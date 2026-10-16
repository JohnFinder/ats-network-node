import { readFile } from 'node:fs/promises';
import { JsonRpcProvider, Contract, Interface, keccak256 } from 'ethers';
import { integer } from './common.mjs';

export class ChainIndex {
  constructor(db, provider, manifest, contracts, confirmations) {
    Object.assign(this, { db, provider, manifest, contracts, confirmations });
    db.exec(`CREATE TABLE IF NOT EXISTS blocks(height INTEGER PRIMARY KEY,hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS chain_events(height INTEGER NOT NULL,blockHash TEXT NOT NULL,txHash TEXT NOT NULL,logIndex INTEGER NOT NULL,contract TEXT NOT NULL,name TEXT NOT NULL,args TEXT NOT NULL,PRIMARY KEY(txHash,logIndex));
      CREATE INDEX IF NOT EXISTS event_height ON chain_events(height);
      CREATE TABLE IF NOT EXISTS service_state(key TEXT PRIMARY KEY,value TEXT NOT NULL);`);
    this.status = { state: 'starting', indexedHeight: -1, confirmations };
  }
  static async connect(db, config) {
    // RPC is exclusively operator configuration; deployment metadata cannot choose an endpoint.
    if (!config.rpc || !config.manifestFile) throw new Error('explicit_rpc_and_manifest_required');
    const rpc = new URL(config.rpc);
    if (!['http:', 'https:'].includes(rpc.protocol) || rpc.username || rpc.password) throw new Error('invalid_rpc');
    const manifestBytes = await readFile(config.manifestFile);
    if (manifestBytes.length > 1024 * 1024) throw new Error('manifest_too_large');
    const manifest = JSON.parse(manifestBytes);
    const chainId = BigInt(config.chainId);
    if (BigInt(manifest.chainId) !== chainId) throw new Error('manifest_chain_mismatch');
    const provider = new JsonRpcProvider(config.rpc, chainId, { cacheTimeout: -1, pollingInterval: 250 });
    if ((await provider.getNetwork()).chainId !== chainId) throw new Error('rpc_chain_mismatch');
    const contracts = {};
    for (const [manifestKey, entry] of Object.entries(manifest.contracts ?? {})) {
      const aliases = { ATSIdentityRegistry: 'identity', ATSPublicationRegistry: 'publication', ATSStorageMarket: 'storage', ATSRewardVault: 'rewards', ATSPublisherTasks: 'tasks', ATNTestToken: 'token', registry: 'publication' };
      const key = aliases[manifestKey] ?? manifestKey;
      if (!['identity', 'publication', 'storage', 'rewards', 'tasks', 'token'].includes(key)) continue;
      if (!Array.isArray(entry.abi) && key === 'token') entry.abi = ['function balanceOf(address) view returns (uint256)', 'function allowance(address,address) view returns (uint256)', 'function approve(address,uint256) returns (bool)', 'function decimals() view returns (uint8)', 'function symbol() view returns (string)'];
      if (!entry.address || !entry.codeHash || !Array.isArray(entry.abi)) throw new Error(`manifest_missing_commitments_${key}`);
      if (keccak256(await provider.getCode(entry.address)) !== entry.codeHash) throw new Error(`contract_codehash_mismatch_${key}`);
      contracts[key] = { ...entry, interface: new Interface(entry.abi), reader: new Contract(entry.address, entry.abi, provider) };
    }
    if (!contracts.identity || !contracts.publication || !contracts.storage) throw new Error('missing_v2_contracts');
    integer(manifest.deploymentBlock, undefined, Number.MAX_SAFE_INTEGER, 0);
    const index = new ChainIndex(db, provider, manifest, contracts, integer(config.confirmations, 12, 1024, 0));
    const commitment = JSON.stringify({ chainId: chainId.toString(), deploymentBlock: manifest.deploymentBlock, contracts: Object.fromEntries(Object.entries(contracts).map(([k, v]) => [k, [v.address, v.codeHash]])) });
    const existing = db.prepare("SELECT value FROM service_state WHERE key='deployment'").get();
    if (existing && existing.value !== commitment) throw new Error('database_deployment_mismatch_use_new_volume');
    db.prepare("INSERT OR IGNORE INTO service_state VALUES('deployment',?)").run(commitment);
    return index;
  }
  events(name) {
    return this.db.prepare('SELECT * FROM chain_events WHERE name=? ORDER BY height,logIndex').all(name).map(row => ({ ...row, args: JSON.parse(row.args) }));
  }
  async tick() {
    try {
      // Revalidate code each poll: self-destruct/redeployment or operator RPC changes fail closed.
      for (const c of Object.values(this.contracts)) if (keccak256(await this.provider.getCode(c.address)) !== c.codeHash) throw new Error('contract_code_changed');
      const tip = await this.provider.getBlockNumber(), target = tip - this.confirmations;
      let last = this.db.prepare('SELECT * FROM blocks ORDER BY height DESC LIMIT 1').get();
      let rollback = 0;
      while (last) {
        const block = await this.provider.getBlock(last.height);
        if (block?.hash === last.hash) break;
        this.db.exec('BEGIN IMMEDIATE');
        try {
          this.db.prepare('DELETE FROM chain_events WHERE height>=?').run(last.height);
          this.db.prepare('DELETE FROM blocks WHERE height>=?').run(last.height);
          // Atomically invalidate all derived financial evidence. Numeric order IDs can
          // be reused on the replacement branch and must never inherit old success.
          for (const table of ['observations', 'observer_reports', 'observer_actions', 'lease_receipts', 'catalog_checks']) if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) this.db.exec(`DELETE FROM ${table}`);
          this.db.exec("DELETE FROM service_state WHERE key LIKE 'audit-schedule:%'");
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        rollback++;
        last = this.db.prepare('SELECT * FROM blocks ORDER BY height DESC LIMIT 1').get();
      }
      let start = last ? last.height + 1 : this.manifest.deploymentBlock;
      // Bound work per tick and retain every processed block hash for arbitrarily deep reorg recovery.
      const end = Math.min(target, start + 127);
      for (let height = start; height <= end; height++) {
        const block = await this.provider.getBlock(height);
        if (!block || (last && block.parentHash !== last.hash)) throw new Error('chain_changed_during_index');
        const logs = await this.provider.getLogs({ fromBlock: height, toBlock: height, address: Object.values(this.contracts).map(v => v.address) });
        this.db.exec('BEGIN IMMEDIATE');
        try {
          for (const log of logs) {
            if (log.blockHash !== block.hash) throw new Error('chain_changed_during_logs');
            const contract = Object.entries(this.contracts).find(([, c]) => c.address.toLowerCase() === log.address.toLowerCase());
            const event = contract[1].interface.parseLog(log);
            if (!event) continue;
            const args = Object.fromEntries(event.fragment.inputs.map((input, i) => [input.name || String(i), event.args[i]]));
            this.db.prepare('INSERT OR IGNORE INTO chain_events VALUES(?,?,?,?,?,?,?)').run(height, block.hash, log.transactionHash, log.index, contract[0], event.name, JSON.stringify(args, (_, value) => typeof value === 'bigint' ? value.toString() : value));
          }
          this.db.prepare('INSERT INTO blocks VALUES(?,?)').run(height, block.hash);
          this.db.prepare('INSERT OR REPLACE INTO service_state VALUES(?,?)').run(`blocktime:${height}`, String(block.timestamp));
          this.db.exec('COMMIT');
        } catch (error) { this.db.exec('ROLLBACK'); throw error; }
        last = { height, hash: block.hash };
      }
      this.status = { state: 'ready', tip, indexedHeight: last?.height ?? this.manifest.deploymentBlock - 1, confirmations: this.confirmations, rollbackBlocks: rollback };
    } catch (error) { this.status = { ...this.status, state: 'unavailable', error: error.code ?? error.message.slice(0, 100) }; throw error; }
  }
  async confirmedCall(contract, method, ...args) {
    if (this.status.state !== 'ready' || this.status.indexedHeight < this.manifest.deploymentBlock) throw new Error('chain_index_not_ready');
    return this.contracts[contract].reader[method](...args, { blockTag: this.status.indexedHeight });
  }
  rewind(height = this.manifest.deploymentBlock) {
    integer(height, undefined, Number.MAX_SAFE_INTEGER, this.manifest.deploymentBlock);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('DELETE FROM chain_events WHERE height>=?').run(height); this.db.prepare('DELETE FROM blocks WHERE height>=?').run(height);
      for (const table of ['observations', 'observer_reports', 'observer_actions', 'lease_receipts', 'catalog_checks']) if (this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) this.db.exec(`DELETE FROM ${table}`);
      this.db.exec("DELETE FROM service_state WHERE key LIKE 'audit-schedule:%'");
      this.db.exec('COMMIT');
    }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
