import { BrowserProvider, Interface, parseUnits, formatUnits } from '/wallet/ethers.js';
const $ = name => document.querySelector(`#${name}`), status = $('status'), details = $('details'), choices = $('operation'), preview = $('preview'), execute = $('execute');
let network, token, operations, selected, plan;
function show(error) { status.textContent = error.shortMessage ?? error.message ?? String(error); }
const amountField = input => input.type === 'uint256' && ['amount', 'budget'].includes(input.name);
function setFields(values) {
  $('fields').replaceChildren();
  selected.inputs.forEach((input, i) => {
    const label = document.createElement('label'), paragraph = document.createElement('p');
    const names = {amount:'Token amount',budget:'Reward budget',id:'Order or task number',publicationId:'Publication reference',index:'Reward item number',recipient:'Recipient wallet',reasonHash:'Evidence reference',evidenceHash:'Evidence reference',epochId:'Reward round',claimSeconds:'Claim window (seconds)',deadline:'Deadline (Unix seconds)'};
    label.textContent = `${names[input.name] ?? input.name} ${amountField(input) ? `(${token.symbol})` : ''} `;
    const element = document.createElement(input.type === 'tuple' || input.type.endsWith('[]') ? 'textarea' : 'input');
    element.dataset.index = i; element.style.maxWidth = '100%'; element.style.width = '32em';
    if (element.tagName === 'TEXTAREA') { element.rows = 5; element.value = JSON.stringify(values[i], null, 2); }
    else if (input.type === 'bool') { element.type = 'checkbox'; element.checked = !!values[i]; }
    else { element.value = amountField(input) ? formatUnits(values[i], token.decimals) : String(values[i]); element.type = 'text'; }
    element.addEventListener('input', () => { plan = null; execute.disabled = true; });
    label.append(element); paragraph.append(label); $('fields').append(paragraph);
  });
}
function values() {
  return selected.inputs.map((input,i) => {
    const field = $(`fields`).querySelector(`[data-index="${i}"]`);
    if (amountField(input)) return parseUnits(field.value.trim(), token.decimals).toString();
    if (input.type === 'bool') return field.checked;
    if (input.type === 'tuple' || input.type.endsWith('[]')) return JSON.parse(field.value);
    return field.value.trim();
  });
}

async function accountSummary() {
  const fingerprint = new URL(location.href).searchParams.get('publisher');
  if (!/^[0-9a-f]{64}$/.test(fingerprint ?? '')) return;
  try {
    const response = await fetch(`/v2/account/${fingerprint}`); if (!response.ok) return;
    const account = await response.json(); $('account').replaceChildren();
    const heading = document.createElement('h2'); heading.textContent = 'Your storage orders'; $('account').append(heading);
    const intro = document.createElement('p'); intro.textContent = account.active && account.edProofVerified ? `Verified wallet ${account.wallet}` : 'Connect and confirm your wallet binding in ATS first.'; $('account').append(intro);
    for (const order of account.orders ?? []) {
      const line = document.createElement('p');
      line.textContent = `Order ${order.id} · ${order.closed ? 'Closed' : 'Active'} · Provider ${order.provider} · Prepaid ${formatUnits(order.amount,token.decimals)} ${token.symbol} · Unsettled ${formatUnits(order.remaining,token.decimals)} ${token.symbol}`;
      const copy = document.createElement('button'); copy.textContent = 'Copy order number for ATS'; copy.addEventListener('click',()=>navigator.clipboard.writeText(order.id).catch(show)); line.append(' ',copy); $('account').append(line);
      for (const settlement of (account.rewards ?? []).filter(value=>value.orderId===order.id)) {
        const record = document.createElement('p'); record.textContent = `Period ${settlement.periodIndex}: paid to provider ${formatUnits(settlement.paid,token.decimals)} ${token.symbol}; refunded to requester ${formatUnits(settlement.refunded,token.decimals)} ${token.symbol}`; $('account').append(record);
      }
    }
  } catch(error) { show(error); }
}

