# ATS operator services

Node 24 + ethers 6.15.0. Separate service identity, observer wallet and settlement wallet. Never reuse provider or publisher wallets for observers. Retrieval observations are not independent replica proofs; the configured threshold committee is trusted. The service never manufactures storage evidence, gas funds or token balances.

## Configuration

Required: `SERVICE_RPC_URL`, `SERVICE_CHAIN_ID`, `SERVICE_DEPLOYMENT_MANIFEST` (read-only mounted JSON from `contracts/scripts/deploy-v2.mjs`), `SERVICE_PUBLIC_URL` (HTTPS origin). The manifest commits deployed runtime code hashes and ABIs. It cannot set the RPC endpoint. Mismatched chain, contract bytecode or database deployment aborts startup.

`SERVICE_APPROVED_NODES` is a JSON array of `{url,providerID}` with SHA-256 raw Ed25519 public-key fingerprints. Only those origins are contacted, with redirects rejected. `SERVICE_APPROVED_INDEXERS` similarly accepts `{url,serviceID}`. Remote metadata must match the confirmed chain SHA-256 commitment and the original pinned node's signed publisher upload request. A successful full SHA-256 retrieval is required before appearing in the public catalog. Service-generated rankings identify their source and do not fabricate global download counts.

`SERVICE_DATA_DIR` defaults to `./data`; mount a writable persistent volume owned by uid 1000. SQLite WAL stores block hashes, canonical events, metadata, dual-signature binding proofs, intents, lease nonces, schedules and audit evidence. `SERVICE_SIGNING_KEY_FILE` optionally points to an operator-controlled DER PKCS8 Ed25519 secret; otherwise a mode-0600 identity is created once in the volume.

`SERVICE_CONFIRMATIONS` defaults 12. `SERVICE_POLL_MS` defaults 5000. `SERVICE_MAX_AUDIT_BYTES` defaults 1 GiB. Full audits stream rather than buffering objects. `SERVICE_CATALOG_CHECK_SECONDS` defaults 3600. Disappearing sources expire from the catalog. Metadata remains retrievable only for confirmed chain publications. Run `node src/main.mjs --rebuild` to replay from the deployment block. Stop the old instance first; do not share a writable database between processes. Ordinary restart resumes cursors and verifies canonical block hashes. Keep SQLite consistent snapshots (including WAL) and encrypted backups; restoration revalidates against the explicit RPC.

For development only: `SERVICE_ALLOW_HTTP=true`, `SERVICE_CONFIRMATIONS=0`; explicit HTTP origins are allowed including Docker names. Production defaults require HTTPS. Do not expose development RPC or mount Docker socket.

## Observer daemon and coordinator

Mount independent Docker secrets: `SERVICE_OBSERVER_KEY_FILE=/run/secrets/observer_key` and optional `SERVICE_SETTLEMENT_KEY_FILE=/run/secrets/settlement_key`. Raw private key env is accepted only with the explicit development flag. Each observer needs a distinct funded EVM account already authorized in the market committee and its own data volume; it refuses unauthorized startup and stops financial actions on zero gas. No key is returned through APIs or normal logs. Rotate/revoke committee roles through reviewed contract administration.

Per prepaid order/period the observer persists three jittered challenge slots by default (`SERVICE_AUDIT_SAMPLES`, max 20). Each timely challenge validates the provider's signed evidence, the confirmed EVM/Ed25519 binding and actual full object bytes. Missed slots are failures, never retroactively fabricated. Max two audit operations per tick (`SERVICE_OBSERVER_WORK`). Reports match only when independent observers agree on period, policy and success count; exact signed individual observations are available separately. This threshold model cannot prevent a colluding committee and does not prove independent physical replication. An observer must not be its own provider.

The separate permissionless coordinator only calls `settlePeriod` after the contract exposes sufficient approvals, elapsed review, unchanged committee/round and no challenge. It never settles a provider self-report. Errors show `retry_pending`, unauthorized or `insufficient_gas`; retry rate is bounded by the poll interval. Owner challenge resolution remains an explicit wallet action; neither daemon adjudicates disputes automatically. Shutdown drains work for up to 15 seconds, then the process exits; durable chain state reconciles pending transactions on restart.

## APIs and wallet flow

