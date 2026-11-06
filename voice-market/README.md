# Personal voice license sandbox

This Node.js 24 service issues personal licenses for immutable version 2 voice packages. A rights holder signs a distribution and certificate issuance grant. Buyers can restore Ed25519 certificates, export a PDF copy, and retrieve authorized files. The service supports two test configurations. Sandbox credits stay in an isolated ledger. Base Sepolia uses a confirmed test transaction and leaves the sandbox ledger untouched. With neither mode enabled, purchases return `production_payment_not_configured`. Both modes use test assets and provide no verification of a rights holder's real-world identity or ownership.

## Start the service

Run Docker with Compose V2. From the repository root, create `.env` from `.env.example` for a new installation. Keep the existing `.env` and data volume when upgrading.

Set `VOICE_MARKET_ADMIN_SUBJECTS` to the fingerprint of a reviewer key and `VOICE_MARKET_MODERATION_CONTACT_URL` to a monitored HTTPS page before accepting packages. The catalog stays empty and publishing and purchases are unavailable until review is configured. Follow the [operator moderation workflow](../docs/OPERATIONS.md#content-moderation).

Choose one of the supported test modes in `.env`.

| Test mode | Configuration |
| --- | --- |
| Sandbox credits | Set `VOICE_MARKET_SANDBOX_ENABLED=1` and leave `VOICE_MARKET_SETTLEMENT_CHAIN_ID` empty. Credits stay in this service's local test ledger. |
| Base Sepolia | Leave `VOICE_MARKET_SANDBOX_ENABLED=0` and set `VOICE_MARKET_SETTLEMENT_CHAIN_ID=84532`, `VOICE_MARKET_SETTLEMENT_ADDRESS` and `VOICE_MARKET_CHAIN_RPC` to the test settlement contract and an HTTPS RPC. Set `VOICE_MARKET_SETTLEMENT_HOLD_SECONDS` to the contract's hold period. The default is `604800` seconds. |

The service starts with purchases disabled when neither mode is configured. When both are enabled, purchases use Base Sepolia and sandbox ledger routes remain enabled. Base Sepolia startup verifies the RPC chain ID, contract hold, 18-decimal token and package key version. Use a test token and a test wallet. [Voice license settlement](../contracts/README.md#voice-license-settlement)

Start the service and inspect the issuer metadata.

```sh
docker compose -f compose.voice-market.yaml up --build -d
curl -fsS http://127.0.0.1:8793/v1/voice-issuer
```

Check `paymentMode` for `sandboxCredits` or `base-sepolia-test` and confirm the issuer advertises the configured moderation contact.

Compose binds the host port to loopback. If the MiniMax Music 3 adapter also uses port 8793, set `VOICE_MARKET_PORT=8796` in `.env` and use 8796 in the local URL and proxy upstream. For remote access, set `VOICE_MARKET_PUBLIC_URL` to the HTTPS origin and use a TLS proxy. Keep the dedicated volume separate from the book node and mesh. Back up the database and `issuer.der` together. Use a consistent SQLite snapshot that includes the journal, or stop the service before copying. Verify the issuer fingerprint through a separate trusted channel before pinning it. Secure key rotation and buyer identity recovery need a separate process.

## Authentication and package format

The health, issuer, catalog and economic-policy routes are public. Sign other requests, including GET downloads and certificate status, with the same `ATS-NODE-V1` headers and canonical message used by the book node. The subject ID is the lowercase SHA-256 of the 32-byte raw Ed25519 public key. Use HTTPS for remote access and keep signatures within the intended origin when handling redirects. Purchases belong to the current publishing identity. Restoring them on another device requires securely recovering that identity.

The certificate envelope is `{algorithm:"Ed25519",keyID,payload,signature}`. Encode the exact original JSON UTF-8 bytes as standard base64 for `payload`. Sign those bytes with Ed25519 and encode the signature as standard base64. The issuer advertises its raw 32-byte public key as standard base64. Pin the trusted key explicitly and enable sandbox certificates separately. A key delivered with a package or discovered from the network needs independent verification.

The version 2 manifest contains `schemaVersion:2`, `packageID` (UUID), `version`, `rightsHolderID`, `name`, `recordingLanguage`, `targetLanguages`, `engine`, `modelRevision`, `files:[{path,sha256,byteLength}]`, `samples:[{path,transcript,language}]`, `previewPath`, and `licenseKinds:["commercial","noncommercial"]`. Use a separate preview file. The server checks paths, sizes and digests. The client also checks whether the audio decodes and the model is compatible.

Limits are 24 MiB decoded package, 64 KiB encoded manifest, 128 files, 64 samples, 10,000 versions, and 1 GiB aggregate encoded package and delegation storage. Keep file retrieval on the authorized package content route. It serves the complete response and rejects Range requests.

## API

### Discovery, credits and publication

| Endpoint | Behavior |
| --- | --- |
| `GET /health` | Service health and enabled test mode. |
| `GET /v1/voice-issuer` | Issuer and key IDs, raw public key, sandbox flag, payment mode and configured moderation contact. |
| `GET /v1/voice-packages` | Up to 20 active, approved listings with integer license prices and terms snapshots. `settlementHolder` is the verified publisher wallet, or null until binding. Catalog responses omit recording bytes and personal certificates. |
| `GET /v1/voice-balance` | The signed-in buyer's durable balance. |
| `POST /v1/voice-sandbox-credits` | Transfer `{amount}` from the finite sandbox treasury. Units are hundredths of a token. The limit is 100,000 units per request and 1,000,000 units in the current balance. The app requests 10,000 units (100 tATN). |
| `POST /v1/voice-packages` | Publish a package version for moderation with the manifest, files, prices, terms and distribution grant. |
| `DELETE /v1/voice-packages/:id/versions/:version` | Let the holder unlist a version. Eligible previous buyers can still retrieve approved content under their existing license. |

The publishing body is `{manifest,files:[{path,data:base64}],prices:{commercial:integer,noncommercial:integer},terms:{version,text},distribution:{operatorID,rightsHolderID,packageID,packageVersion,allowDistribution:true,allowCertificateIssuance:true,termsVersion}}`. The authenticated publisher must match the manifest and grant holder. The grant must name the issuer as operator and match the sold terms version. The node privately retains the signed request as delegation evidence. Versions are immutable and package UUID ownership is checked case-insensitively.

### Purchases and certificates

Use `POST /v1/voice-purchases` with `{packageID,packageVersion,licenseKind,expectedPrice,termsSHA256}`. Compute `termsSHA256` from the exact UTF-8 bytes of `terms.text`. Changed terms or price return HTTP 409. An active duplicate purchase restores the certificate without another charge. Refunded licenses cannot be purchased again.

- In sandbox mode the service atomically debits existing ledger units and returns `{orderID,certificate,balance,sandbox:true}`.
- In Base Sepolia mode provide `settlementTransaction`. The service checks the bound buyer wallet, confirmed `purchase` receipt and matching current order and license state. A refunded receipt cannot create a certificate. The sandbox balance is separate.

| Endpoint | Behavior |
| --- | --- |
| `GET /v1/voice-packages/:id/versions/:version` | Package metadata for the holder, reviewer or entitled buyer. Approved versions can remain available to buyers after unlisting. |
| `GET /v1/voice-packages/:id/versions/:version/content` | Complete `{manifest,files}` for the holder, reviewer or entitled buyer. `files[].path="manifest.json"` preserves the exact bytes bound to the signed certificate. Buyer access requires approved status and an active entitlement. Disabling sandbox disables sandbox-only download rights. |
| `GET /v1/voice-certificates` | Restore the buyer's certificates with their current statuses. |
| `GET /v1/voice-certificates/:orderID` | Certificate envelope and status for the buyer or administrator. |
| `GET /v1/voice-certificates/:orderID/status` | Authenticated live status. Check it for revocation. |
| `GET /v1/voice-certificates/:orderID/pdf` | Human-readable PDF. Use the signed JSON for cryptographic verification. |
| `POST /v1/voice-certificates/:orderID/refund` | Administrator action. In sandbox, refund within the seven-day reserve window, revoking access and returning all three reserved shares once. For testnet, provide the matching confirmed refund in `settlementTransaction`. Downloaded files remain on the buyer's device. |

For purchase, publishing, unlisting, refund and other ledger or wallet mutations, include the same `Idempotency-Key` in the HTTP header and `idempotencyKey` in the signed JSON body. Use 16–128 ASCII letters, digits, underscores or hyphens. Binding the key to the signed body prevents substitution. Retry a transport failure with the original operation body and key and a fresh signature and nonce. Reusing the key with a different body or endpoint returns HTTP 409. The service caps persistent mutation records at 100,000, orders at 100,000 overall and orders per buyer at 1,000. Existing idempotent retries still resolve at capacity.

A holder's declaration records their assertion of rights. Review the voice and distribution authorization before approval. Personal licenses prohibit transferring, reselling, sharing or sublicensing the resource. Distribution of commercial works depends on the accepted terms.

## Content moderation

Set `VOICE_MARKET_MODERATION_CONTACT_URL` to a monitored HTTPS page and `VOICE_MARKET_ADMIN_SUBJECTS` to comma-separated reviewer fingerprints. With both set, the issuer advertises the contact. New and migrated versions enter the pending queue. Approval is required for listing and purchase. Purchasers can still view their certificates if moderation withdraws access to the underlying package.

Authenticated users report an approved version with `POST /v1/voice-packages/:id/versions/:version/reports` using `reason` and optional `details`. The signed report returns a receipt ID and does not require an idempotency key. Reviewers use signed administrator requests to inspect pending content, decide cases and resolve reports. Follow the [operator moderation workflow](../docs/OPERATIONS.md#content-moderation).

## ATS app entry

Open Voice Market, enter the service origin, and independently check the operator fingerprint before trusting the issuer. For test credits, permit sandbox certificates on the pin. Read and accept the exact terms before choosing a personal license, then restore status, import an entitled package, or export the signed JSON and PDF. The service uses the device's protected publishing identity for signed requests and stores endpoint preferences separately. Operation IDs are written before remote mutation and reused with fresh authentication after an ambiguous network failure. The operation file contains neither recordings nor credentials.

Publish from a locally recorded voice you own. Supply the rights declaration, full terms and a distinct preview alongside the reference audio. The app binds purchased files to the certificate and reference digest when synthesizing and reserves publishing for the user's own voices. In Base Sepolia mode the external wallet confirms the settlement token approval, package registration and purchase. Buyer access across devices requires a secure recovery flow for the same identity.

## Fixed-supply sandbox revenue

`GET /v1/voice-economic-policy` reports the ledger namespace, cap, treasury, 80/15/5 split, seven-day hold and unit mapping. Each `ledgerID=ats-voice-market:<issuerID>` has an isolated 100-million-token cap. In off-chain mode the policy reports `chainID=null`, `network=offchain-sandbox`, `onchainDeployed=false` and `withdrawalsEnabled=false`. A wallet binding proves address control without moving sandbox balances on-chain.

Publishers set prices before immutable publication and include `economicPolicyID` in new publishing signatures. Suggested noncommercial and commercial prices are 10 and 50 tATN (1000 and 5000 ledger units). The sandbox uses `ledgerUnitsPerToken=100`. The testnet token retains 18 decimals and uses `onchainAtomicPerLedgerUnit="10000000000000000"`.

A purchase moves buyer units into three reserves. Publisher and operator shares round down to a ledger unit, and the platform receives the remainder. After seven days, `POST /v1/voice-revenue/settle` makes eligible reserves spendable by the bound recipients. They can reuse those units for purchases. `GET /v1/voice-wallet` returns spendable, reserved, settled and ready amounts with verified wallet binding and `onchainBalance:null` in sandbox. Set `VOICE_MARKET_OPERATOR_SUBJECT` and `VOICE_MARKET_PLATFORM_SUBJECT` before first initialization. Policy changes require explicit migration.

Request `GET /v1/voice-wallet/binding-challenge`, sign the EIP-191 message in the external wallet, and send `{challengeID,address,signature,idempotencyKey}` to `POST /v1/voice-wallet/binding` with the ATS signature. The EIP-191 statement has eight exact lines with no trailing newline:

```text
ATS-VOICE-WALLET-V1
<origin>
<issuerID>
<ledgerID>
chainID:none
<Ed25519 subject>
<challenge UUID nonce>
<ISO8601 expiry>
```

The recovered address must match the claim. Challenges expire after five minutes and are single-use. An address cannot be rebound or shared across subjects. Binding proves control and authorizes no transaction.

Migration preserves ledger entries, certificates and retry records at one old credit per ledger unit. It reconstructs active historical reserves and offsets historical issuance from the finite treasury. Excess issuance, negative balances, inconsistent orders and a supply mismatch abort the transaction. Genesis runs once, and startup checks total supply thereafter.

## Base Sepolia entitlement checks

The service reconciles certificate list, status, PDF and content reads against confirmed order and license state at 12 confirmations on Base Sepolia (one block in disposable local verification). It records finalized refunds before responding. Newer unconfirmed refunds may leave the previous confirmed status visible. RPC failure or a missing or mismatched chain or contract configuration prevents access. An old signed certificate alone cannot grant access.

Deploy `VoiceLicenseSettlement` with `PACKAGE_KEY_VERSION=2`. Register the resource ID `keccak256(UTF8(packageUUID + "/" + version))`. Buy using the holder-scoped key `keccak256(abi.encode(settlementHolder,resourceId))`. An immutable older deployment requires migration to a new contract.

## Verification scope

The previous targeted settlement check used an in-memory SQLite fixture to exercise holder-scoped registration, refund reconciliation, confirmation depth and refusal when chain checks fail. The moderation change record covers syntax checking. General concurrency, ledger migration, EIP-191 interoperability, and end-to-end moderation remain outside that record.

See the [contract guide](../contracts/README.md#voice-license-settlement).
