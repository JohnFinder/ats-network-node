import ganache from 'ganache';

// Deliberately public, deterministic development accounts; never deposit real assets.
const host = process.env.CHAIN_LISTEN ?? '127.0.0.1';
if (!['127.0.0.1', '0.0.0.0'].includes(host)) throw new Error('Unsupported local chain listen address');
const server = ganache.server({
  chain: { chainId: 1337, hardfork: 'shanghai' }, wallet: { deterministic: true },
  logging: { quiet: true }
});
await server.listen(8545, host);
console.log(`LOCAL TEST CHAIN ONLY listening on ${host}:8545 (chain ID 1337)`);
let closing = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  if (closing) return;
  closing = true;
  try { await server.close(); process.exit(0); }
  catch (error) { console.error(`Local chain shutdown: ${error.message}`); process.exit(1); }
});
