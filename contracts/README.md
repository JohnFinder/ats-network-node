# ATS network contracts and operator tooling

The V2 contracts support prefunded storage orders, publisher tasks, and capped reward epochs. Prices and budgets use fixed units of the configured ERC-20. The local Docker exercise uses the valueless `ATNTestToken`. Public deployment requires an independent audit and independently operated committee members. Evaluate content rights separately from publication signatures and storage receipts.

## Local verification

From `contracts/`, use Node.js 22 or newer with npm. The repository's Compose chain overlay also provides a disposable local chain.

```sh
npm ci --ignore-scripts
npm run compile
npm run chain
# In a second terminal, from contracts/.
npm run verify:local
```

`verify:local` deploys V2 on chain 1337 and exercises signature, replay, expiry and domain checks, period settlement, dispute rounds, royalty splits, stake exits, and reward budget limits. Ganache uses public development identities. Keep real assets away from those accounts. `verify:legacy` preserves the V1 instant settlement demonstration for historical compatibility. V2 tooling deploys the contracts below.

Builds pin Solidity 0.8.30, OpenZeppelin 5.4.0, ethers 6.15.0, and Ganache 7.9.2. Solidity targets Shanghai with via IR and 200 optimizer runs. Compilation rejects runtimes above the 24,576-byte EIP-170 limit. The contracts deploy directly without upgradeable proxies. Look in the ignored `artifacts/` directory for generated ABIs, manifests, and local reports.

This exercise runs development observer accounts in one process. The [operator services](../services/README.md) verification separately covers node challenges, identity bindings, indexing and reorganization. Independent operation requires separate operators.

## V2 contracts

| Contract | Responsibility |
| --- | --- |
| `ATSIdentityRegistry` | Commits an Ed25519 fingerprint and proof hash under EIP-712 wallet authorization, nonce, expiry and revocation. |
| `ATSPublicationRegistry` | Relays signed publications, preserves content and metadata hashes, and fixes an immutable split across 1–16 payees totaling 10,000 basis points. |
| `ATSStorageMarket` | Accepts provider-signed quotes, prefunds orders, locks provider bonds, and settles or refunds periods after observer review. |
| `ATSPublisherTasks` | Holds sponsor funds and pays a publication's royalty split after candidate voting, review, and disputes. |
| `ATSRewardVault` | Holds prefunded capped Merkle epochs with review, domain binding, replay protection, and expiry refunds. |
| `ATNTestToken` | Supplies 100 million fixed test tokens. |

Use a reviewed ERC-20 with fixed balances and no transfer fee. The contracts require the exact incoming balance and use checks, effects, and interactions with reentrancy guards. Send funds through the intended contract method. Unsolicited transfers leave no credited balance or owner recovery path.

### Identity and external wallets

ATS and its nodes sign with Ed25519 identities. The user's external wallet separately controls the EVM account. Binding the two requires signatures from both keys and does not transfer wallet custody.

Sign this exact UTF-8 statement with the Ed25519 key. Omit the trailing newline.

```text
ATS-WALLET-BIND-V1
<decimal chain ID>
<lowercase identity registry address>
<lowercase EVM wallet address>
<SHA-256(raw32 Ed25519 public key), lowercase hex WITHOUT 0x>
<decimal registry nonce>
<decimal expiry Unix seconds>
```

Compute Keccak-256 over the 64-byte Ed25519 signature to obtain `edProofHash`. The EVM wallet signs EIP-712 `Bind(address wallet,bytes32 fingerprint,bytes32 edProofHash,uint256 nonce,uint64 expiresAt)` using domain `ATSIdentityRegistry`, version `1`, the chain ID and registry address. The registry checks wallet authorization, nonce, expiry up to 366 days, and revocation.

The registry verifies the EVM signature and stores the Ed25519 commitment. Nodes, indexers and observers must verify both signatures against the same statement and compare the raw public-key SHA-256 fingerprint, on-chain event and proof hash, nonce and active expiry. An active wallet record alone cannot establish the dual proof. Commitments are wallet-scoped to prevent an unverified wallet from reserving someone else's public fingerprint. Resolve historical publications against the binding event at publication time.

