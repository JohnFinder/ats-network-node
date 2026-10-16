# ATS network contracts and operator tooling

This directory contains a split-contract V2 implementation for a **prefunded, fixed-token-unit storage market and publisher tasks**. Local Docker verification uses valueless `ATNTestToken`. Nothing here deploys a public network, issues a valuable token, proves copyright or guarantees a fiat return. Independent audit and independent committee operation remain deployment gates.

## Local verification

Node.js 22+ and npm, or the repository Docker Compose chain profile:

```sh
npm ci --ignore-scripts
npm run compile
npm run chain
# in a second terminal
npm run verify:local
```

`verify:local` deploys V2 on chain 1337, exercises signature/replay/expiry/domain failures, measured period settlement, dispute rounds, royalty splits, stake exits, and reward budget attacks. The accounts are deliberately public Ganache development identities. Never send real funds to them. `verify:legacy` retains the original V1 demonstration for historical compatibility; **do not use its instant-service settlement as the current market**. The V1 `ATSServiceMarket` is not deployed by V2 tooling.

Generated ABI, deployment manifests and local verification reports are in ignored `artifacts/`. Compilation fails if any runtime exceeds the EIP-170 24,576-byte limit. Solidity 0.8.30, OpenZeppelin 5.4.0, ethers 6.15.0 and Ganache 7.9.2 are pinned. The compiler targets Shanghai, optimizer 200 runs, via IR. No upgradeable proxy is used.

A single local process exercising development observer accounts is a functional test, **not an independently operated committee**. The services package separately checks node challenges, identity bindings, indexing and chain reorganization behavior.

## V2 contracts

| Contract | Function |
| --- | --- |
| `ATSIdentityRegistry` | EIP-712 wallet-authorized Ed25519 fingerprint/proof commitments, nonce/expiry, wallet revocation |
| `ATSPublicationRegistry` | Relayed signed publication, immutable content/metadata hashes, fixed 1–16-payee royalty split totaling 10,000 bps |
| `ATSStorageMarket` | Provider-signed quotes, requester prepayment, locked provider stake, per-period observer reports, review/challenge/refund |
| `ATSPublisherTasks` | Sponsor-funded tasks, competing candidates, review and disputes, payout using the publication split |
| `ATSRewardVault` | Prefunded capped Merkle epochs with review, domain binding, replay protection and expiry refund |
| `ATNTestToken` | Fixed 100-million test-token supply; no external mint |

Only a reviewed non-rebasing, non-fee-on-transfer ERC-20 is supported. Incoming exact-balance checks reject transfer-fee assets. Direct unsolicited token transfers are not credited and cannot be swept by the owner. Transfers and payouts use checks/effects/interactions and reentrancy guards.

### Identity and external wallets

The app/node Ed25519 identity and an EVM wallet are different keys. The EVM wallet is controlled by the user's external wallet; no ATS-created shared EVM signing key, uploaded wallet secret, or operator custody is required.

The exact UTF-8 Ed25519 statement has **no trailing newline**:

```text
ATS-WALLET-BIND-V1
<decimal chain ID>
<lowercase identity registry address>
<lowercase EVM wallet address>
<SHA-256(raw32 Ed25519 public key), lowercase hex WITHOUT 0x>
<decimal registry nonce>
<decimal expiry Unix seconds>
```

The Ed25519 identity signs these exact bytes. Its 64-byte signature is hashed with **Keccak-256**, not SHA3-256. The wallet then signs EIP-712 `Bind(address wallet,bytes32 fingerprint,bytes32 edProofHash,uint256 nonce,uint64 expiresAt)` with domain `ATSIdentityRegistry`, version `1`, actual chain ID and registry address. The registry enforces wallet authorization, nonce, expiration (maximum 366 days), wallet-scoped commitments and revocation.

