# ATS Network delivery plan

ATS Network separates signed archive integrity, storage, discovery and token accounting. Operators provide infrastructure and decide what to host. Publishers sign uploads and sponsors fund explicit commitments. Each component supplies a different kind of evidence.

## Delivery status — 2026-10-16 V2

| Workstream | Implemented capabilities | Evidence and deployment work |
| --- | --- | --- |
| Storage and discovery | Fixed snapshots, resumable uploads, visibility, signed mesh catalogs, replica fallback, repair and drain | Local three-node acceptance and restart and restore fixtures. Operators must establish independent failure domains |
| Identity and registry | Dual Ed25519 and EVM proofs, nonce, expiry and domain checks, immutable commitments and royalty splits | Local EVM and service acceptance. ATS supports an external wallet. Public-chain deployment requires separate verification |
| Indexing | Manifest and runtime code pins, confirmed event replay, reorganization rollback, restart, rebuild and pinned metadata exchange | Local reorganization and restart fixtures. Select a confirmation depth for the production chain |
| Paid operations | Prepaid per-period service, observer processes, challenges and refunds, committee epochs, leases, funded tasks and reward epochs | Development tokens. The committee and administrator remain trusted roles |
| Storage proofs | Optional Synapse adapter for Filecoin PDP with guarded execution and receipts | SDK integration and guardrails. Live paid uploads and proof monitoring require a funded run |
| Operations | Compose deployment, separate secrets and volumes, quota and status surfaces, backup, recovery and drain instructions, public source and manual acceptance | Local Docker evidence. Production requires hosted capacity, independent audits and funding |

The stages below describe capabilities and operational acceptance criteria. A funded pilot and public operation require actual operators, infrastructure, independent review and a budget.

## Product flow

1. Export a complete signed `.atsbook` in ATS. Choose public, unlisted or private visibility and whether to encrypt the content.
2. Publish a fixed snapshot to a configured node. ATS stores the archive hash, node, upload ID and completed parts. On resume it reconciles that state against the server and retransmits missing parts.
3. The node verifies the completed bytes. Public publications become searchable after successful completion. At download, ATS verifies the archive hash and size before inspecting publisher proof, decrypting and importing.

The deployment owner can configure a default HTTPS URL when building the app. If a default is unavailable, the app exposes node setup. Users choose a node rather than managing buckets or object-storage credentials. Search and ranking reflect the selected node's observations.

## Roles and trust

- **Publishers** sign upload requests with a device Ed25519 key. The archive separately carries a signed content manifest. Content keys stay outside the node API.
- **Storage operators** provide disk, bandwidth and uptime. They keep a persistent node identity and database and serve an HTTPS origin.
- **Indexers** exchange signed public catalogs. Optional EVM services replay confirmed publication events and verify committed metadata and retrievability.
- **Observers and attestors** evaluate service observations for settlement. The bootstrap design explicitly trusts their committee.
- **Sponsors** fund bounded storage orders, publication tasks and reward allocations. Uploads and downloads carry no minting authority.

ATS Ed25519 identities and EVM wallet identities require explicit binding. The wallet authorizes the binding, and the Ed25519 key signs a domain-scoped proof. Public registry entries identify an archive commitment and its signer. Content rights require separate review.

## Stage A — runnable bootstrap (implemented)

- Containerized storage persists identity and state and supports authenticated bounded uploads, restart and resume, archive finalization, visibility and search.
- ATS handles persistent snapshot jobs, public listing and sorting, and verified import.
- The local EVM stack includes capped test currency, provider accounting, prepaid settlement, sponsored tasks and funded rewards.
- Local Docker acceptance covers storage, restart, visibility, search, integrity and settlement. Review the historical [verification record](VALIDATION.md) before using it as evidence.
- Public source includes the [threat model](THREAT-MODEL.md), [operations guide](OPERATIONS.md) and implementation limits.

## Stage B — authenticated observation (code implemented; funded pilot external)

Before admitting untrusted operators, deploy redundant observers and independent service checks. Preserve signed evidence bound to the archive, version and contract domain. Specify attestation thresholds, appeals, administrator rotation and recovery procedures. Define the bytes, period, fee and responsibility for replica replacement in each order.

Start a funded pilot with a small quota. Measure disk growth, expiry cleanup, process and host recovery, backup restoration, transfer latency and cost per GiB-month. Rotate reporting credentials separately from data. Use synthetic fixtures to exercise interrupted uploads, full disks, network churn, lost client keys, false reports and unavailable observers.

## Stage C — network and chain anchoring (code implemented; public launch external)

Operate multiple independent indexers using confirmed registry events, explicit Ed25519 and EVM bindings, signed node announcements and verifiable registry snapshots. Check the RPC chain ID, contract addresses, deployment code and checkpoint freshness. Keep indexers replaceable and their public state reproducible. Exclude private titles, paths, keys and household or device metadata from on-chain publication.

Before committing capacity, verify that placements meet the deployment's availability target. A three-copy target requires three independently verified operators or failure domains. Plan timed renewals, migration and provider exit. Keep the public node list replaceable.

## Stage D — durable proofs and paid service (adapter and contracts; live paid validation external)

Use an established storage proof system for claims that require it. Retrieval and Merkle sampling establish current access. Proving continuous storage or independent physical replicas takes additional evidence. Attribute funded requests to the serving nodes, and account separately for storage, transfer and indexing. Any agreed slashing should depend on objectively verifiable conduct. A single observer timeout is insufficient.

## Economics

The development currency carries no asserted monetary value. Deposited balances cap prefunded payouts. Production budgets can separate infrastructure fees from declining bootstrap incentives. One illustrative subsidy policy allocates maximums of 60% to operators, 25% to accepted publication tasks, 10% to observers and 5% to indexers. An ineligible share stays unspent.

Each publication task has a sponsor, specification, budget, reviewer and expiry. Review completeness, rights declarations and audio alignment. Re-encoding, padding, duplicate files, duration and download counts alone are insufficient. V2 contracts support immutable splits, separately funded milestones, challenge windows and availability-gated vesting. The sponsor still evaluates rights and quality.

Downloads and Trending help users discover content. Observed successful delivery cannot establish a unique human. Counter spam, Sybil identities and collusion must carry no automatic subsidy entitlement. Anonymous access can coexist with paid contracts, with no one-person-per-address guarantee.

## Production gates

- Independent contract and security review and economic attack simulations.
- Backup restoration, independent availability checks, and funded retention and replacement obligations.
- Multi-party administration, attestor replacement, incident response and monitored quotas.
- Regional review of token and content licensing requirements and Apple storefront review of payments and rewards, including external links.
- A public domain and endpoint, real operators, a budget and a selected chain.

## Reference concepts

See [Odysee monetization](https://help.odysee.tv/category-monetization/setup/), [LBRY claims](https://spec.lbry.com/), [ar.io observation and incentives](https://docs.ar.io/learn/oip), [Filecoin storage proofs](https://docs.filecoin.io/reference/general/glossary) and the [App Store Review Guidelines](https://developer.apple.com/app-store/review/guidelines/).
