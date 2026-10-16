import { BrowserProvider, Contract, Interface } from '/wallet/ethers.js';
const details = document.querySelector('#details'), button = document.querySelector('#authorize'), status = document.querySelector('#status');
async function api(path, body) {
  const response = await fetch(path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
  const value = await response.json(); if (!response.ok) throw new Error(value.error ?? 'Request failed'); return value;
}
let plan, id;
async function load() {
  const query = new URL(location.href).searchParams;
  id = query.get('intent');
  if (!id && location.pathname === '/wallet/publish') {
    status.textContent = 'Checking the signed public resource and wallet binding…';
    const result = await api('/v2/publication-intents', { nodeURL: query.get('node'), resourceID: query.get('resource') });
    id = result.intentID; history.replaceState({}, '', `/wallet?intent=${encodeURIComponent(id)}`);
  }
  if (!id) throw new Error('Open a wallet authorization link from ATS.');
  plan = await api(`/v2/binding-intents/${encodeURIComponent(id)}`);
  details.textContent = JSON.stringify({ operation: plan.type, wallet: plan.wallet, domain: plan.domain, message: plan.message, content: plan.metadata ?? null, recipients: plan.recipients, basisPoints: plan.bps }, null, 2);
  button.disabled = false; status.textContent = 'Review these details before continuing. Binding and publishing do not authorize token transfers.';
}
button.addEventListener('click', async () => {
  button.disabled = true;
  try {
    if (!window.ethereum) throw new Error('An EIP-1193 browser wallet is required.');
    const provider = new BrowserProvider(window.ethereum);
    await provider.send('eth_requestAccounts', []);
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(plan.domain.chainId)) throw new Error(`Switch your wallet to chain ${plan.domain.chainId}.`);
    const signer = await provider.getSigner();
    if ((await signer.getAddress()).toLowerCase() !== plan.wallet.toLowerCase()) throw new Error('Connect the wallet shown in the authorization details.');
    status.textContent = 'Review the typed message in your wallet.';
    const walletSignature = await signer.signTypedData(plan.domain, plan.types, plan.message);
    const contract = new Contract(plan.contract, plan.abi, signer), m = plan.message;
    status.textContent = 'Review the transaction and gas fee in your wallet.';
    const transaction = plan.type === 'binding'
      ? await contract.bindFor(m.wallet, m.fingerprint, m.edProofHash, m.nonce, m.expiresAt, walletSignature)
      : await contract.publishFor(m.wallet, m.archiveHash, m.metadataHash, m.previous, plan.recipients, plan.bps, m.nonce, m.expiresAt, walletSignature);
    status.textContent = `Submitted ${transaction.hash}. Waiting for chain confirmations…`;
    await transaction.wait();
    // Bounded polling only for the indexer confirmation window; no wallet/key retry.
    for (let attempt = 0; attempt < 30; attempt++) {
      try {
        await api(`/v2/binding-intents/${encodeURIComponent(id)}/complete`, { walletSignature });
        status.textContent = 'Confirmed. Return to ATS and refresh the network status.'; return;
      } catch (error) {
        if (!error.message.includes('waiting_for_confirmed_transaction')) throw error;
        await new Promise(resolve => setTimeout(resolve, 4000));
      }
    }
    status.textContent = 'Transaction submitted. The indexer is still waiting for confirmations. Keep this page open and retry confirmation later.';
  } catch (error) { status.textContent = error.shortMessage ?? error.message; }
  finally { button.disabled = false; }
});
load().catch(error => { status.textContent = error.message; });
