import { JsonRpcProvider } from 'ethers';

export async function connectLocal() {
  const raw = process.env.ATS_CHAIN_RPC ?? 'http://127.0.0.1:8545';
  const url = new URL(raw);
  const hosts = ['127.0.0.1', 'localhost', '[::1]', 'chain'];
  if (url.protocol !== 'http:' || !hosts.includes(url.hostname) || url.username || url.password) {
    throw new Error('Local verification only permits HTTP loopback or Docker service chain');
  }
  const provider = new JsonRpcProvider(raw, undefined, { cacheTimeout: -1, pollingInterval: 50 });
  if ((await provider.getNetwork()).chainId !== 1337n) throw new Error('Local scripts require chain ID 1337');
  const signers = await Promise.all(Array.from({ length: 6 }, (_, i) => provider.getSigner(i)));
  return { provider, signers };
}
export async function tx(operation) { return (await operation).wait(); }
export async function advance(provider, seconds) {
  await provider.send('evm_increaseTime', [seconds]);
  await provider.send('evm_mine', []);
}
