// Proves personal voice-license escrow: exact 18-decimal conversion, 80/15/5 floor split,
// seven-day hold on a disposable local chain, and the same contract on Base Sepolia when funded.
// The Sepolia fixture uses a 90-second hold so settle can be observed. It is not a mainnet token.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import ganache from 'ganache';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, getAddress, keccak256, toUtf8Bytes } from 'ethers';
import { compile, root } from './compile.mjs';
import { advance } from './local-chain.mjs';
import { connectSettlement, packageKey, resourceKey, purchaseSelector, quoteLedger, readPurchase, readRefund, readOrderState } from '../../voice-market/src/chain-settlement.mjs';

import { reconcileChainOrders } from '../../voice-market/src/chain-entitlements.mjs';

const artifacts = compile();
const atomic = 10n ** 16n;
const week = 7n * 86400n;
let checks = 0;
const pass = label => { checks += 1; console.log(`PASS ${label}`); };
async function rejects(label, operation) {
  let failed = false;
  try { const value = await operation(); if (value?.wait) await value.wait(); }
  catch { failed = true; }
  assert.equal(failed, true, label);
  pass(label);
}
const deploy = async (signer, name, args) => {
  const contract = await new ContractFactory(artifacts[name].abi, artifacts[name].bytecode, signer).deploy(...args);
  await contract.waitForDeployment();
  return contract;
};
const sum = async (token, accounts) => {
  let total = 0n;
  for (const account of accounts) total += await token.balanceOf(account);
  return total;
};

