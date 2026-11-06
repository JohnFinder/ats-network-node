# Threat model and release boundary

## Protected assets

The node protects archive integrity and visibility, signing keys, operator disk and bandwidth, upload ownership and replay state. Contracts track service deposits, provider bonds, bounty funds and reward budgets. Public metadata, EVM transactions and contract state are visible, including values stored in Solidity fields declared private.

## What the node verifies

- Domain-separated Ed25519 signatures bind the configured target origin, method, exact request target, timestamp, nonce and hash of the exact body. Timestamps have a five-minute acceptance window. The node retains used nonces across restart for longer than that window.
- Publication IDs are opaque and owner-specific. Publishing bytes with an existing private file's hash does not expose the private publication.
- Reservations count both pending and completed storage. The node bounds request sizes and part buffers. Attackers can generate identities, so operators also need node-wide quotas and admission controls.
- Parts have fixed offsets and hashes. Before indexing, completion checks each part, the full archive SHA-256 and byte count, and the `ATSBOOK1` prefix. ATS separately validates manifest schema, full archive signatures, decryption and media.
- Private metadata requires authentication. An owner-issued bearer download ticket grants temporary access to one file. Keep ticket URLs out of logs, public indexes and referrer metadata.
- Peer transfers use configured and verified origins. Publisher-supplied URLs cannot turn the node into an HTTP proxy.

## Trust that remains

Operators control the bytes they retain and the rankings they publish. A signature identifies the author of an availability statement. The local chain verifier also retrieves and hashes the bytes at verification time. Long-term storage, geographic location, independent replicas and consensus all require additional evidence.

Download counts reflect signed identities and completed server response ranges. A Sybil attacker or colluding operators can manufacture activity. Counters carry no minting or subsidy authorization and cannot establish listening or durable storage by the client.

Bootstrap contracts trust an administrator and a threshold committee of attestors. The administrator controls committee membership and reward roots and can cancel proposed epochs. Delay windows allow review. Committee outages can delay service acceptance and settlement, and expired escrow can be refunded under contract rules. A one-sided timeout does not trigger automatic slashing. Dispute procedures depend on the configured authority.

The test currency is preminted with a fixed supply. Service, bond, bounty and reward balances are tracked separately. The acceptance checks reconcile liabilities against balances. Contract audits, evidence of revenue and token valuation are separate questions.

## Identity and privacy

ATS uses Ed25519 for archive and device identities. EVM wallets have their own keys and addresses. `NODE_PROVIDER_ADDRESS` is an operator declaration. V2 verifies wallet control with domain-scoped Ed25519 proof, EVM typed authorization and confirmed contract state. A public-chain deployment needs its own deployment verification. Nodes observe IP connections, and public chains expose transactions even when users choose pseudonyms.

Encrypted packages remain confidential while their keys stay private. Public titles, summaries, tags, sizes and publishing identities remain visible. Recipients can share keys or plaintext. A local deletion affects the operator's bytes and index. Other copies and chain history can survive.

## Deployment assumptions

Run a single writer per SQLite database and data directory. The default Compose binding is loopback. Use the HTTPS overlay or a trusted reverse proxy for public access. The configured public origin controls returned URLs independently of the request's Host header. Keep the local chain overlay and its deterministic development keys away from the Internet and real assets.

The volume contains the operator's signing key, database and objects. Restrict access and take consistent encrypted backups. Upload expiry governs unfinished transfers. Completed files remain subject to operator capacity and removal. Funded retention creates an explicit commitment that needs monitoring and recovery.

## Implemented V2 boundaries

Pinned federation and replica repair depend on trusted origin keys and a bounded peer allowlist. Catalog signatures authenticate the issuer. Replica responses establish retrievability at a given time. Local rankings reflect node observations.

A replaceable indexer verifies the selected manifest, RPC chain ID and runtime code, tracks confirmed canonical blocks and rewinds reorganized events. Off-chain data must match its committed hash. Observers should bind evidence to the canonical order and period to avoid reusing observations after a reorganization. Only current confirmed events can authorize settlement.

Committee reports, disputes and prefunded reward roots depend on disclosed administrator and committee roles. Threshold processes on one host share a failure domain. Deposited test tokens cap liabilities and period budgets. No mainnet or publicly funded deployment is recorded here.

The Filecoin PDP adapter delegates storage commitments to the external network. Local adapter checks exercise integration and guardrails. A live commitment requires funded execution and ongoing proof observation.

Production still requires independent security and economic review, independent operators, funding, rights adjudication and storefront review. The app uses configured federated HTTPS peers. Native device P2P, decentralized committee selection and unique physical replica proofs remain outside this design. The client restarts whole archive downloads, while node replicas persist ranges across retries.
