# ATS network contract prototype

This directory implements a **local test-network foundation**, not a production token launch. The test currency has no promised market value. There is no mainnet deployment script, faucet, externally callable mint, or reward for merely uploading/downloading files. Do not use real money or valuable keys.

## Run

Prerequisite: Node.js 22+ (tested with Node.js 24), npm.

```sh
npm ci --ignore-scripts
npm run compile
npm run chain
```

In another terminal:

```sh
npm run verify:local
```

Verification deploys a fresh pair of contracts using unlocked deterministic **development** accounts from the local chain. The default RPC is `http://127.0.0.1:8545`; scripts refuse nonlocal hosts and chain IDs other than 1337. `ATS_CHAIN_RPC=http://chain:8545` is accepted for the Docker Compose network. `CHAIN_LISTEN=0.0.0.0` is required inside that container; publish its RPC port on host loopback only. These accounts are publicly known development identities, never production credentials. The chain is ephemeral and may be reset.

Dependencies are pinned in `package-lock.json`: OpenZeppelin Contracts 5.4.0, solc 0.8.30, ethers 6.15.0, Ganache 7.9.2. Ganache is only local development tooling. Production requires replacing local RPC tooling, dependency review, chain selection and an independent security audit. The Solidity compiler targets Shanghai EVM with optimizer enabled. No proxy or upgrade mechanism is used.

### Verify actual storage-node evidence

After publishing a public fixture to the node:

```sh
ATS_NODE_EVIDENCE_URL=http://127.0.0.1:18787/v1/resources/RESOURCE_UUID/evidence \
EXPECTED_NODE_ID=RAW_ED25519_PUBLIC_KEY_SHA256 \
npm run verify:local
```

Alternatively supply `NODE_URL` and `NODE_RESOURCE_ID`. The script checks the node's Ed25519 signature over exact evidence bytes, SHA-256 identity, freshness and hash, then streams the actual public download and checks its byte length and SHA-256 before using the evidence hash for on-chain settlement. `EXPECTED_NODE_ID` must be obtained through a trusted operator record; accepting the key supplied in the same response proves only self-consistency. No EVM wallet binding is inferred from a node's self-declared `providerAddress`.

The local walkthrough plays the role of the two trusted attestors after verifying retrieval. It is **one local observer exercising two development accounts**, not two independently deployed observers. Evidence does not prove continuous storage, geographic diversity or an independently retained replica. Generated ABI, deployment addresses and verification reports are written to ignored `artifacts/`.

## Contracts and accounting

### ATNTestToken

Exactly 100,000,000 tATN (18 decimals) are minted once to the constructor treasury. The ERC-20 supply never increases. The token intentionally has no exchange, sale, guaranteed return, external mint or mainnet branding. A fixed total supply is not an assurance of economic value.

### ATSServiceMarket

- **Publication:** each version ID is scoped as `keccak256(abi.encode(chainId, marketAddress, EVMPublisher, archiveSHA256))`. The same bytes can be published by different wallets without letting the first wallet claim the global file hash. `metadataHash` commits to the exact public description; `previous` must belong to the same wallet. The contract verifies no metadata schema or copyright. Archive Ed25519 signing identity and EVM publisher identity are separate. A verified cross-signature/linking protocol remains future work.
- **Stake:** providers deposit the immutable test token. Each accepted service locks `minimumBond`. Withdrawal requires no active service, then an unbond delay; providers cannot accept new work while unbonding. Merely creating an unaccepted order cannot lock a provider's bond.
- **Service escrow:** requester prepays a fixed amount for a registered version and deadline. Only the designated provider accepts; it must have available bond. Two distinct currently authorized attestors must agree on the same evidence hash to settle in the local configuration. Expired open/accepted orders refund the original requester and release locked bond. There is no arbitrary owner withdrawal or automatic slash for network timeouts.
- **Publisher bounty:** sponsor prepays a fixed budget committed to a specification hash. A threshold of attestors agrees on recipient, registered publication and evidence hash. After a review delay anyone may trigger payout to the fixed recipient. The bootstrap administrator may veto during review, refunding the sponsor. An unapproved expired bounty can be refunded. First attestor fixes the candidate; a wrong first vote can stall the bounty until timeout, and there is no appeal protocol yet.
- **Reward epoch:** administrator supplies an immutable Merkle root and a fully funded budget. Activation is delayed; the administrator can cancel before activation. Recipients claim domain-bound, double-hashed leaves containing chain ID, market, epoch, unique index, recipient, amount and evidence hash. Anyone may relay a valid proof, but payment always goes to the committed recipient. Claims cannot repeat or exceed the remaining epoch budget. Remaining funds return to the original funder after expiry (1–90 day claim window). Administrator is trusted to construct a fair root; there is no automatic fraud adjudicator or token mint.
- **Accounting invariant:** `accountedBalance() = totalBond + serviceEscrow + bountyEscrow + rewardEscrow`. Each payment reduces exactly its liability. Verification checks this against token balance at multiple stages. The contract only supports its trusted, non-fee-on-transfer test token. Direct unsolicited ERC-20 transfers are not credited to anyone and cannot be rescued by the owner.

## Trust and missing production components

An administrator selects attestors and reward roots. `approvalThreshold` is fixed; governance cannot reduce the authorized committee below it. Committee changes increment a generation: pending service and bounty votes reset before new attestations, so revoked votes cannot combine with a new committee. Already finalized payouts and already approved review-stage bounties are not retroactively undone; the administrator can veto a bounty during its review window. Two-step ownership transfer reduces accidental transfer errors; it does not make the administrator trustless. On-chain hashes cannot establish content legality, quality, genuine listening, or independent replicas.

Not implemented: permissionless validator selection, independent storage proofs, slashing fraud proofs, objective challenge arbitration, price oracle, stable service pricing, exchange liquidity, token distribution to the public, mainnet deployment, automatic royalty splitting, multi-period service settlement, external-wallet onboarding, sponsored gas, on-chain metadata crawling or contract-driven node admission. Node local retention is governed by its off-chain policy; funding a contract alone does not start or extend storage. Integration still requires a job assignment/receipt protocol and independent committee operations.

Production gates: security audit; adversarial collusion/Sybil testing; multisig and delayed governance; independent observer identities; signed quote/order acceptance binding archive hash, provider and retention interval; reorg-aware indexing; job/bounty appeal procedures; scheduled evidence collection; client key custody/recovery; economic cost/revenue limits; and applicable distribution/payment review. A token does not fund storage unless a sponsor or customer supplies a real service budget.

Primary implementation references: [OpenZeppelin access control](https://docs.openzeppelin.com/contracts/5.x/api/access), [MerkleProof](https://docs.openzeppelin.com/contracts/5.x/api/utils/cryptography), [Ganache local chain](https://github.com/trufflesuite/ganache).
