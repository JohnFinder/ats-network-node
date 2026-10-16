import { readFile } from 'node:fs/promises';
import { Contract, Wallet, ZeroHash } from 'ethers';

// Permissionless coordinator: this key can only pay its own gas. It cannot mint,
// attest, resolve challenges, or bypass the market's threshold/review conditions.
export class Settlement {
  constructor(chain, signer, confirmations) {
    this.chain = chain; this.signer = signer; this.confirmations = confirmations;
    this.market = new Contract(chain.contracts.storage.address, chain.contracts.storage.abi, signer);
    this.status = { state: 'starting', address: signer.address };
  }
  static async create(chain, config) {
    if (!config.settlementKeyFile) return null;
    const key = (await readFile(config.settlementKeyFile, 'utf8')).trim();
    return new Settlement(chain, new Wallet(key, chain.provider), config.transactionConfirmations);
  }
  async tick() {
    if (this.chain.status.state !== 'ready') { this.status.state = 'waiting_for_chain'; return; }
    try {
      if (await this.chain.provider.getBalance(this.signer.address) === 0n) { this.status.state = 'insufficient_gas'; return; }
      const block = await this.chain.provider.getBlock('latest');
      for (const event of this.chain.events('OrderOpened').filter(e => e.contract === 'storage')) {
        const id = event.args.orderId, order = await this.market.orders(id), pending = await this.market.pending(id);
        if (order.closed || pending.candidate === ZeroHash || pending.challenged || pending.generation !== await this.market.committeeGeneration() || pending.round !== await this.market.rounds(id) || pending.readyAt > BigInt(block.timestamp)) continue;
        if (await this.market.approvals(pending.candidate) < await this.market.threshold()) continue;
        const tx = await this.market.settlePeriod(id); await tx.wait(this.confirmations);
        this.status = { state: 'ready', address: this.signer.address, lastOrder: id, lastTransaction: tx.hash }; return;
      }
      this.status = { state: 'ready', address: this.signer.address };
    } catch (error) { this.status = { state: error.code === 'INSUFFICIENT_FUNDS' ? 'insufficient_gas' : 'retry_pending', address: this.signer.address, error: String(error.code ?? error.shortMessage ?? error.message).slice(0, 100) }; }
  }
}
