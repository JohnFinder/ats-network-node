import { AbiCoder, Contract, Interface, JsonRpcProvider, getAddress, id, keccak256, toUtf8Bytes } from 'ethers';

// Integer conversion for the voice settlement contract. Never use JavaScript Number for atomic amounts.
export const ATOMIC_PER_LEDGER_UNIT = 10n ** 16n;
export const MAX_LEDGER_UNITS = 100_000_000n;
const settlementAbi = [
  'function PACKAGE_KEY_VERSION() view returns (uint256)',
  'function licenseState(address,bytes32,uint8) view returns (uint8)',
  'function token() view returns (address)',
  'function holdSeconds() view returns (uint64)',
  'function administrator() view returns (address)',
  'function operator() view returns (address)',
  'function platform() view returns (address)',
  'function packages(bytes32) view returns (address holder, uint256 commercialUnits, uint256 noncommercialUnits, bool active)',
  'function orders(uint256) view returns (address buyer, address holder, bytes32 packageId, uint8 kind, uint8 state, uint256 ledgerUnits, uint256 publisherAtomic, uint256 operatorAtomic, uint256 platformAtomic, uint64 createdAt)',
  'function purchase(bytes32 packageId, uint8 kind) returns (uint256)',
  'function refund(uint256 orderId)',
  'function settle(uint256 orderId)',
  'event Purchased(uint256 indexed orderId, address indexed buyer, bytes32 indexed packageId, uint8 kind, uint256 ledgerUnits, uint256 atomicAmount, uint256 chainId)',
  'event Refunded(uint256 indexed orderId, address indexed buyer, uint256 atomicAmount, uint256 chainId)',
  'event Settled(uint256 indexed orderId, address indexed holder, address operator, address platform, uint256 publisherAtomic, uint256 operatorAtomic, uint256 platformAtomic, uint256 chainId)'
];
const tokenAbi = ['function balanceOf(address) view returns (uint256)', 'function decimals() view returns (uint8)'];
const settlementInterface = new Interface(settlementAbi);
const kinds = { noncommercial: 1, commercial: 2 };

export function resourceKey(packageID, version) {
  if (typeof packageID !== 'string' || typeof version !== 'string' || !packageID || !version) throw settlementError('invalid_package', 400);
  return keccak256(toUtf8Bytes(`${packageID}/${version}`));
}
export function packageKey(packageID, version, holder) {
  return keccak256(AbiCoder.defaultAbiCoder().encode(['address', 'bytes32'], [getAddress(holder), resourceKey(packageID, version)]));
}
export function kindCode(kind) {
  const code = kinds[kind];
  if (!code) throw settlementError('license_unavailable', 400);
  return code;
}
export function quoteLedger(units) {
  if (typeof units !== 'bigint' || units <= 0n || units > MAX_LEDGER_UNITS) throw settlementError('invalid_units', 400);
  const publisher = units * 8000n / 10000n;
  const operator = units * 1500n / 10000n;
  const platform = units - publisher - operator;
  return {
    publisher, operator, platform,
    publisherAtomic: publisher * ATOMIC_PER_LEDGER_UNIT,
    operatorAtomic: operator * ATOMIC_PER_LEDGER_UNIT,
    platformAtomic: platform * ATOMIC_PER_LEDGER_UNIT,
    atomic: units * ATOMIC_PER_LEDGER_UNIT
  };
}

function settlementError(code, status = 409) {
  return Object.assign(Error(code), { code, status });
}
function txHash(value) {
  if (typeof value !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(value)) throw settlementError('invalid_settlement_transaction', 400);
  return value;
}