async function accept({ provider, deployer, buyer, holder, operator, platform, holdSeconds, confirmations, advanceTime, label }) {
  const chainId = Number((await provider.getNetwork()).chainId);
  assert.ok(chainId === 1337 || chainId === 84532, 'settlement verification is limited to local 1337 and Base Sepolia');
  const admin = getAddress(await deployer.getAddress());
  const buyerAddress = getAddress(await buyer.getAddress());
  const holderAddress = getAddress(await holder.getAddress());
  const operatorAddress = getAddress(await operator.getAddress());
  const platformAddress = getAddress(await platform.getAddress());
  const token = await deploy(deployer, 'ATNTestToken', [admin]);
  const settlement = await deploy(deployer, 'VoiceLicenseSettlement', [await token.getAddress(), admin, operatorAddress, platformAddress, holdSeconds]);
  const settlementAddress = getAddress(await settlement.getAddress());
  const chain = { provider, address: settlementAddress, chainID: chainId, administrator: admin };
  if (chainId === 1337) {
    const configuration = { rpc: provider._getConnection().url, address: settlementAddress, chainID: 1337, holdSeconds: Number(holdSeconds) };
    const connected = await connectSettlement(configuration);
    assert.equal(connected.address, settlementAddress);
    connected.provider.destroy();
    pass(`${label} node accepts the v2 settlement configuration`);
    await rejects(`${label} actual RPC chain is checked despite static network configuration`, () => connectSettlement({ ...configuration, chainID: 84532 }));
    await rejects(`${label} mismatched hold configuration fails node startup`, () => connectSettlement({ ...configuration, holdSeconds: 60 }));
  }
  assert.equal(new Contract(settlementAddress, artifacts.VoiceLicenseSettlement.abi, provider).interface.getFunction('purchase').selector, purchaseSelector());
  for (const units of [1n, 1000n, 5000n, 100_000_000n]) {
    const local = quoteLedger(units);
    const quoted = await settlement.quote(units);
    assert.equal(quoted[0], local.publisherAtomic);
    assert.equal(quoted[1], local.operatorAtomic);
    assert.equal(quoted[2], local.platformAtomic);
    assert.equal(quoted[3], local.atomic);
    assert.equal(local.publisherAtomic + local.operatorAtomic + local.platformAtomic, local.atomic);
  }
  pass(`${label} integer quotes match at 1, 1000, 5000 and max ledger units`);
  const cap = await token.CAP();
  assert.equal(await token.balanceOf(admin), cap);
  await (await token.transfer(buyerAddress, 1000n * 10n ** 18n)).wait(confirmations);
  await (await token.connect(buyer).approve(settlementAddress, 1000n * 10n ** 18n)).wait(confirmations);
  const packageID = '11111111-1111-4111-8111-111111111111', version = '1.0.0';
  const resource = resourceKey(packageID, version);
  assert.equal(resource, keccak256(toUtf8Bytes(`${packageID}/${version}`)));
  const key = packageKey(packageID, version, holderAddress);
  assert.equal(await settlement.PACKAGE_KEY_VERSION(), 2n);
  assert.equal(await settlement.packageKey(holderAddress, resource), key);
  // An observer registers the same public ID before the actual rights holder.
  await (await settlement.connect(buyer).registerPackage(resource, 1, 1)).wait(confirmations);
  await (await settlement.connect(holder).registerPackage(resource, 5000, 1000)).wait(confirmations);
  assert.equal((await settlement.packages(key)).holder, holderAddress);
  assert.notEqual(key, packageKey(packageID, version, buyerAddress));
  pass(`${label} public resource ID cannot occupy another holder's namespace`);
  await rejects(`${label} package price is immutable`, () => settlement.connect(holder).registerPackage(resource, 5000, 1000));
  await rejects(`${label} another address cannot unlist`, () => settlement.connect(buyer).setPackageActive(key, false));
  const purchased = await (await settlement.connect(buyer).purchase(key, 1)).wait(confirmations);
  const purchaseHash = purchased.hash;
  const proof = await readPurchase(chain, purchaseHash);
  assert.equal(proof.buyer, buyerAddress);
  assert.equal(proof.packageId, key);
  assert.equal(proof.kind, 1);
  assert.equal(proof.ledgerUnits, 1000n);
  assert.equal(proof.atomicAmount, 1000n * atomic);
  await rejects(`${label} receipt from another chain is rejected`, () => readPurchase({ ...chain, chainID: 1 }, purchaseHash));
  const order = await settlement.orders(proof.orderId);
  if (chainId === 1337) {
    for (let i = 0; i < 11; i++) await provider.send('evm_mine', []);
  }
  const database = new DatabaseSync(':memory:');
  database.exec(`CREATE TABLE orders(id TEXT PRIMARY KEY,buyer TEXT,package TEXT,version TEXT,kind TEXT,amount INTEGER,status TEXT);
    CREATE TABLE chain_settlements(order_id TEXT,onchain_order_id TEXT,chain_id INTEGER,contract TEXT);
    CREATE TABLE packages(id TEXT,version TEXT,holder TEXT);
    CREATE TABLE wallet_bindings(subject TEXT,address TEXT);`);
  database.prepare('INSERT INTO orders VALUES(?,?,?,?,?,?,?)').run('issued-order', 'buyer', packageID, version, 'noncommercial', 1000, 'active');
  database.prepare('INSERT INTO chain_settlements VALUES(?,?,?,?)').run('issued-order', proof.orderId, chainId, settlementAddress);
  database.prepare('INSERT INTO packages VALUES(?,?,?)').run(packageID, version, 'holder');
  database.prepare('INSERT INTO wallet_bindings VALUES(?,?)').run('buyer', buyerAddress);
  database.prepare('INSERT INTO wallet_bindings VALUES(?,?)').run('holder', holderAddress);
  const issued = () => database.prepare('SELECT * FROM orders WHERE id=?').get('issued-order');
  await reconcileChainOrders(database, chain, [issued()]);
  assert.equal(issued().status, 'active');
  await rejects(`${label} missing chain configuration cannot grant an issued license`, () => reconcileChainOrders(database, null, [issued()]));
  await rejects(`${label} RPC failure cannot return an active certificate`, () => reconcileChainOrders(database, { ...chain, provider: { send: async () => { throw Error('unavailable'); } } }, [issued()]));
  await rejects(`${label} mismatched buyer cannot reuse a chain order`, () => readOrderState(chain, proof.orderId, { buyer: holderAddress }));
  const quote = quoteLedger(1000n);
  assert.equal(order.publisherAtomic, quote.publisherAtomic);
  assert.equal(order.operatorAtomic, quote.operatorAtomic);
  assert.equal(order.platformAtomic, quote.platformAtomic);
  assert.equal(order.publisherAtomic, 8n * 10n ** 18n);
  assert.equal(order.operatorAtomic, 15n * 10n ** 17n);
  assert.equal(order.platformAtomic, 5n * 10n ** 17n);
  assert.equal(await settlement.licenseState(buyerAddress, key, 1), 1n);
  assert.equal(await token.balanceOf(settlementAddress), quote.atomic);
  pass(`${label} purchase escrows 10 tokens as 8 / 1.5 / 0.5`);
  await rejects(`${label} personal license cannot be purchased twice`, () => settlement.connect(buyer).purchase(key, 1));
  await rejects(`${label} non-administrator cannot refund`, () => settlement.connect(buyer).refund(proof.orderId));
  await rejects(`${label} reserved order cannot settle inside the hold`, () => settlement.connect(buyer).settle(proof.orderId));
  const refunded = await (await settlement.connect(deployer).refund(proof.orderId)).wait(confirmations);
  if (chainId === 1337) {
    const confirmedView = { ...chain, chainID: 84532 };
    assert.equal((await readOrderState(confirmedView, proof.orderId)).status, 'active');
    for (let i = 0; i < 11; i++) await provider.send('evm_mine', []);
    assert.equal((await readOrderState(confirmedView, proof.orderId)).status, 'refunded');
    pass(`${label} Base Sepolia state changes require 12 confirmations`);
  }
  const refundProof = await readRefund(chain, refunded.hash);
  assert.equal(refundProof.orderId, proof.orderId);
  assert.equal(refundProof.atomicAmount, quote.atomic);
  assert.equal(await settlement.licenseState(buyerAddress, key, 1), 2n);
  assert.equal(await token.balanceOf(settlementAddress), 0n);
  await rejects(`${label} revoked personal license cannot be repurchased`, () => settlement.connect(buyer).purchase(key, 1));
  pass(`${label} administrator refund restores the exact payment and revokes the license`);
  await rejects(`${label} refunded purchase receipt cannot issue a new certificate`, () => readPurchase(chain, purchaseHash));
  const refreshed = issued();
  await reconcileChainOrders(database, chain, [refreshed]);
  assert.equal(refreshed.status, 'refunded');
  assert.equal(issued().status, 'refunded');
  pass(`${label} certificate and download reconciliation persist an external refund`);
  database.close();
  const commercial = await (await settlement.connect(buyer).purchase(key, 2)).wait(confirmations);
  const commercialProof = await readPurchase(chain, commercial.hash);
  assert.equal(commercialProof.ledgerUnits, 5000n);
  await advanceTime(holdSeconds / 2n);
  await rejects(`${label} settlement stays closed through the first half of the hold`, () => settlement.settle(commercialProof.orderId));
  await advanceTime(holdSeconds / 2n + 5n);
  await rejects(`${label} hold expiry closes refunds`, () => settlement.connect(deployer).refund(commercialProof.orderId));
  const holderBefore = await token.balanceOf(holderAddress);
  const operatorBefore = await token.balanceOf(operatorAddress);
  const platformBefore = await token.balanceOf(platformAddress);
  // Ganache's gas estimator does not observe evm_increaseTime, so this mined call sets its own limit.
  await (await settlement.connect(deployer).settle(commercialProof.orderId, { gasLimit: 300000 })).wait(confirmations);
  const commercialQuote = quoteLedger(5000n);
  assert.equal(await token.balanceOf(holderAddress), holderBefore + commercialQuote.publisherAtomic);
  assert.equal(await token.balanceOf(operatorAddress), operatorBefore + commercialQuote.operatorAtomic);
  assert.equal(await token.balanceOf(platformAddress), platformBefore + commercialQuote.platformAtomic);
  assert.equal(await settlement.escrow(), 0n);
  await rejects(`${label} settled order cannot pay twice`, () => settlement.connect(deployer).settle(commercialProof.orderId));
  assert.equal((await readPurchase(chain, commercial.hash)).orderId, commercialProof.orderId);
  pass(`${label} settled personal license remains active`);
  pass(`${label} settlement pays 40 / 7.5 / 2.5 after the hold`);
  const tinyResource = resourceKey('22222222-2222-4222-8222-222222222222', '1.0.0');
  const tiny = packageKey('22222222-2222-4222-8222-222222222222', '1.0.0', holderAddress);
  await (await settlement.connect(holder).registerPackage(tinyResource, 0, 1)).wait(confirmations);
  const tinyPurchase = await (await settlement.connect(buyer).purchase(tiny, 1)).wait(confirmations);
  const tinyProof = await readPurchase(chain, tinyPurchase.hash);
  assert.equal(quoteLedger(1n).platformAtomic, atomic);
  assert.equal(quoteLedger(1n).publisherAtomic, 0n);
  await advanceTime(holdSeconds + 5n);
  const platformTiny = await token.balanceOf(platformAddress);
  await (await settlement.settle(tinyProof.orderId, { gasLimit: 300000 })).wait(confirmations);
  assert.equal(await token.balanceOf(platformAddress), platformTiny + atomic);
  assert.equal(await token.balanceOf(holderAddress), holderBefore + commercialQuote.publisherAtomic);
  pass(`${label} one ledger unit rounds entirely to the platform`);
  await (await settlement.connect(holder).setPackageActive(key, false)).wait(confirmations);
  await rejects(`${label} unlisted package cannot be purchased`, () => settlement.connect(buyer).purchase(key, 2));
  const watched = [admin, buyerAddress, holderAddress, operatorAddress, platformAddress, settlementAddress];
  assert.equal(await sum(token, watched), cap);
  pass(`${label} token supply stays at the fixed cap`);
  if (chainId === 1337) {
    const feeToken = await deploy(deployer, 'FeeOnTransferMock', []);
    await (await feeToken.mint(buyerAddress, 10n ** 21n)).wait();
    const feeSettlement = await deploy(deployer, 'VoiceLicenseSettlement', [await feeToken.getAddress(), admin, operatorAddress, platformAddress, 60]);
    await (await feeSettlement.connect(holder).registerPackage(resource, 0, 1)).wait();
    await rejects(`${label} fee-on-transfer token is rejected`, () => feeSettlement.connect(buyer).purchase(key, 1));
  }
  return {
    chainId, settlement: settlementAddress, token: getAddress(await token.getAddress()), administrator: admin,
    operator: operatorAddress, platform: platformAddress, holdSeconds: Number(holdSeconds), purchaseTransaction: purchaseHash,
    label: chainId === 84532 ? 'BASE SEPOLIA TEST ONLY' : 'LOCAL TEST CHAIN ONLY'
  };
}

