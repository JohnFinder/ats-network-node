# ATS Network delivery plan

This repository implements the first runnable slice of a user-operated audiobook network. It separates archive integrity, storage, discovery and token accounting. It does not claim that a newly issued token pays real infrastructure costs, that a signed publisher owns copyright, or that several HTTP endpoints are independent replicas.

## Product flow

An ATS user exports a complete signed `.atsbook`, chooses public/link-only/private and optional content encryption, then publishes a fixed snapshot to a configured node. A persistent upload record tracks the archive hash, node, upload ID and completed parts. On resume the client reconciles with the server and resends only missing parts. A completed, verified public publication automatically enters that node's search/list API. Download verifies the archive digest and size before existing publisher inspection/decryption/import.

A deployment owner configures a node once; end users do not create buckets or provide storage credentials. The app can receive a default HTTPS URL in its build configuration. This delivery does not invent a working public endpoint: absent a deployed endpoint the app exposes node setup. Each node is an independent operator. Queries and rankings describe that node, not global network consensus.

## Roles and trust

- Publishers: device Ed25519 identity signs upload requests; the archive has its own signed content manifest. The content key is never a node API field.
- Storage/distribution operators: provide disk, bandwidth and uptime, keep persistent node identity and database, and operate an HTTPS endpoint.
- Indexers: the first node indexes its own completed public records. Federation and independently replayable chain indexing are later stages.
- Observers/attestors: bootstrap roles verify external service reports before token settlement. They are a disclosed trust boundary, not decentralized proof of storage.
- Sponsors: fund bounded storage orders, publisher bounties and reward allocations. No file upload or download directly mints tokens.

The app's Ed25519 key and an EVM wallet are distinct identities. A ledger entry cannot infer EVM ownership from an archive fingerprint. Any binding requires explicit wallet authorization and domain-separated proof. Public content registration must not be confused with copyright adjudication.

## Stage A — runnable bootstrap (this delivery)

1. Containerized node with persisted state, authenticated bounded uploads, resume/restart, integrity finalization, visibility and public search.
2. App node client, resumable local snapshot/jobs, public listing/sorting and verified import.
3. Local EVM contracts and scripts for capped test currency, provider accounting, prepaid service settlement, sponsored content tasks and prefunded reward claims.
4. Local Docker acceptance of storage, restart, visibility, search, integrity and the local blockchain settlement path.
5. Public source repository, documented threat model, operations and exact implementation gaps.

No mainnet contract, publicly reachable node, public testnet contract, live airdrop, token sale, permanent storage promise or audited production service is implied by local validation.

## Stage B — authenticated observation and funded pilot

Before admitting untrusted operators, add redundant observers and independent service checks; preserve evidence with signed identities, archive/version commitments and contract domain. Test false reports, unavailable observers, provider recovery and request replay. Define the attestation threshold, appeal process and administrator rotation. Storage orders must specify bytes, retention interval, exact fee and who bears re-replication costs.

Pilot with a small published quota and actual sponsored funding. Measure disk growth, expiry cleanup, recovery after process/container/host failures, restore from backups, transfer latency and cost per GiB-month. Refresh reporting identities and credentials separately from node data. Test interrupted multipart uploads, storage exhaustion, network churn and client identity loss with fixtures, never real user libraries.

## Stage C — public network and chain anchoring

Add content registry events, explicit Ed25519/EVM binding, multiple independently operated indexers, signed node announcements and downloadable registry snapshots. Validate RPC chain ID, contract address, deployment code and checkpoint freshness. An indexer is replaceable; clients must be able to compare/rebuild its public state. Do not publish private titles, paths, keys or household/device metadata on chain.

Reserve public resources only after the configured availability target is met. Target three copies across separate operators/failure domains; this is a target until independently verified. Add timed retention renewal, migration and node exit/replacement. A public static node list is replaceable configuration, not immutable trust.

## Stage D — durable proofs and paid service

Integrate an established storage proof system rather than inventing replica proofs from HTTP challenges. Random retrieval and Merkle samples establish current access, not independent physical replicas or continuous storage. Pay serving nodes for attributable funded requests; distinguish storage, transfer and indexing revenue. Add agreed slashing only for objectively verifiable offenses, not one observer's timeout.

## Economics

Test currency has no asserted monetary value. All payouts are prefunded and capped by deposited balances. Recommended production budgeting separates real-cost storage fees from optional diminishing bootstrap incentives. For an illustrative subsidy epoch, maximum allocations may be 60% operators, 25% accepted publication tasks, 10% observers and 5% indexers; an ineligible share remains undistributed, not automatically divided among survivors. These percentages are policy proposals, not generated revenue.

Publication tasks have a sponsor, specification, exact budget, reviewer and expiry. Acceptance verifies useful completeness, license declarations and audio alignment; a hash does not establish ownership or quality. Re-encoding, padding, duplicate publication, duration and raw downloads do not automatically qualify. Multi-payee rights splits, partial task payments and 30-day availability vesting require explicit implementation before being offered.

Downloads and Trending are discovery signals only. A node can count observed successful deliveries but cannot prove unique humans. Counter spam, Sybil identities and operator-client collusion must not produce automatic subsidy claims. Anonymous access can coexist with bounded paid contracts; it cannot establish one person per address.

## Production gates

- Independent contract/security review and economic attack simulations.
- Persistent data restore, independent availability verification and funded retention/replacement obligations.
- Multi-party administration, documented attestor replacement, incident response and monitored quotas.
- Legal review of token issuance and content licensing in deployment regions, plus Apple storefront review of payments/rewards; moving a button to a website is not by itself compliance.
- Public node endpoint/domain, real operators, budget and selected public chain supplied by the project owner before a public launch.

## Reference concepts

[Odysee monetization](https://help.odysee.tv/category-monetization/setup/), [LBRY claims](https://spec.lbry.com/), [ar.io observation and incentives](https://docs.ar.io/learn/oip), [Filecoin storage proofs](https://docs.filecoin.io/reference/general/glossary), [Apple review rules](https://developer.apple.com/app-store/review/guidelines/).