**The EVM contract cannot verify Ed25519.** Node admission, indexers and observers must check both signatures against the same statement, the raw public-key SHA-256 fingerprint, the on-chain event/proof hash, nonce and active expiry. Merely reading `isActive(wallet)` is insufficient to certify a dual binding. Fingerprints are deliberately not globally reserved by an unverified commitment: otherwise an attacker could bind a victim's public fingerprint to its own wallet and prevent the real owner from binding. Each accepted pair requires its own dual proof. Historical publications retain their original fingerprint; clients must resolve the binding event at publication time, rather than silently substituting a wallet's new key.

The offline helper never reads an EVM private key:

```sh
node scripts/binding.mjs statement binding-input.json > statement.json
# Have the node/archive identity sign statement.json's exact statement;
# add its canonical base64 signature as edSignature.
node scripts/binding.mjs wallet-request statement-with-ed-signature.json > wallet-request.json
# Sign wallet-request domain/types/value in an external wallet;
# add the resulting signature as walletSignature.
node scripts/binding.mjs verify signed-binding.json
```

Input fields: `chainId`, `registry`, `wallet`, canonical base64 raw32 `publicKey`, decimal `nonce`, Unix-seconds `expiresAt`. Submit the verified request to a configured relay, or call `bindFor` from the external wallet. The helper's `submit` mode only uses an unlocked **local** chain account. `revoke` is direct wallet authorization; `revokeFor` permits a relayed EIP-712 `Revoke` with the current nonce and expiry. Old statements cannot restore a revoked key.

### Publication and royalties

`publishFor` can be called by any gas sponsor after the publisher signs EIP-712 `Publish` (see ABI) with the nonce, deadline, content SHA-256, exact public metadata SHA-256, previous publisher-owned version and royalty hash. Domain: `ATSPublicationRegistry`, version `1`. Royalty hash is `keccak256(abi.encode(address[] recipients,uint16[] bps))`; recipients must be unique/nonzero and shares sum to 10,000. No later editor can replace these commitments.

Publication ID is `keccak256(abi.encode(chainId,registry,publisher,archiveHash))`. This prevents a first publisher from claiming a global archive hash for everyone. Registry signatures establish publisher authorization, **not ownership of the source text, synthetic voice rights, originality, audio quality or content legality**. Public indexes apply their own announced acceptance policies.

`payRoyalty` is an explicit payment, not a paywall or an automatic reward for a download. Rounding remainder goes to the last immutable payee. Publisher task payouts use the same split. The maximum of 16 payees bounds transaction cost.

### Quotes, service accrual and evidence

A provider signs EIP-712 `Quote` with requester, provider, registry publication ID, exact archive hash, future retention start/end, period length, total price in the configured ERC-20's smallest units, unique salt and quote expiry. Domain: `ATSStorageMarket`, version `1`. The requester approves tokens and calls `openOrder`, or separately signs `OpenOrder(quoteHash,nonce,expiresAt)` for a relayer to call `openOrderFor`.

An accepted provider quote locks one `minimumBond`. Quotes cannot consume a provider's stake without its signature. New orders are rejected while the provider is unbonding. Retention is bounded to 366 days and at most 366 periods (minimum 60 seconds). Start must be within seven days; quote expiry cannot be later than start. Quotes are **fixed nominal token units, not fiat pricing or an oracle guarantee**.

The entire order is prepaid. For each sequential period:

1. Wait until that period's end. A report cannot pay for future retention.
2. Authorized observers independently collect retrieval evidence. The report commits order ID, exact period timestamps, observed time, sample count, successful count and evidence hash.
3. On-chain votes are bound to chain, market, committee generation, order/period, candidate content and dispute round. Evidence is fresh (one hour maximum at vote time), sample count is 1–10,000, and successful samples cannot exceed all samples.
4. A threshold of distinct authorized observers approves a candidate. Wrong first votes for another candidate do not lock selection.
5. A configured review delay starts. Requester, provider or administrator may challenge with a reason hash. A challenged report cannot pay. The **trusted administrator** resolves by rejecting it into a new voting round or accepting it into a new review window.
6. `settlePeriod` pays that period's allocation multiplied by the agreed successful-sample fraction. The failed fraction refunds the original requester; future-period escrow remains locked.

