# Storage protocol and configuration

This reference covers the storage node, publisher authentication, federation and funded retention receipts. For speech requests and API-key authentication, see the [VoxCPM2 endpoint contract](../tts/README.zh-Hant.md#app-介面契約).

## Configuration

| Variable | Default | Meaning |
|---|---:|---|
| `NODE_PORT` | `8787` | Container HTTP listener |
| `NODE_DATA_DIR` | `./data` (`/data` in Docker) | Persistent private data directory |
| `NODE_PUBLIC_URL` | `http://127.0.0.1:8787` | Origin placed in returned resource URLs |
| `NODE_MAX_FILE_BYTES` | `1073741824` | Maximum publication, 1 GiB by default |
| `NODE_OWNER_QUOTA_BYTES` | `10737418240` | Published plus active reserved bytes per key |
| `NODE_TOTAL_QUOTA_BYTES` | `107374182400` | Published plus active reserved bytes for this node |
| `NODE_MAX_ENTRIES` | `50000` | Total pending and completed publication records |
| `NODE_MAX_OWNER_ENTRIES` | `1000` | Pending and completed publication records per key |
| `NODE_UPLOAD_TTL_HOURS` | `168` | Incomplete upload lifetime; not extended on each request |
| `NODE_ADMIN_PUBLIC_KEYS` | empty | Comma-separated publisher **IDs**, each SHA-256 of raw public key, allowed to delete any publication |
| `NODE_PROVIDER_ADDRESS` | empty | Optional `0x` Ethereum address included in evidence; ownership is verified externally |

Maximum pending uploads per key: 32. Maximum simultaneously processed PUT requests: 4. Built-in request throttling: 1,200 requests/minute per immediate TCP peer. Behind a reverse proxy this peer may be the proxy itself; configure stronger public rate limiting there. The node deliberately does not trust arbitrary forwarded-IP headers. Metadata limits: title 300 characters, summary 4,000, language 64, 16 tags of 64 characters. Search accepts 200 characters and pages of 1–100 items.

## API and authentication

All mutation endpoints and private metadata reads require these headers:

```text
X-ATS-Audience: canonical NODE_PUBLIC_URL origin, without trailing slash
X-ATS-Public-Key: base64(raw 32-byte Ed25519 public key)
X-ATS-Timestamp: integer Unix seconds
X-ATS-Nonce: unique UUID
X-ATS-Signature: base64(raw 64-byte signature)
```

Sign the exact UTF-8 bytes below, with LF separators and no trailing newline:

```text
ATS-NODE-V1
AUDIENCE
METHOD
/pathname?query
TIMESTAMP
NONCE
lowercase-hex-sha256-of-exact-body
```

The audience must exactly match the node's configured public origin (scheme, host and non-default port, without a trailing slash). Binding the signature to that origin prevents a receiving node from replaying it at another node. Use the empty-body hash for GET. The publisher ID is lowercase hex SHA-256 of the raw public key. Nonces survive restart and cannot be reused while a timestamp could still be accepted. Public GET endpoints require no signature.

| Method/path | Behavior |
|---|---|
| `GET /health` | Health status |
| `GET /v1/node` | Provider public identity, capabilities, limits and available disk |
| `POST /v1/uploads` | Reserve capacity and initialize upload |
| `GET /v1/uploads/:id` | Owner retrieves uploaded parts |
| `PUT /v1/uploads/:id/parts/:index` | Owner uploads exact raw part bytes |
| `POST /v1/uploads/:id/complete` | Owner validates/assembles, automatically publishes if public |
| `DELETE /v1/uploads/:id` | Owner cancels incomplete upload |
| `GET /v1/resources?q=&sort=recent&cursor=&limit=30` | Public catalogue; sort `recent`, `downloads` or `trending` |
| `GET /v1/resources/:id` | Public/unlisted metadata, private owner metadata |
| `GET /v1/resources/:id/download` | Download with optional single HTTP byte range |
| `DELETE /v1/resources/:id` | Owner or configured moderator removes publication |
| `POST /v1/resources/:id/downloads` | Create an owner-bound 24-hour download ticket |
| `POST /v1/downloads/:ticket/complete` | Report verified full download |
| `GET /v1/resources/:id/evidence` | Signed, time-stamped node storage self-attestation |
| `GET /v1/mesh/announcement` | Signed node announcement, draining state and configured peer identities |
| `GET /v1/mesh/snapshot?cursor=0` | Signed public-only descriptors and replica inventory, 100 items/page |
| `GET /v1/mesh/resources?q=&sort=recent&cursor=0&limit=30` | Signed merged catalogue, timestamps and safe fallback sources |
| `GET /v1/mesh/status` | Peer health, bounded catalogue and observed replica state |
| `GET /v1/mesh/objects/:key` | Hash-verified public replica with HTTP byte ranges |
| `POST /v1/mesh/sync` | Signed configured administrator schedules a reconciliation |
| `GET /v1/stats` | Aggregate publication/replica bytes, active leases and drain state |
| `POST /v1/retention/quotes` | Publisher requests a time-limited quote for an owned resource |
| `POST /v1/retention/orders` | Publisher acknowledges a funded lease signed by a pinned settlement service |
| `GET /v1/retention/orders` | Publisher lists its own active/expired orders |

Initialize with JSON:

```json
{
  "sha256": "64 lowercase hexadecimal characters",
  "byteCount": 123456,
  "title": "Example audiobook",
  "summary": "Optional description",
  "language": "zh-Hant",
  "tags": ["example"],
  "visibility": "public",
  "encrypted": true
}
```

Visibility is `public`, `unlisted` or `private`. Public metadata is searchable immediately after successful completion. Unlisted content is accessible by ID but excluded from catalogue queries. Private content requires owner signatures; an owner-created download ticket additionally grants narrowly scoped download access to anyone holding its URL until expiry. Keep that URL secret and never publish it as a public source. Deleting data cannot recall copies already downloaded or indexed elsewhere.

An upload/status response contains `id`, `partSize`, `byteCount`, `sha256`, `expiresAt` and `parts`, where each part has `index`, `sha256`, `byteCount`. Resuming clients must check the local immutable payload hash and every server-reported part hash before skipping parts. Indices start at zero; only the final part may be shorter. Repeating identical part bytes is safe; a conflicting hash for an existing index is rejected. Completion can be retried and returns the same resource. Incomplete uploads expire after the configured lifetime.

Completed resources have `id`, `title`, `summary`, `language` (nullable), `tags`, `sha256`, `byteCount`, `sources`, `encrypted`, `publisherID`, `createdAt` (ISO-8601), `downloads`, `visibility`. Lists return `{ "items": [...], "nextCursor": null }`, or a cursor string for another page. Pagination uses offsets over the current ranking; results may move during concurrent publishing or downloads. Clients should deduplicate IDs. Search is bounded case-insensitive SQLite substring search for ASCII text, not a language-aware full-text engine.

For observed downloads, create a ticket with a signed POST and `{}` body. Use its `downloadURL` for all full/range requests. After hashing and validating the file, send signed JSON `{ "sha256": "..." }` to the completion endpoint. The server requires finished response ranges covering every byte, stores at most 1,024 merged response ranges per ticket and deduplicates one identity/resource/day, and returns `{ "counted": true, "downloads": 1 }`. Interrupted transfers, repeated ranges and direct anonymous GETs do not each add a count. The figure is an observation of participating identities, not verified humans, all network downloads, token-earning work, or proof of listening. Trending uses a 30-day window and diminishing weight with a two-day time scale; it is an approximate local activity ranking, not exponential half-life or global consensus.

The archive magic and outer hash are checked by this service; full manifest, signature, decryption and media validation happen in ATS. The node stores encrypted packages without receiving their content keys. Public titles, summaries, tags and file sizes remain visible.

### Signed federation and replica sources

Mesh envelopes use `{payloadBytes,publicKey,signature}`. `payloadBytes` is standard padded base64 of the **exact** UTF-8 JSON bytes; `publicKey` and `signature` are standard base64 of raw 32-byte Ed25519 and 64-byte signature. Verify those original bytes before parsing; reserializing JSON is not a signature-verification procedure. A provider ID is lowercase SHA-256 of the raw key. Node keys are pinned by operators in `NODE_PEERS=[{"url":"https://peer.example","providerID":"64hex"}]`. Snapshots require a fresh timestamp and the expected signer/origin; forwarded publication descriptors retain the original node signature and exact publisher-authenticated upload request. Legacy publications without that retained request can still be listed locally but are not exported as authenticated mesh publications.

`/v1/mesh/resources` signs `{schemaVersion:1,type:"ats-mesh-catalogue-v1",providerID,issuedAt,expiresAt,items,nextCursor,rankingScope,federation}`. Timestamps are Unix seconds, and expiry is five minutes. The base resource fields remain compatible with `/v1/resources`, which returns the same page without the envelope. Federated items additionally provide `originProviderID`, `originURL`, `publisherAuthentication`, `originDescriptor`, and `replicas`. Each replica contains `{providerID,url,sourceResourceID,verifiedAt,status:"hash-verified-custody"}`. Sources are derived from configured origins and signed inventories, never arbitrary descriptor URLs. Client trust in the selected catalogue node is explicit: catalogue signatures authenticate its observations, not the honesty or physical independence of operators. Origin descriptors separately prove the publisher request and original node assignment. Download figures and Trending remain **local observed activity**; remote totals are not aggregated into an apparent network-wide statistic.

Mesh configuration: `NODE_DESIRED_REPLICAS=2`, `NODE_MESH_INTERVAL_SECONDS=60`, `NODE_REPLICA_QUOTA_BYTES=10737418240` (capped by the total quota), `NODE_PEER_STALE_SECONDS=3600`, `NODE_DRAIN=0`. Set `NODE_ALLOW_PRIVATE_PEERS=1` only for explicit development peer origins; this also permits HTTP configured development origins. Production peer requests require HTTPS, resolve DNS before each request and bind connections to the checked address; redirects and public peers resolving to private addresses are rejected. This is a permissioned peer allowlist, not permissionless Internet crawling.

The catalogue accepts at most 1,000 remote descriptors, 32 pinned peers, 100 entries per snapshot page and 1,000 descriptors per peer reconciliation. Local snapshot exports are also limited to 1,000 descriptors. Operators needing larger discovery coverage should shard catalogues rather than silently assume a complete Internet index. Reconciliation uses deterministic placement among this node and currently reachable allowlisted peers. It cannot establish separate physical storage or separate operators. Stale public metadata/replicas expire after a seven-day grace period; forwarded records preserve original signatures. Origin deletions are retained as tombstones, but cannot recall files already copied outside this mesh. Observed origin tombstones prevent later reintroduction of that version from another peer for up to 30 days, bounded by `NODE_MAX_ENTRIES`; independent copies and older caches cannot be recalled.

Replica transfer persists a reservation and `.partial` file, resumes with Range and exact ETag/content-range checks after restart, and only promotes a file after verifying its entire length, SHA-256 and archive magic. Available peer replicas provide fallback when the original publisher node is offline. Reconciliation checks online candidates and repairs eligible missing copies, subject to quotas. A draining node continues serving existing objects and refuses new uploads, new retention orders and automatic replica assignments. **Custody observations are not independent replica proofs.** There is no guarantee that all configured nodes are separate operators or have independent disks.

### Funded retention acknowledgement

A signed publisher sends `{"resourceID":"uuid","retainUntil":<Unix seconds>}` to `/v1/retention/quotes`. The node signs a quote valid for 15 minutes, with `quoteID`, publisher/provider/resource identity, archive digest and bytes, requested retention and `priceMode:"external-settlement-required"`. The duration is between one hour and 366 days. This quote does not reserve funds or itself establish payment.

After an external settlement integration confirms a funded chain order, the publisher sends `{"quoteID":"uuid","settlementReceipt":<signed envelope>}` to `/v1/retention/orders`. Only signers in `NODE_SETTLEMENT_PUBLIC_KEYS` (comma-separated raw-key SHA-256 fingerprints) are accepted; no configured signer means no receipt can be accepted. The receipt payload is:

```json
{
  "schemaVersion": 1,
  "type": "ats-retention-lease",
  "providerID": "64hex",
  "resourceID": "uuid",
  "publisherID": "64hex",
  "sha256": "64hex",
  "byteCount": 123456,
  "retainUntil": 1790000000,
  "orderID": "uuid",
  "chainId": 1337,
  "market": "0x<40hex>",
  "serviceOrderID": "0x<64hex>",
  "leaseNonce": 1,
  "issuedAt": 1789990000
}
```

The node enforces exact quote/resource binding, owner acknowledgement, receipt freshness, chain/market/service-order replay isolation, monotonically increasing lease nonces and nondecreasing renewal expiry. Identical accepted receipts are idempotent while the quote remains valid. It blocks publisher/admin deletion while any accepted lease is active; expired orders remain visible as expired. It does not delete an expired publication automatically: the lease describes the funded commitment, and ordinary best-effort retention can continue. Renewals require a fresh quote and newly funded receipt. The settlement authority is an explicit trust boundary; a node does not infer payment from a client-supplied transaction hash. No public/private visibility change or public indexing is implied by purchasing retention.
