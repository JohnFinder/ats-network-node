# Verification record — 2026-10-16

## Executed locally

Docker Desktop/Engine29.8.2; Node24 host tooling; storage image `node:24-alpine`; contract tooling image `node:24-bookworm-slim`; Solidity0.8.30, OpenZeppelin5.4.0, ethers6.15.0 and Ganache7.9.2 pinned in the contract package lock.

`./scripts/verify-docker.sh` passed from a new isolated Compose project and fresh volumes. It built both images, uploaded the first8MiB of a synthetic fixture, explicitly restarted storage, recovered the same provider identity and upload parts, completed the upload and then connected actual node evidence to a local EVM1337 deployment. The script removed only its own containers and volumes after success. The final run included target-origin audience signatures and rejection of a valid signature addressed to a different node.

Storage prepare:2 checks. Resume/access/download phase:20 checks. Integrated local-chain phase:26 checks. These are script-level functional acceptance checks, not a security audit or comprehensive formal verification.

## Storage behaviors covered

- Persistent identity and upload parts across container restart; exact remote part hashes.
- Owner isolation; signed-body mutation and request replay rejection; cross-node audience rejection.
- Incomplete and incorrect-hash publication rejection; idempotent completion; unfinished upload cancellation.
- Public records automatically searchable, pagination input validation, private and unlisted records excluded.
- Full exact-byte/SHA256 retrieval and HTTP range retrieval.
- Incomplete downloads cannot increment counters; completion cannot count twice; local downloads/trending ordering.
- Private owner tickets, unauthorized metadata access and unauthorized deletion.
- Node evidence signature and pinned identity verification.

Synthetic fixtures have an ATSBOOK1 prefix but are not valid signed audiobook archives. This deliberately exercises storage as an opaque bounded byte service. It does not establish full archive signature acceptance, playable audio, app UI correctness or device playback.

## Local-chain behaviors covered

Actual signed node evidence was fetched, verified against an expected node identity, and its object independently downloaded and hashed before the evidence digest entered settlement. Provider wallet binding was explicitly not inferred.

Checks cover publisher-scoped immutable registration, capped preminted test supply, deposited stake accounting, active-service unbond protection, unauthorized/duplicate/insufficient attestation rejection, committee-generation isolation, prepaid service settlement, expired-service refund, publisher bounty delay and payout, epoch delay/proof/recipient/replay checks, budget accounting, preactivation epoch cancellation and delayed bond withdrawal. Final token balance equals tracked liabilities.

No upload/download minted tokens. No mainnet or public-testnet deployment, monetary-value token, actual payment or wallet balance was used.

## Not exercised / not claimed

Public HTTPS certificate issuance/DNS, Internet deployment, physical mobile devices, production backups/disaster recovery, independent storage replicas, Sybil-resistant humans, real-world network partitions, sustained adversarial load, public-chain RPC/finality, production economics, third-party audit and Apple review. The HTTPS overlay is provided as deployment configuration, not an assertion that a public service is live. Bootstrap attestors and administrator remain trusted roles.

GitHub CI runs the same isolated Docker acceptance script when enabled by repository policy. Remote CI status must be checked separately; local success alone does not imply a remote pass.