Final-period rounding receives the residual allocation. Committee rotation invalidates pending reports. If service/observation/review stops, anyone can call `refundRemaining` after retention end + report grace + twice review delay; unpaid escrow returns to the requester and the stake lock is released. This bounded exit also applies to unresolved disputes. No operator can withdraw escrow as profit. There is no automatic stake confiscation on an unauthenticated timeout accusation.

The threshold committee and administrator are explicit bootstrap trust assumptions. A self-reported hash is not an independent observation. Retrieval challenges are **not PoRep, PoSt, geographic diversity or evidence that multiple operators retain independent replicas**. Mature storage proofs must be supplied by an independently verified external storage adapter; absent that verification, the storage-proof feature is disabled and must not receive a proof-verified label.

### Publisher tasks and supplemental rewards

Task sponsors fund a fixed specification hash/budget before work begins. Each candidate has separate votes bound to task ID, committee generation, evidence, publication and dispute round. The first incorrect vote cannot trap all other candidates. Sponsor/administrator may challenge during review; administrator rejection reopens voting, and rotation allows fresh votes. Approved tasks pay only after review to the publication's immutable royalty split. Expired or administrator-vetoed challenged tasks refund the sponsor. Identity/rights/quality acceptance remains a human or specialized verifier process.

`ATSRewardVault` never mints. Epoch roots are immutable, prefunded, reviewed, cancelable before activation and claimable for 1–90 days. Double-hashed leaves contain chain ID, vault, epoch, unique index, recipient, amount and evidence hash. Proofs are bounded to 32 siblings; repeated indices, changed recipients, cross-domain claims and claims beyond remaining budget fail. Root fairness remains a governance responsibility, not something a Merkle proof establishes.

`scripts/reward-root.mjs INPUT.json` builds a bounded root/proofs. Input includes `chainId`, `vault`, `epoch`, `budget`, `categoryCaps` and up to 100,000 `claims` (each: `index`, `recipient`, `amount`, `category`, `evidenceHash`, unique `awardID`). All numeric amounts are canonical integer strings in smallest token units. It rejects duplicate indices/awards and category/total overspend. Unallocated rewards stay unallocated; failures do **not** redistribute their share to the remaining claimants. The builder does not decide that an evidence hash deserves a reward.

## Configured deployment

Default command prints a plan and performs **no deployment**:

```sh
npm run deploy:plan
```

`npm run deploy:configured` executes only with explicit configuration. Defaults: local chain 1337, or explicitly select Base Sepolia 84532. Public RPC must be HTTPS. The script checks the actual RPC chain ID. External deployment requires `ATS_DEPLOYER_PRIVATE_KEY` in the environment; it is never written to files or intentionally logged. Use a short-lived deployer, not a treasury wallet.

Required operator variables for testnet:

```text
ATS_DEPLOY_CHAIN_ID=84532
ATS_CHAIN_RPC=<HTTPS RPC>
ATS_DEPLOYER_PRIVATE_KEY=<environment secret only>
ATS_ADMINISTRATOR=<reviewed multisig/timelock address>
ATS_OBSERVERS=["<observer1>","<observer2>","<observer3>"]
ATS_OBSERVER_THRESHOLD=2
ATS_CONFIRMATIONS=12
ATS_REVIEW_SECONDS=86400
ATS_REPORT_GRACE_SECONDS=604800
ATS_UNBOND_SECONDS=604800
ATS_MINIMUM_BOND_UNITS=10000000000000000000
ATS_TOKEN_ADDRESS=<reviewed existing non-rebasing ERC-20>
```

Only chain 1337 automatically creates a test token. On 84532, explicitly set `ATS_DEPLOY_TEST_TOKEN=1` to create the valueless fixture token instead of providing an existing token. No public-chain deployment was run during local verification.

Any other chain is refused unless both `ATS_ALLOWED_CHAIN_IDS` includes the exact chain and `ATS_ALLOW_PRODUCTION_DEPLOY=I_ACCEPT_EXTERNAL_AUDIT_AND_REAL_FUNDS_RESPONSIBILITY`. This is an explicit guard, not evidence that the code is audited. Administrator should be a reviewed multisig/timelock and the committee should consist of independently operated identities. Confirm token behavior/decimals, funder budgets, contract audit and distribution constraints before opting in.