const local = ganache.server({ chain: { chainId: 1337, hardfork: 'shanghai' }, wallet: { deterministic: true, totalAccounts: 6 }, logging: { quiet: true } });
await local.listen(0, '127.0.0.1');
const localProvider = new JsonRpcProvider(`http://127.0.0.1:${local.address().port}`, 1337, { staticNetwork: true });
try {
  const signers = await Promise.all([0, 1, 2, 3, 4].map(index => localProvider.getSigner(index)));
  const localResult = await accept({
    provider: localProvider, deployer: signers[0], buyer: signers[1], holder: signers[2], operator: signers[3], platform: signers[4],
    holdSeconds: week, confirmations: 1, advanceTime: seconds => advance(localProvider, Number(seconds)), label: 'local'
  });
  assert.equal(localResult.holdSeconds, 604800);
  pass('local seven-day hold completed without an external network');
  console.log(JSON.stringify({ phase: 'local', checks, ...localResult }));
} finally {
  localProvider.destroy();
  await local.close();
}

if (process.argv.includes('--local-only')) process.exit(0);
if (!process.env.ATS_DEPLOYER_PRIVATE_KEY) {
  console.log(JSON.stringify({ phase: 'base-sepolia', result: 'not-broadcast', reason: 'ATS_DEPLOYER_PRIVATE_KEY is not configured; no faucet or signing request was made', localChecks: checks }));
  process.exit(2);
}