The offline helper prepares and verifies requests without an EVM private key:

```sh
node scripts/binding.mjs statement binding-input.json > statement.json
# Sign the exact statement with the node or archive identity.
# Add the canonical base64 signature as edSignature.
node scripts/binding.mjs wallet-request statement-with-ed-signature.json > wallet-request.json
# Sign the domain, types, and value in an external wallet.
# Add the resulting signature as walletSignature.
node scripts/binding.mjs verify signed-binding.json
```

Supply `chainId`, `registry`, `wallet`, canonical base64 raw32 `publicKey`, decimal `nonce`, and Unix-seconds `expiresAt`. Send the verified request to a configured relay or call `bindFor` through the external wallet. The helper's `submit` mode uses an unlocked local chain account. Call `revoke` directly or sign a relayed EIP-712 `Revoke` for `revokeFor` with the current nonce and expiry. Revocation prevents replaying old statements to restore a key.

### Publication and royalties

Any gas sponsor can relay `publishFor` once the publisher signs the EIP-712 `Publish` defined in the ABI. Use domain `ATSPublicationRegistry`, version `1`. The signature commits the nonce, deadline, archive SHA-256, exact public metadata SHA-256, previous version owned by the publisher, and royalty split. Compute the split hash as `keccak256(abi.encode(address[] recipients,uint16[] bps))`. Use distinct nonzero payees and shares totaling 10,000 basis points. The registry preserves those commitments.

The publication ID is `keccak256(abi.encode(chainId,registry,publisher,archiveHash))`, which gives each publisher its own namespace for a given archive. Verify source-text rights, synthetic voice rights, originality, and audio quality under the index's acceptance policy. The registry proves publisher authorization.

`payRoyalty` sends a voluntary payment through the immutable split. Publisher task awards use the same split. The last payee receives any rounding remainder. A 16-payee cap bounds transaction cost. Downloads do not trigger royalties or rewards.

### Quotes, service accrual and evidence

A provider signs EIP-712 `Quote` in domain `ATSStorageMarket`, version `1`. The quote fixes the requester and provider, registry publication ID, exact archive hash, future retention window, period length, price in the ERC-20's smallest units, unique salt, and expiry. The requester approves the tokens and calls `openOrder`, or signs `OpenOrder(quoteHash,nonce,expiresAt)` for a relayer to submit through `openOrderFor`.

The provider's signature authorizes locking one `minimumBond`. An unbonding provider cannot accept new orders. The service must start within seven days, with quote expiry at or before that start. Retention is limited to 366 days and 366 periods, each at least 60 seconds. Prices use nominal token units and do not depend on an oracle.

The requester prepays the entire order. Process each period in sequence:

1. Wait until the end of the period.
2. Have authorized observers independently collect retrieval evidence. The report commits the order ID, period timestamps, observation time, number of samples and successes, and evidence hash.
3. Submit votes bound to the chain, market, committee generation, order and period, candidate, and dispute round. Evidence may be at most one hour old when voted. Reports allow 1–10,000 samples, with success count at most the sample count.
4. Collect the required number of distinct authorized votes for one candidate. Other candidates can receive votes even if a different candidate received the first vote.
5. Wait for the review delay. The requester, provider, or administrator can pause settlement by challenging with a reason hash. The trusted administrator can reject the report and reopen voting or accept it into a new review window.
6. Call `settlePeriod`. The provider receives the period allocation multiplied by the agreed success fraction, and the original requester receives the failed fraction. Escrow for future periods stays locked.

The final period receives the rounding remainder. Committee rotation invalidates pending reports. After retention end, the report grace period and twice the review delay, anyone can call `refundRemaining` to return unpaid escrow to the requester and release the stake lock, including when a dispute remains open. The contract offers no operator withdrawal of escrow or automatic slashing from an unauthenticated timeout.