The generated `deployment.v2.<chainId>.json` includes chain ID, confirmation policy, ABI, runtime code hashes, transaction hashes, deployment block/hash, administrator, committee, nominal bond and trust declarations. No secrets are included. Indexers must verify chain and runtime commitments, start from deployment, wait configured confirmations and rewind/replay on reorganization. An operator may not substitute a new contract address while presenting the old manifest as verified.

Primary references: [OpenZeppelin EIP712/ECDSA](https://docs.openzeppelin.com/contracts/5.x/api/utils/cryptography), [SafeERC20](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20), [Ownable2Step](https://docs.openzeppelin.com/contracts/5.x/api/access), [EIP-712](https://eips.ethereum.org/EIPS/eip-712).

## Publisher availability vesting and funded milestones

`ATSPublisherTasks.openTask` and `attestTask` retain ordinary content-acceptance tasks. The availability-dependent variant uses `openRetainedTask(specification, amount, deadline, minimumSeconds)` and `attestRetainedTask(taskId, publicationId, evidenceHash, orderId)`. The sponsor funds the full award at creation; `minimumSeconds` is immutable and can be set to `30 * 86400` for thirty successful service days. A requirement cannot exceed366 days. The deadline must allow service completion and review.

`ATSStorageMarket.paidServiceSeconds(orderId)` accrues only after each period has passed, the threshold report and review/dispute process has completed, and a nonzero service payment is made. It adds `floor(periodSeconds * successfulSamples / totalSamples)`; failed or unresolved periods add zero. Accrual belongs to **one specific paid order**, so parallel replicas/orders cannot make thirty days pass faster. `orderService` exposes its publication and successful seconds; `serviceWindow` exposes the immutable start/end. These values are based on the trusted retrieval-observer committee, not independent storage-replica proofs or proof of uninterrupted uptime.

A retained task accepts only an order for the exact publication whose service starts at or after task funding. Previously earned service cannot be reused for a newly funded task. Its vote candidate commits the order ID, publication, evidence, requirement, chain, contract, committee generation and dispute round. One mistaken or malicious first vote cannot overwrite the order selected by a different valid threshold candidate. Plain task attestations cannot bypass a retained task's requirement.

After committee acceptance, `claimTask` still requires the review delay and absence of a challenge, then checks the accepted order has actually earned the minimum service seconds for that same publication. Waiting thirty days without settled successful service does not unlock payment. Partial failures extend the calendar time required: for example one failed day and one half-successful day mean thirty calendar days are insufficient for thirty successful service days. This policy is cumulative successful service, **not necessarily consecutive availability**.

Implement staged awards as separately prefunded tasks with a common specification identifier and explicit milestone text. For example fund20 units in an ordinary content-acceptance task and80 units in a thirty-day retained task. Each has independent acceptance, challenge, expiry and escrow, and pays the publication's immutable royalty split. Publishing or reuploading alone creates no reward. Multiple sponsors may intentionally fund separate tasks for the same publication/order; these are explicit independent budgets, not automatically minted or mutually exclusive awards. The current contract does not enforce milestone dependencies; if acceptance of milestone2 must require payment of milestone1, the sponsor/committee must include and verify that rule in its specification.

Reproduce the isolated local-EVM acceptance (self-starts a disposable loopback Ganache chain, uses synthetic commitments and test tokens):

```sh
node scripts/verify-publisher-vesting.mjs
```

It exercises independent milestones, order/publication binding, competing candidates, review-delay bypass rejection, exclusion of old service, failed/fractional periods, rejection below thirty earned days, full royalty payout after the threshold, duplicate-payment rejection and refund of an unfulfilled milestone. This script neither contacts an external RPC nor transfers real assets. Compiler/runtime manifests must be regenerated for this new deployment; immutable existing deployments do not acquire these APIs through a source update.
