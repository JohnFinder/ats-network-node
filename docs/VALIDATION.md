# Verification record for 2026-10-16

This record covers the local storage and chain acceptance run described below. The standalone publication of 2026-10-22 underwent static source, metadata and documentation checks. See the [GPU validation record](../tts/VALIDATION.md) for the separate speech configuration scope.

## Environment and procedure

The run used Docker Desktop with Engine 29.8.2 and Node.js 24 host tools. Storage used `node:24-alpine` and contract tools used `node:24-bookworm-slim`. The contract lockfile pinned Solidity 0.8.30, OpenZeppelin 5.4.0, ethers 6.15.0 and Ganache 7.9.2.

`./scripts/verify-docker.sh` passed in an isolated Compose project with fresh volumes. The runner built both images, uploaded the first 8 MiB of a synthetic archive, restarted storage and checked the original provider identity and uploaded part before resuming. It completed the archive and sent evidence from that node to a local EVM deployment with chain ID 1337. It removed its own containers and volumes after success.

The storage preparation phase passed 2 checks. Resume, access and download passed 20 checks. The integrated local chain passed 26 checks.

## Storage coverage

- Provider identity and exact uploaded part hashes persisted across the restart.
- Owner isolation held, and the node rejected mutated signed bodies, replayed requests and otherwise valid signatures addressed to a different node.
- The node rejected incomplete or incorrect-hash publications and supported idempotent completion and cancellation of unfinished uploads.
- The catalog handled public search and pagination while excluding private and unlisted records. At the tested revision, successful public uploads became searchable immediately.
- Full and ranged retrieval returned exact bytes. The full archive matched its SHA-256.
- Incomplete transfers did not increment observed downloads. Repeated completion did not count twice. The run checked downloads and Trending ordering.
- Private owner tickets worked, and unauthorized metadata requests and deletions failed.
- Evidence signatures matched the pinned node identity.

Fixtures used the `ATSBOOK1` prefix and synthetic bytes. Full archive signature acceptance, playable audio, app UI and device playback require separate checks.

## Local chain coverage

Before submitting the evidence digest for settlement, the verifier fetched signed evidence, checked the expected node identity, independently retrieved the object and checked its hash. Wallet binding was outside that inference.

The run covered publisher-scoped immutable registration, capped preminted test supply, stake accounting, unbond protection during active service, attestation authorization, duplicate and threshold checks, committee generation isolation, prepaid settlement, expired-service refunds, bounty delay and payout, epoch delay, proof, recipient and replay checks, budget accounting, cancellation before epoch activation, and delayed bond withdrawal. Final token balances matched recorded liabilities. The run used a local test currency with no monetary value. Upload and download activity did not mint tokens.

## Limits and reruns

Public DNS and TLS issuance, physical devices, production disaster recovery, independent replicas, human uniqueness, adverse network conditions, sustained abuse load, public-chain finality, production economics, external audits and Apple review require separate validation. The bootstrap design continues to trust the administrator and configured attestors.

GitHub acceptance requires a manual dispatch. When evaluating a later revision, check the exact source revision, environment and results of its own run.