- `GET /v2/network`: deployment commitments, pinned nodes, indexing/observer/coordinator health.
- `GET /v2/catalog?q=&cursor=&limit=`: signed bounded chain-confirmed catalog, newest-first with block/source provenance. Trending/download statistics belong to the mesh node catalog and are explicitly observational.
- `GET /v2/metadata/:sha256`: signed exact metadata bytes for pinned indexer replication.
- `GET /v2/identity/:fingerprint`, `/v2/account/:fingerprint`: confirmed identity, verified local dual proof, publications, orders, settlements. An on-chain binding without the independently verified Ed25519 proof never receives `edProofVerified=true`.
- `GET /v2/binding-nonce?wallet=0x…`; `POST /v2/binding-intents`: payload `{walletAddress,publicKey,nonce,expiresAt,chainId,registry,statement,signature}`. Ed25519 signature is base64. Exact statement (no trailing newline): `ATS-WALLET-BIND-V1\n<decimalChainId>\n<lowerRegistry>\n<lowerWallet>\n<sha256RawEdPublicKey>\n<nonce>\n<expiryUnixSeconds>`.
- `GET /wallet?intent=<uuid>`: local served wallet page with CSP, EIP-1193 wallet, explicit typed-message and user-paid transaction approval. No private keys or funded relayer. EVM chain/account must match. Both `GET /v2/binding-intents/:id` and `POST …/:id/complete` serve binding/publication intents. Completion verifies wallet signature and the confirmed contract state.
- `GET /wallet/publish?node=<approvedOrigin>&resource=<uuid>` creates a plan only after verifying the source and binding. `POST /v2/publication-intents` takes `{nodeURL,resourceID}`. Initial wallet path uses 100% publisher split, with exact review before signing; general splits remain available directly through the contract. The wallet signature commits all public metadata. No automatic token transfer approval is requested.
- `GET /v2/orders/:numericId/lease`: signed node retention receipt only for confirmed prepaid active matching order and dual-verified provider binding. Fresh timestamp, monotonically durable nonce, cached idempotent receipt UUID, EVM order encoded bytes32. Configure the service Ed25519 fingerprint as a trusted settlement issuer on the node. Receipt validity is a policy trust boundary: revocation/early termination requires subsequent issuer checks; possession is not proof of future delivery.
- `GET /v2/observations?orderID=`: bounded signed exact audit records.

Payloads, cursors, open intents, concurrent requests, origins and request rates are bounded. No API accepts arbitrary RPC, source URL, signing key, shell command, contract ABI or transaction destination.

## Local verification

With isolated chain 1337 + deployed V2 manifest and this service running:

```
SERVICE_VERIFY_URL=http://127.0.0.1:8790 npm run verify
SERVICE_VERIFY_PRIVATE_KEY_FILE=/run/secrets/dev_verify_key npm run verify -- --binding
SERVICE_DEPLOYMENT_MANIFEST=/contracts/artifacts/deployment.v2.1337.json npm run verify -- --reorg
```

The optional binding exercise spends only explicitly supplied local development signer gas. The reorg exercise uses a chain snapshot/revert and must run on a dedicated disposable chain. Multi-observer verification must use distinct secret files/volumes and advance the local clock through each real observation window, rather than moving straight to period end and claiming historic availability. Do not use this CLI against production.

### Wallet management

`GET /wallet/manage` provides named fields for common bond, exact token approval, storage quote/order, royalty, task, retained milestone, refund and reward actions. Token amounts use the deployment token's reported decimals; transaction review includes the exact chain, destination, method and arguments. Detailed calldata is expandable. Signed quotes and reward vouchers can be imported as bounded JSON documents. Every operation requires a separate external-wallet confirmation. Editing a field invalidates its prior preview. No arbitrary ABI/destination or unlimited default approval is accepted.

### V2 local Docker record — 2026-10-16

`../scripts/verify-services-docker.sh` passed using a freshly compiled deployment, synthetic public archive, two separate observer identities/volumes and a separate permissionless coordinator. It verified double-proof provider/publisher bindings, canonicalized signed upload metadata, full-hash chain catalogue, paid lease issuance and actual node acceptance/idempotent retry, timely full-file observations, threshold report, requester challenge blocking settlement, renewed review after resolution, full period payout and missed-window refund, signed observations, service restart and separate index reorganization/rebuild. These containers run on one physical host and are not independent organizations. Verification uses only local chain 1337 and valueless test tokens.

Review fixes include event-based identity lookup without a nonexistent ABI method, prioritizing verified dual proofs, exact lease-provider matching, cached idempotent receipts with monotonic renewals, derived-evidence invalidation on reorg/rebuild, canonical-order checks before voting, committee generation checks and reused publication intents before expensive download. No public-network security audit is implied.

Binding authorization URLs expire after ten minutes, separately from the explicit signed binding lifetime (ATS/operator CLI defaults ninety days, maximum366 days). The wallet shows this lifetime; revoke or renew through an explicit transaction. Short browser intent lifetime never forces ten-minute on-chain identity renewals.