export function loadChainSettlement() {
  const configured = process.env.VOICE_MARKET_SETTLEMENT_CHAIN_ID;
  if (!configured) return null;
  if (configured !== '84532') throw settlementError('unsupported_settlement_chain', 500);
  const address = process.env.VOICE_MARKET_SETTLEMENT_ADDRESS;
  const rpc = process.env.VOICE_MARKET_CHAIN_RPC;
  if (!/^0x[0-9a-fA-F]{40}$/.test(address ?? '') || !rpc) throw settlementError('incomplete_settlement_configuration', 500);
  const url = new URL(rpc);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw settlementError('invalid_settlement_rpc', 500);
  const hold = Number(process.env.VOICE_MARKET_SETTLEMENT_HOLD_SECONDS ?? '604800');
  if (!Number.isInteger(hold) || hold < 60 || hold > 30 * 86400) throw settlementError('invalid_settlement_hold', 500);
  return {
    chainID: 84532, address: getAddress(address), rpc, holdSeconds: hold,
    policyOverlay: {
      chainID: 84532, network: 'base-sepolia-test', settlementNetwork: 'base-sepolia-test',
      settlementAddress: getAddress(address), onchainAtomicPerLedgerUnit: ATOMIC_PER_LEDGER_UNIT.toString(),
      onchainDeployed: true, withdrawalsEnabled: false, revenueHoldSeconds: hold
    }
  };
}

export async function connectSettlement(config) {
  if (!config) return null;
  const provider = new JsonRpcProvider(config.rpc, config.chainID, { staticNetwork: true });
  try {
    const actualChainID = BigInt(await provider.send('eth_chainId', []));
    if (actualChainID !== BigInt(config.chainID)) throw settlementError('settlement_chain_mismatch', 500);
    const settlement = new Contract(config.address, settlementAbi, provider);
    const [tokenAddress, hold, administrator, operator, platform, decimals, keyVersion] = await Promise.all([
      settlement.token(), settlement.holdSeconds(), settlement.administrator(), settlement.operator(), settlement.platform(),
      new Contract(await settlement.token(), tokenAbi, provider).decimals(), settlement.PACKAGE_KEY_VERSION()
    ]);
    if (Number(hold) !== config.holdSeconds || decimals !== 18n || keyVersion !== 2n) throw settlementError('settlement_contract_mismatch', 500);
    if ([administrator, operator, platform, tokenAddress].some(value => value === '0x0000000000000000000000000000000000000000')) throw settlementError('settlement_contract_mismatch', 500);
    return { ...config, provider, settlement, tokenAddress: getAddress(tokenAddress), administrator: getAddress(administrator), operator: getAddress(operator), platform: getAddress(platform) };
  } catch (error) {
    provider.destroy();
    throw error;
  }
}

async function receiptOf(provider, hash, chainID) {
  const transaction = await provider.getTransaction(hash);
  const receipt = await provider.getTransactionReceipt(hash);
  if (!transaction || !receipt || receipt.status !== 1 || transaction.value !== 0n) throw settlementError('settlement_transaction_not_confirmed', 409);
  if ((transaction.chainId ?? receipt.chainId) !== BigInt(chainID)) throw settlementError('settlement_chain_mismatch', 409);
  const required = chainID === 1337 ? 1n : 12n;
  const head = BigInt(await provider.send('eth_blockNumber', []));
  if (head + 1n - BigInt(receipt.blockNumber) < required) throw settlementError('settlement_transaction_not_confirmed', 409);
  return { transaction, receipt };
}
function settlementLogs(receipt, address) {
  return receipt.logs.filter(log => getAddress(log.address) === address).flatMap(log => {
    try { return [settlementInterface.parseLog(log)]; } catch { return []; }
  });
}