const rpc = process.env.ATS_CHAIN_RPC ?? 'https://sepolia.base.org';
const rpcURL = new URL(rpc);
if (rpcURL.protocol !== 'https:' || rpcURL.username || rpcURL.password) throw new Error('Base Sepolia verification requires HTTPS RPC');
const sepolia = new JsonRpcProvider(rpc, 84532, { staticNetwork: true });
const secret = process.env.ATS_DEPLOYER_PRIVATE_KEY;
try {
  if (BigInt(await sepolia.send('eth_chainId', [])) !== 84532n) throw new Error('RPC is not Base Sepolia');
  const funder = secret ? new Wallet(secret, sepolia) : Wallet.createRandom().connect(sepolia);
  const funderAddress = await funder.getAddress();
  console.log(JSON.stringify({ phase: 'base-sepolia', funder: funderAddress, ephemeral: !secret, rpcHost: rpcURL.hostname }));
  const minimum = 200_000_000_000_000n;
  const balance = await sepolia.getBalance(funderAddress);
  if (balance < minimum) {
    console.log(JSON.stringify({
      phase: 'base-sepolia', result: 'not-broadcast', reason: 'funder has less than 0.0002 ETH',
      funder: funderAddress, balance: balance.toString(), localChecks: checks
    }));
    process.exitCode = 2;
  } else {
    const buyer = Wallet.createRandom().connect(sepolia);
    const holder = Wallet.createRandom().connect(sepolia);
    const operator = Wallet.createRandom().connect(sepolia);
    const platform = Wallet.createRandom().connect(sepolia);
    const gas = (await sepolia.getFeeData()).maxFeePerGas ?? 1_000_000n;
    const stipend = gas * 1_500_000n > balance / 4n ? balance / 4n : gas * 1_500_000n;
    for (const wallet of [buyer, holder]) await (await funder.sendTransaction({ to: wallet.address, value: stipend })).wait(1);
    const sepoliaResult = await accept({
      provider: sepolia, deployer: funder, buyer, holder, operator, platform,
      holdSeconds: 90n, confirmations: 12, advanceTime: seconds => new Promise(resolve => setTimeout(resolve, Number(seconds) * 1000)), label: 'base-sepolia'
    });
    const manifest = { ...sepoliaResult, confirmationPolicy: 'verification and node acceptance wait for 12 blocks on Base Sepolia', realFunds: false };
    fs.writeFileSync(path.join(root, 'artifacts', 'voice-settlement.84532.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({ phase: 'base-sepolia', checks, ...manifest }));
  }
} catch (error) {
  const reason = String(error.shortMessage ?? error.message).replaceAll(secret ?? 'SECRET_NOT_CONFIGURED', '[REDACTED]');
  console.log(JSON.stringify({ phase: 'base-sepolia', result: 'failed', reason, localChecks: checks }));
  process.exitCode = 2;
} finally {
  sepolia.destroy();
}
