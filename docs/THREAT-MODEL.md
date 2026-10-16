# Threat model and release boundary

## Protected assets

Archive bytes and visibility; signing keys; operator disk/bandwidth; upload ownership and replay state; service deposits, provider bonds, bounty budgets and reward budgets. Public metadata is intentionally public. EVM contracts and transaction calldata are public even if a Solidity field is called private.

## What the node verifies

- Domain-separated Ed25519 signatures cover configured target origin (audience), method, request target, timestamp, nonce and exact body hash.
- Signed timestamps have a five-minute window; nonces are stored across restart for longer than the acceptance window.
- Owner-specific opaque IDs prevent a private publication from becoming public merely because another user supplies the same content hash.
- Upload reservations account for pending and published bytes; requests and part buffers are bounded. Per-owner limits raise costs but are not one-person quotas: an attacker can generate keys. Total node quota and operator admission policy remain essential.
- Parts have fixed offsets and hashes. Completion recomputes every part hash, whole-file digest, size and outer ATSBOOK1 magic before indexing.
- Full archive signature, manifest schema, decryption and media acceptance remain the ATS client's responsibility. A magic prefix is not a content safety or rights proof.
- Private metadata requires authentication. Private download tickets are temporary bearer capabilities scoped to one file: possession permits downloading until expiry. They must never enter logs, public indexes or referral metadata.
- No URL supplied by a publisher is fetched by the server; the node does not act as an arbitrary HTTP proxy.

## Trust that remains

An operator can delete data, lie about availability or modify local ranking. A signed statement proves what that operator said. The local chain verifier additionally downloads and hashes the file at verification time; this is not continuous storage, physical location, independent-replica or network-consensus proof.

Download counters are observations of signed identities and completed server response ranges. Sybil identities and colluding endpoints can manufacture activity; counters must never authorize minting or subsidy settlement. The node does not prove a person listened or that the client durably saved the response.

Bootstrap contracts use an administrator and a threshold committee of trusted attestors. Attestors authorize observations; they can collude. The administrator chooses committee members and reward roots and can cancel proposed epochs. Delay windows enable inspection but are not an implemented decentralized dispute court. Unavailable committees can delay service acceptance/settlement; expired escrow can be refunded under contract rules. No automatic slashing for a one-sided network timeout is implemented.

The test token is fixed-supply and preminted, with no upload/download mint endpoint. Service, bond, bounty and reward liabilities are tracked separately and checked during acceptance. This limits authorized payouts; it does not replace an independent contract audit, prove revenue, or guarantee token value.

## Identity and privacy

ATS archive/device keys use Ed25519. EVM wallets use different keys and addresses. NODE_PROVIDER_ADDRESS is a declaration only; it is not proof of control. V2 requires a domain-scoped Ed25519 proof and EVM typed authorization plus confirmed state. A wallet signature alone does not prove the Ed25519 key and vice versa. Public-chain deployment remains unvalidated until explicitly deployed and reviewed. An anonymous name is not network anonymity: nodes observe IP connections and public chains expose transactions.

Encrypted packages remain encrypted end to end only while content keys remain private. Public titles, summaries, tags, archive sizes and publishing identity are visible. Recipients can redistribute keys or plaintext. Deletion only controls this operator's bytes and index; it cannot recall external copies or remove chain history.

## Deployment assumptions

One process owns one SQLite database/data directory. Do not run concurrent replicas against the same volume. Use the HTTPS overlay or an equivalent trusted reverse proxy; publicURL comes from explicit configuration, not the Host header. The default Compose binding is loopback. The local chain overlay is developer-only with public deterministic keys and must never be Internet-exposed or receive real assets.

The data volume includes the operator private signing key, database and objects. Back it up consistently and protect access. Upload expiry is not a promise of paid long-term retention; completed files remain subject to operator capacity and removal unless an explicit funded retention agreement is in force; even then continued service requires independent monitoring and recovery.

## Implemented V2 boundaries

Pinned federation and replica repair depend on trusted origin keys and bounded configured peers. No arbitrary publisher URL is fetched. Replica existence/HTTP retrieval does not establish unique hardware, independent ownership or continuous custody. Signed catalogues authenticate their issuing node; local rankings are not global consensus.

The replaceable chain indexer validates a selected manifest/RPC chain ID and runtime code, tracks confirmed canonical blocks and rewinds reorged events. Offchain material must match the committed metadata hash. Observers must isolate evidence by canonical order/period to avoid reusing observations after reorganization. Pending or stale events cannot authorize payment.

Committee reports, dispute resolution and prefunded reward roots retain disclosed administrator trust. Threshold processes running on one development host are not independent organizations. Withdrawal/reward liabilities and period budgets are bounded by deposited test tokens; this is not audited monetary security. No mainnet or publicly funded operation has been performed.

The official Filecoin PDP adapter delegates established storage commitments to that network. Local adapter/mocked checks are not proof that a live Filecoin provider stored a specific archive. Live upload requires explicit funded execution and retention monitoring.

Remaining external gates include independent security/economic review, real independent operators and funding, content/license adjudication and storefront policy review. Native device P2P, decentralized committee selection and unique physical-replica proofs are not implemented. The App uses configured federated HTTPS peers; that transport must not be advertised as native libp2p. Client archive downloads restart as whole verified transfers; node replica transfers persist ranges.
