import { randomUUID } from 'node:crypto';

// The ledger is a sandbox representation at hundredth-token settlement precision.
// It is not an ERC20 deployment or an assertion of on-chain balances.
export function createEconomy(db, { issuerID, sandbox }) {
  const timestamp = () => new Date().toISOString();
  const error = (code, status = 409) => { throw Object.assign(Error(code), { code, status }); };
  const supply = 100_000_000 * 100;
  const beneficiary = (name, fallback) => {
    const value = process.env[name] || fallback;
    if (!/^[0-9a-f]{64}$/.test(value)) throw Error(`Invalid ${name}`);
    return value;
  };
  const requestedPolicy = {
    schemaVersion: 1, policyID: 'sandbox-tatn-hundredths-v1', symbol: 'tATN', sandbox: true,
    issuerID, ledgerID: `ats-voice-market:${issuerID}`, chainID: null, network: 'offchain-sandbox', fixedSupplyScope: 'per-ledger',
    ledgerUnitsPerToken: 100, settlementPrecision: 2, contractDecimals: 18,
    onchainAtomicPerLedgerUnit: '10000000000000000', fixedSupplyTokens: 100000000,
    fixedSupplyLedgerUnits: supply, publisherBasisPoints: 8000, operatorBasisPoints: 1500,
    platformBasisPoints: 500, revenueHoldSeconds: 7 * 86400,
    operatorSubjectID: beneficiary('VOICE_MARKET_OPERATOR_SUBJECT', issuerID),
    platformSubjectID: beneficiary('VOICE_MARKET_PLATFORM_SUBJECT', issuerID),
    defaultNoncommercialPrice: 1000, defaultCommercialPrice: 5000,
    allocationLedgerUnits: 10000, withdrawalsEnabled: false, onchainDeployed: false,
    downloadRewardsEnabled: false, refundsAfterSettlement: false,
    legacyCreditLedgerUnits: 1
  };
  db.exec(`CREATE TABLE IF NOT EXISTS economy_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS order_economics(order_id TEXT PRIMARY KEY REFERENCES orders(id),holder TEXT NOT NULL,operator TEXT NOT NULL,platform TEXT NOT NULL,publisher_amount INTEGER NOT NULL,operator_amount INTEGER NOT NULL,platform_amount INTEGER NOT NULL,state TEXT NOT NULL,settle_after TEXT NOT NULL,policy TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS wallet_challenges(id TEXT PRIMARY KEY,subject TEXT NOT NULL,message TEXT NOT NULL,expires TEXT NOT NULL,used INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE IF NOT EXISTS wallet_bindings(subject TEXT PRIMARY KEY,address TEXT NOT NULL UNIQUE,proof TEXT NOT NULL,created TEXT NOT NULL);`);
  let policy;
  const balance = subject => db.prepare('SELECT COALESCE(SUM(amount),0) n FROM ledger WHERE subject=?').get(subject).n;
  const add = (subject, amount, kind, reference) => {
    if (!Number.isSafeInteger(amount)) error('invalid_ledger_amount');
    db.prepare('INSERT INTO ledger VALUES(?,?,?,?,?,?)').run(randomUUID(), subject, amount, kind, reference, timestamp());
  };
  const transfer = (from, to, amount, kind, reference) => {
    if (!Number.isSafeInteger(amount) || amount < 0 || balance(from) < amount) error('insufficient_transfer_reserve');
    if (!amount) return;
    add(from, -amount, kind, `${reference}:debit`);
    add(to, amount, kind, `${reference}:credit`);
  };
  const treasury = '@treasury';
  const holdAccount = (order, role) => `@held:${order}:${role}`;
  const splits = (amount, p) => {
    const publisher = Math.floor(amount * p.publisherBasisPoints / 10000);
    const operator = Math.floor(amount * p.operatorBasisPoints / 10000);
    return [publisher, operator, amount - publisher - operator];
  };
  db.exec('BEGIN IMMEDIATE');
  try {
    const stored = db.prepare("SELECT value FROM economy_meta WHERE key='policy'").get();
    if (stored) {
      policy = JSON.parse(stored.value);
      if (JSON.stringify(policy) !== JSON.stringify(requestedPolicy)) error('economic_policy_changed_requires_explicit_migration');
    } else {
      policy = requestedPolicy;
      // Keep every legacy row, amount, certificate and idempotency result unchanged.
      // Historical purchase rows burned credits; reconstruct their still-active reserves.
      const issued = db.prepare("SELECT COALESCE(SUM(amount),0) n FROM ledger WHERE kind='sandbox_credit'").get().n;
      if (!Number.isSafeInteger(issued) || issued < 0 || issued > supply) error('legacy_issuance_exceeds_fixed_supply');
      if (db.prepare('SELECT subject,SUM(amount) n FROM ledger GROUP BY subject HAVING n<0 LIMIT 1').get()) error('legacy_negative_balance');
      add(treasury, supply, 'genesis', 'economy-v1:genesis');
      if (issued) add(treasury, -issued, 'migration_allocation', 'economy-v1:legacy-allocation');
      for (const order of db.prepare('SELECT * FROM orders').all()) {
        const pack = db.prepare('SELECT holder FROM packages WHERE id=? AND version=?').get(order.package, order.version);
        if (!pack || !['active', 'refunded'].includes(order.status)) error('legacy_order_inconsistent');
        const [publisher, operator, platform] = splits(order.amount, policy);
        const state = order.status === 'active' ? 'reserved' : 'refunded';
        const settleAfter = new Date(Date.parse(order.created) + policy.revenueHoldSeconds * 1000).toISOString();
        db.prepare('INSERT INTO order_economics VALUES(?,?,?,?,?,?,?,?,?,?)').run(order.id, pack.holder, policy.operatorSubjectID, policy.platformSubjectID, publisher, operator, platform, state, settleAfter, JSON.stringify(policy));
        if (state === 'reserved') for (const [role, amount] of [['publisher', publisher], ['operator', operator], ['platform', platform]]) {
          if (amount) add(holdAccount(order.id, role), amount, 'migration_purchase_reserve', `economy-v1:${order.id}:${role}`);
        }
      }
      db.prepare('INSERT INTO economy_meta VALUES(?,?)').run('policy', JSON.stringify(policy));
    }
    if (db.prepare('SELECT COALESCE(SUM(amount),0) n FROM ledger').get().n !== supply) error('ledger_supply_mismatch');
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  const assertSupply = () => {
    if (db.prepare('SELECT COALESCE(SUM(amount),0) n FROM ledger').get().n !== supply) error('ledger_supply_mismatch');
  };
  const reserve = (buyer, holder, amount, orderID, created) => {
    const [publisher, operator, platform] = splits(amount, policy);
    db.prepare('INSERT INTO order_economics VALUES(?,?,?,?,?,?,?,?,?,?)').run(orderID, holder, policy.operatorSubjectID, policy.platformSubjectID, publisher, operator, platform, 'reserved', new Date(Date.parse(created) + policy.revenueHoldSeconds * 1000).toISOString(), JSON.stringify(policy));
    for (const [role, units] of [['publisher', publisher], ['operator', operator], ['platform', platform]]) transfer(buyer, holdAccount(orderID, role), units, 'purchase_reserve', `${orderID}:${role}`);
    assertSupply();
  };
  const refund = order => {
    const economics = db.prepare('SELECT * FROM order_economics WHERE order_id=?').get(order.id);
    if (!economics || economics.state !== 'reserved' || Date.now() >= Date.parse(economics.settle_after)) error('refund_window_closed');
    for (const [role, amount] of [['publisher', economics.publisher_amount], ['operator', economics.operator_amount], ['platform', economics.platform_amount]]) transfer(holdAccount(order.id, role), order.buyer, amount, 'refund_reversal', `refund:${order.id}:${role}`);
    db.prepare("UPDATE order_economics SET state='refunded' WHERE order_id=?").run(order.id);
    assertSupply();
  };
  const settle = subject => {
    let released = 0;
    const rows = db.prepare("SELECT * FROM order_economics WHERE state='reserved' AND settle_after<=? AND (holder=? OR operator=? OR platform=?) LIMIT 1000").all(timestamp(), subject, subject, subject);
    for (const row of rows) {
      for (const [role, recipient, amount] of [['publisher', row.holder, row.publisher_amount], ['operator', row.operator, row.operator_amount], ['platform', row.platform, row.platform_amount]]) {
        transfer(holdAccount(row.order_id, role), recipient, amount, 'revenue_settlement', `settle:${row.order_id}:${role}`);
        if (recipient === subject) released += amount;
      }
      db.prepare("UPDATE order_economics SET state='settled' WHERE order_id=?").run(row.order_id);
    }
    assertSupply();
    return { releasedLedgerUnits: released, settledOrders: rows.length };
  };
  const wallet = subject => {
    const rows = db.prepare('SELECT * FROM order_economics WHERE holder=? OR operator=? OR platform=?').all(subject, subject, subject);
    let reserved = 0, settled = 0, ready = 0;
    for (const r of rows) {
      const units = (r.holder === subject ? r.publisher_amount : 0) + (r.operator === subject ? r.operator_amount : 0) + (r.platform === subject ? r.platform_amount : 0);
      if (r.state === 'reserved') { reserved += units; if (Date.now() >= Date.parse(r.settle_after)) ready += units; }
      if (r.state === 'settled') settled += units;
    }
    const binding = db.prepare('SELECT address FROM wallet_bindings WHERE subject=?').get(subject);
    return { buyerSubjectID: subject, balance: balance(subject), reservedRevenue: reserved, settledRevenue: settled, readyRevenue: ready, walletAddress: binding?.address ?? null, walletVerified: Boolean(binding), sandbox, withdrawalsEnabled: false, onchainBalance: null, policyID: policy.policyID, ledgerID: policy.ledgerID, issuerID, chainID: null, ledgerUnitsPerToken: policy.ledgerUnitsPerToken };
  };
  return {
    policy, wallet, reserve, refund, settle,
    publicPolicy: () => ({ ...policy, enabled: sandbox, treasuryRemainingLedgerUnits: balance(treasury), circulatingLedgerUnits: supply - balance(treasury) }),
    allocate(subject, amount, reference) {
      if (amount > 100000 || balance(subject) + amount > 1000000) error('sandbox_allocation_limit');
      transfer(treasury, subject, amount, 'treasury_allocation', reference);
      assertSupply();
      return wallet(subject);
    },
    snapshot(orderID) { return db.prepare('SELECT * FROM order_economics WHERE order_id=?').get(orderID); }
  };
}