This design trusts the threshold committee and administrator. Signed retrieval challenges establish measured retrieval under that trust model. Proof of replication, proof of spacetime, geography and physical replica independence require separate evidence. Enable proof-based labels only with an independently verified storage adapter.

### Publisher tasks and supplemental rewards

A sponsor prefunds each task's specification hash and budget. Votes bind the task ID, committee generation, evidence, publication, and dispute round to an individual candidate. Competing candidates can collect votes while the task is open. The first to reach threshold enters review. A sponsor or administrator can challenge during review. Administrator rejection reopens voting, and committee rotation allows a new round. After review, approved tasks pay the immutable royalty split. Expiry and administrator veto of a challenged task return funds to the sponsor. Check identity, rights, and quality through the intended acceptance process.

`ATSRewardVault` distributes existing funds through immutable prefunded epoch roots. Each epoch has review, can be canceled before activation and permits claims for 1–90 days. Double-hashed leaves include chain ID, vault, epoch, unique index, recipient, amount, and evidence hash. The vault limits proofs to 32 siblings and rejects repeated indices, altered recipients, cross-domain claims, and claims beyond the remaining budget.

Run `node scripts/reward-root.mjs INPUT.json` to build a bounded root and proofs. Supply `chainId`, `vault`, `epoch`, `budget`, `categoryCaps`, and up to 100,000 `claims`. Each claim includes `index`, `recipient`, `amount`, `category`, `evidenceHash`, and a unique `awardID`. Use canonical integer strings in smallest token units for amounts. Duplicate indices, duplicate awards, and spending above category or total caps fail. Unallocated funds remain unallocated. Governance selects the evidence and recipients.

## Voice license settlement

The `VoiceLicenseSettlement` contract escrows an 18-decimal non-rebasing token for one personal voice license. Prices use ledger units of 100 per token. The contract computes the 80/15/5 split with integer rounding, then converts each share using `10^16`. Before the immutable hold ends, an administrator can refund and permanently revoke the license. After the hold, settlement pays the rights holder, operator and platform. The contract deploys directly and offers only its specified escrow flows. `FeeOnTransferMock` supplies a short-paying token fixture for the local rejection check.

For a Base Sepolia test deployment, run `npm ci --ignore-scripts` and `npm run compile` from `contracts/`. Use the ABI and bytecode in `artifacts/VoiceLicenseSettlement.json` with a wallet deployment tool on chain 84532. Supply an 18-decimal test token, administrator, operator, platform and the desired hold in seconds (604800 by default). Record the address and exact hold in the node configuration. [Voice Market deployment](../voice-market/README.md)

Deploy a fresh contract for `PACKAGE_KEY_VERSION=2`. Call `registerPackage(resourceId,commercialUnits,noncommercialUnits)` using `resourceId=keccak256(UTF8(packageUUID + "/" + version))`. Purchases use `keccak256(abi.encode(holderWallet,resourceId))`, so each holder controls their registration namespace. Node startup checks the package key version.

For explicit acceptance, install the pinned dependencies for both `contracts/` and `voice-market/` with `npm ci --ignore-scripts` in each directory. From `contracts/`, run `npm run verify:voice-settlement -- --local-only` to exercise the seven-day hold on a disposable local chain. Without that flag, the verifier can also deploy a 90-second fixture on Base Sepolia (84532) if `ATS_DEPLOYER_PRIVATE_KEY` is set and its funder has test ETH. The script keeps the key in the environment, uses no faucet, and targets test settlement. The Base Sepolia entitlement index waits 12 confirmations.

## Configured deployment

Inspect the deployment plan before using a funded signer:

```sh
npm run deploy:plan
```

Use `npm run deploy:configured` to execute with explicit configuration. The default chain is 1337. Select Base Sepolia 84532 for testnet. Public RPC URLs must use HTTPS, and the script compares the reported chain ID to the configured ID. For external deployment, supply `ATS_DEPLOYER_PRIVATE_KEY` through the environment and use a separate, short-lived deployer wallet.

