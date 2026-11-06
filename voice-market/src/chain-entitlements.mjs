import { getAddress } from 'ethers';
import { kindCode, packageKey, readOrderState } from './chain-settlement.mjs';

const unavailable = code => Object.assign(Error(code), { code, status: 503 });

// Reconcile before returning certificates or granting downloads. A historical signed
// certificate is evidence of issuance, never a replacement for current entitlement.
export async function reconcileChainOrders(db, chain, orders) {
  for (const order of orders) {
    const row = db.prepare('SELECT * FROM chain_settlements WHERE order_id=?').get(order.id);
    if (!row) continue;
    if (!chain || row.chain_id !== chain.chainID || getAddress(row.contract) !== getAddress(chain.address)) {
      throw unavailable('settlement_configuration_unavailable');
    }
    const buyer = db.prepare('SELECT address FROM wallet_bindings WHERE subject=?').get(order.buyer);
    const holder = db.prepare('SELECT w.address FROM packages p JOIN wallet_bindings w ON w.subject=p.holder WHERE p.id=? AND p.version=?').get(order.package, order.version);
    if (!buyer || !holder) throw unavailable('settlement_binding_unavailable');
    const state = await readOrderState(chain, row.onchain_order_id, {
      buyer: buyer.address, holder: holder.address,
      packageId: packageKey(order.package, order.version, holder.address),
      kind: kindCode(order.kind), ledgerUnits: order.amount
    });
    if (state.status === 'refunded') {
      db.prepare("UPDATE orders SET status='refunded' WHERE id=? AND status='active'").run(order.id);
      order.status = 'refunded';
    }
    // A local revocation cannot be undone by a later read or changed configuration.
  }
  return orders;
}