// State is read from the newest block with the same confirmation depth as receipts.
// Provider errors deliberately propagate: an unavailable chain cannot authorize access.
export async function readOrderState(chain, orderID, expected = {}) {
  const head = BigInt(await chain.provider.send('eth_blockNumber', []));
  const required = chain.chainID === 1337 ? 1n : 12n;
  if (head + 1n < required) throw settlementError('settlement_transaction_not_confirmed');
  const blockTag = Number(head + 1n - required);
  const contract = chain.settlement ?? new Contract(chain.address, settlementAbi, chain.provider);
  const order = await contract.orders(orderID, { blockTag });
  if (order.buyer === '0x0000000000000000000000000000000000000000' ||
      (expected.buyer && getAddress(order.buyer) !== getAddress(expected.buyer)) ||
      (expected.holder && getAddress(order.holder) !== getAddress(expected.holder)) ||
      (expected.packageId && order.packageId !== expected.packageId) ||
      (expected.kind != null && Number(order.kind) !== Number(expected.kind)) ||
      (expected.ledgerUnits != null && order.ledgerUnits !== BigInt(expected.ledgerUnits))) {
    throw settlementError('settlement_order_mismatch');
  }
  const license = Number(await contract.licenseState(order.buyer, order.packageId, order.kind, { blockTag }));
  if (Number(order.state) === 2 && license === 2) return { status: 'refunded', order, blockTag };
  if (![1, 3].includes(Number(order.state)) || license !== 1) throw settlementError('settlement_license_invalid');
  return { status: 'active', order, blockTag };
}

export async function readPurchase(chain, hash) {
  const { transaction, receipt } = await receiptOf(chain.provider, txHash(hash), chain.chainID);
  if (getAddress(transaction.to) !== chain.address) throw settlementError('settlement_contract_mismatch', 409);
  const call = settlementInterface.parseTransaction({ data: transaction.data, value: transaction.value });
  if (call?.name !== 'purchase') throw settlementError('settlement_transaction_mismatch', 409);
  const purchased = settlementLogs(receipt, chain.address).filter(log => log.name === 'Purchased');
  if (purchased.length !== 1) throw settlementError('settlement_event_mismatch', 409);
  const event = purchased[0].args;
  if (getAddress(event.buyer) !== getAddress(transaction.from) || event.packageId !== call.args.packageId ||
      Number(event.kind) !== Number(call.args.kind) || event.chainId !== BigInt(chain.chainID)) throw settlementError('settlement_event_mismatch', 409);
  const quoted = quoteLedger(event.ledgerUnits);
  if (event.atomicAmount !== quoted.atomic) throw settlementError('settlement_amount_mismatch', 409);
  const current = await readOrderState(chain, event.orderId, {
    buyer: transaction.from, packageId: event.packageId, kind: event.kind, ledgerUnits: event.ledgerUnits
  });
  if (current.status !== 'active') throw settlementError('settlement_license_revoked');
  return {
    holder: getAddress(current.order.holder), buyer: getAddress(transaction.from), packageId: event.packageId, kind: Number(event.kind),
    ledgerUnits: event.ledgerUnits, atomicAmount: event.atomicAmount, orderId: event.orderId.toString(), transaction: hash
  };
}

export async function readRefund(chain, hash) {
  const { transaction, receipt } = await receiptOf(chain.provider, txHash(hash), chain.chainID);
  if (getAddress(transaction.to) !== chain.address || getAddress(transaction.from) !== chain.administrator) throw settlementError('settlement_transaction_mismatch', 409);
  const call = settlementInterface.parseTransaction({ data: transaction.data, value: transaction.value });
  const refunded = settlementLogs(receipt, chain.address).filter(log => log.name === 'Refunded');
  if (call?.name !== 'refund' || refunded.length !== 1 || refunded[0].args.orderId !== call.args.orderId ||
      refunded[0].args.chainId !== BigInt(chain.chainID)) throw settlementError('settlement_event_mismatch', 409);
  return { buyer: getAddress(refunded[0].args.buyer), orderId: refunded[0].args.orderId.toString(), atomicAmount: refunded[0].args.atomicAmount, transaction: hash };
}

export async function readAtomicBalance(chain, address) {
  if (!address) return null;
  const balance = await new Contract(chain.tokenAddress, tokenAbi, chain.provider).balanceOf(getAddress(address));
  return balance.toString();
}

export function purchaseSelector() { return id('purchase(bytes32,uint8)').slice(0, 10); }