Set the deployment variables before running on testnet:

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

Chain 1337 creates a test token by default. To use a valueless fixture token on 84532, set `ATS_DEPLOY_TEST_TOKEN=1` instead of providing `ATS_TOKEN_ADDRESS`. The local verification record covers chain 1337.

To authorize another chain, include its exact ID in `ATS_ALLOWED_CHAIN_IDS` and set `ATS_ALLOW_PRODUCTION_DEPLOY=I_ACCEPT_EXTERNAL_AUDIT_AND_REAL_FUNDS_RESPONSIBILITY`. Before using that guard, verify token behavior and decimals, funder budgets, independent audit, and distribution constraints. Use a reviewed multisig or timelock for administration and independently operated identities for the committee.

The generated `deployment.v2.<chainId>.json` records chain ID, confirmation policy, ABI, runtime code hashes, transaction hashes, deployment block and hash, administrator, committee, nominal bond and trust declarations. Indexers verify the chain and runtime commitments, start at the deployment block, wait for confirmations, and rewind and replay after a reorganization. Generate a new manifest for any new contract address.

See [OpenZeppelin EIP712/ECDSA](https://docs.openzeppelin.com/contracts/5.x/api/utils/cryptography), [SafeERC20](https://docs.openzeppelin.com/contracts/5.x/api/token/erc20), [Ownable2Step](https://docs.openzeppelin.com/contracts/5.x/api/access), [EIP-712](https://eips.ethereum.org/EIPS/eip-712).

## Publisher availability vesting and funded milestones

Use `ATSPublisherTasks.openTask` and `attestTask` for content acceptance. For an availability requirement, use `openRetainedTask(specification, amount, deadline, minimumSeconds)` and `attestRetainedTask(taskId, publicationId, evidenceHash, orderId)`. Fund the entire award at creation and allow time for service completion and review. The immutable requirement can be up to 366 days. Set `minimumSeconds` to `30 * 86400` for 30 cumulative successful days.

`ATSStorageMarket.paidServiceSeconds(orderId)` accrues only for elapsed periods with a completed threshold, review and dispute process and a nonzero provider payment. Each paid period adds `floor(periodSeconds * successfulSamples / totalSamples)`. Failed or unresolved periods add zero. The service belongs to one order. Extra replicas and parallel orders cannot accelerate its clock. Use `orderService` to inspect the publication and successful seconds and `serviceWindow` for the immutable start and end. These values rely on committee retrieval observations.

A retained task requires the exact publication and an order whose service starts at or after task funding. Its vote candidate commits the order, publication, evidence, requirement, chain, contract, committee generation and dispute round. A vote for one candidate leaves other candidates eligible to reach threshold while the task is open. Use retained-task attestations for retained tasks.

After acceptance, `claimTask` checks that review elapsed, no challenge remains, and the accepted order earned the required service for the same publication. Failed or partially successful periods can push the claim past the 30-day calendar mark. The requirement accumulates successful service across periods.

For a staged award, fund separate tasks with a common specification ID and explicit milestone text. For example, fund 20 units for content acceptance and 80 units for 30 successful days. Each task has separate acceptance, challenge, expiry and escrow and pays through the immutable publication split. Multiple sponsors can fund the same publication or order from their own budgets. Publishing and reuploading do not create funds. If the second milestone depends on payment of the first, specify and verify that dependency in the acceptance process.

Run this command from `contracts/` to start a disposable loopback Ganache chain with synthetic commitments and test tokens:

```sh
node scripts/verify-publisher-vesting.mjs
```

The exercise covers independent milestones, order and publication binding, competing candidates, review delays, exclusion of old service, failed and fractional periods, rejection below 30 earned days, full royalty payout after the threshold, duplicate-payment rejection, and refund of an unfulfilled milestone. New APIs require a new deployment and regenerated compiler and runtime manifests.