async function load() {
  const response = await fetch('/v2/wallet-operations'); if (!response.ok) throw new Error('Network unavailable');
  const result = await response.json(); network = result.network; token = result.token; operations = result.operations;
  $('network').textContent = `Network ${network.chainId} · ${token.symbol} · Token contract ${token.address}`;
  for (const operation of operations) { const option = document.createElement('option'); option.value = operation.id; option.textContent = operation.label; choices.append(option); }
  choices.addEventListener('change', select); select(); await accountSummary();
}
function select() { selected = operations.find(o => o.id === choices.value); $('explanation').textContent = selected.explanation; setFields(selected.example); details.textContent = ''; $('review').textContent = ''; execute.disabled = true; plan = null; }
$('import').addEventListener('change', async event => {
  try {
    const file = event.target.files[0]; if (!file || file.size > 32768) throw new Error('Select a JSON voucher or quote smaller than 32 KiB.');
    const data = JSON.parse(await file.text());
    if (data.quote && data.providerSignature) { choices.value = 'storage.openOrder'; select(); setFields([data.quote,data.providerSignature]); }
    else if (Array.isArray(data.args) && typeof data.operation === 'string' && operations.some(o => o.id === data.operation)) { choices.value = data.operation; select(); setFields(data.args); }
    else throw new Error('Expected a signed quote or a voucher with operation and args.');
    status.textContent = 'Imported. Review the values and recipient before opening your wallet.';
  } catch(error) { show(error); }
});
preview.addEventListener('click', async () => {
  try {
    const args = values(), response = await fetch('/v2/wallet-operations/preview', { method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({operation:selected.id,args}) });
    const value = await response.json(); if (!response.ok) throw new Error(value.error);
    plan = value; details.textContent = JSON.stringify(plan,null,2); execute.disabled = false;
    $('review').replaceChildren();
    for (const line of [`Operation: ${selected.label}`,`Network: ${plan.chainId}`,`Contract: ${plan.to ?? plan.domain.verifyingContract}`, ...selected.inputs.map((input,i)=>`${input.name}: ${amountField(input)?`${formatUnits(args[i],token.decimals)} ${token.symbol}`: typeof args[i]==='object'?JSON.stringify(args[i]):String(args[i])}`)]) { const p=document.createElement('p');p.textContent=line;$('review').append(p); }
    status.textContent = 'Check the destination and amounts. Your wallet will show the gas fee. This requests exactly one transaction or quote signature.';
  } catch(error) { show(error);execute.disabled=true; }
});
execute.addEventListener('click', async () => {
  execute.disabled=true;
  try {
    if (!window.ethereum) throw new Error('An EIP-1193 wallet is required.');
    const provider=new BrowserProvider(window.ethereum);await provider.send('eth_requestAccounts',[]);
    if ((await provider.getNetwork()).chainId!==BigInt(plan.chainId))throw new Error(`Switch to chain ${plan.chainId}.`);
    const signer=await provider.getSigner();
    if(plan.mode==='signQuote') {
      if((await signer.getAddress()).toLowerCase()!==plan.message.provider.toLowerCase())throw new Error('Connect the provider wallet in this quote.');
      const signature=await signer.signTypedData(plan.domain,plan.types,plan.message), voucher={quote:plan.message,providerSignature:signature};
      details.textContent=JSON.stringify(voucher,null,2);
      const blob=new Blob([JSON.stringify(voucher,null,2)],{type:'application/json'}),url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download='ats-signed-storage-quote.json';link.textContent='Save signed quote';$('review').append(link);setTimeout(()=>URL.revokeObjectURL(url),60000);
      status.textContent='Quote signed. Save and share it with the requester. No token transfer occurred.';return;
    }
    const transaction=await signer.sendTransaction({to:plan.to,data:plan.data,value:0});status.textContent=`Submitted ${transaction.hash}. Waiting for confirmation…`;const receipt=await transaction.wait();status.textContent=`Confirmed ${transaction.hash}.`;
    if(selected.id==='storage.openOrder') {
      const events=new Interface(['event OrderOpened(uint256 indexed orderId,address indexed requester,address indexed provider,bytes32 publicationId,bytes32 archiveHash,uint64 start,uint64 end,uint64 period,uint256 amount,bytes32 quoteHash)']);
      for(const log of receipt.logs) if(log.address.toLowerCase()===network.contracts.storage.address.toLowerCase()) { try { const event=events.parseLog(log); if(event?.name==='OrderOpened')status.textContent=`Storage order ${event.args.orderId} is funded. Return to the completed upload in ATS and confirm this order number to activate the node retention receipt.`; } catch {} }
    }
    await accountSummary();
  } catch(error){show(error);}finally{plan=null;execute.disabled=true;}
});
load().catch(show);
