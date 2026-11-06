# Storage protocol and configuration

This reference describes storage, publisher authentication, peer discovery and funded retention. See the [speech API](../tts/README.md#speech-api) for VoxCPM2 request bodies and API key authentication.

## Configuration

| Variable | Default | Meaning |
|---|---:|---|
| `NODE_PORT` | `8787` | Container HTTP listener |
| `NODE_DATA_DIR` | `./data` (`/data` in Docker) | Persistent private data directory |
| `NODE_PUBLIC_URL` | `http://127.0.0.1:8787` | Origin placed in returned resource URLs |
| `NODE_MAX_FILE_BYTES` | `1073741824` | Maximum publication, 1 GiB by default |
| `NODE_OWNER_QUOTA_BYTES` | `10737418240` | Published and reserved bytes per key |
| `NODE_TOTAL_QUOTA_BYTES` | `107374182400` | Published and reserved bytes across the node |
| `NODE_MAX_ENTRIES` | `50000` | Total pending and completed publication records |
| `NODE_MAX_OWNER_ENTRIES` | `1000` | Pending and completed publication records per key |
| `NODE_UPLOAD_TTL_HOURS` | `168` | Lifetime of an incomplete upload, measured from creation |
| `NODE_ADMIN_PUBLIC_KEYS` | empty | Comma-separated reviewer IDs, each SHA-256 of a raw Ed25519 public key |
| `NODE_MODERATION_CONTACT_URL` | empty | Monitored HTTPS operator contact. Required with a reviewer ID to enable public and unlisted publication |
| `NODE_PROVIDER_ADDRESS` | empty | Optional `0x` Ethereum address in evidence. Verify wallet control separately |

Each publisher can have up to 32 pending uploads. The node processes at most four part PUT requests simultaneously and allows up to 1,200 requests per minute per immediate TCP peer. Behind a reverse proxy, that peer can be the proxy itself. Apply public-facing rate limits at the edge. The node ignores arbitrary forwarded IP headers.

Titles are limited to 300 characters, summaries to 4,000, language to 64, and tags to 16 entries of up to 64 characters each. Search accepts queries up to 200 characters and page sizes from 1 to 100.

## API and authentication

Sign every mutation and every private metadata request using these headers:

```text
X-ATS-Audience: canonical NODE_PUBLIC_URL origin, without trailing slash
X-ATS-Public-Key: base64(raw 32-byte Ed25519 public key)
X-ATS-Timestamp: integer Unix seconds
X-ATS-Nonce: unique UUID
X-ATS-Signature: base64(raw 64-byte signature)
```

Construct the signature input as the exact UTF-8 bytes below. Use LF separators and omit the final newline.

```text
ATS-NODE-V1
AUDIENCE
METHOD
/pathname?query
TIMESTAMP
NONCE
lowercase-hex-sha256-of-exact-body
```

The audience must match the configured public origin, including the scheme, host and any nondefault port, with no trailing slash. This binds each request to the intended node. Use the SHA-256 of an empty body for GET requests. A publisher ID is lowercase hexadecimal SHA-256 of the raw Ed25519 public key. The node persists nonces across restarts and rejects reuse while a matching timestamp could still be accepted. Public GET endpoints accept unsigned requests.

| Method and path | Behavior |
|---|---|
| `GET /health` | Health status |
| `GET /v1/node` | Provider public identity, capabilities, limits and available disk |
| `POST /v1/uploads` | Reserve capacity and initialize upload |
| `GET /v1/uploads/:id` | Owner retrieves uploaded parts |
| `PUT /v1/uploads/:id/parts/:index` | Owner uploads exact raw part bytes |
| `POST /v1/uploads/:id/complete` | Assemble and validate the owner’s upload. Public and unlisted resources enter review with `moderationStatus` set to `pending` |
| `DELETE /v1/uploads/:id` | Owner cancels incomplete upload |
| `GET /v1/resources?q=&sort=recent&cursor=&limit=30` | Public catalog sorted by `recent`, `downloads` or `trending` |
| `GET /v1/resources/:id` | Resource metadata subject to visibility and caller access |
| `GET /v1/resources/:id/download` | Download with optional single HTTP byte range |
| `DELETE /v1/resources/:id` | Owner or configured moderator removes publication |
| `GET /v1/resources/:id/moderation` | Checks current public approval. Pass `originProviderID` as a query parameter for a federated listing |
| `POST /v1/resources/:id/reports` | Signed report with `reason`, optional `details` and optional federated `originProviderID` |
| `POST /v1/resources/:id/downloads` | Create a 24-hour download ticket bound to the requesting identity |
| `POST /v1/downloads/:ticket/complete` | Report verified full download |
| `GET /v1/resources/:id/evidence` | Signed, time-stamped node storage self-attestation |
| `GET /v1/mesh/announcement` | Signed node announcement, draining state and configured peer identities |
| `GET /v1/mesh/snapshot?cursor=0` | Signed public-only descriptors and replica inventory, 100 items/page |
| `GET /v1/mesh/resources?q=&sort=recent&cursor=0&limit=30` | Signed merged catalog, timestamps and safe fallback sources |
| `GET /v1/mesh/status` | Peer health, bounded catalog and observed replica state |
| `GET /v1/mesh/objects/:key` | Hash-verified public replica with HTTP byte ranges |
| `POST /v1/mesh/sync` | Signed configured administrator schedules a reconciliation |
| `GET /v1/stats` | Aggregate publication/replica bytes, active leases and drain state |
| `POST /v1/retention/quotes` | Publisher requests a time-limited quote for an owned resource |
| `POST /v1/retention/orders` | Publisher acknowledges a funded lease signed by a pinned settlement service |
| `GET /v1/retention/orders` | Publisher lists its own active/expired orders |

### Upload and visibility

Send JSON to `POST /v1/uploads`:

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

Set `visibility` to `public`, `unlisted` or `private`.

Public and unlisted resources enter moderation after upload. Until approval, only the owner and an administrator can access them. Only approved public resources enter the search catalog. Use a signed resource metadata request to read the review state.

A signed report accepts `objectionable`, `harassment`, `copyright`, `spam` or `other`. Include optional details of up to 2,000 characters. The response contains the report `id`. A retry by the same signer for the same resource returns the existing ID while that report remains open. For a federated resource, include its `originProviderID`. A configured node advertises `moderation: {schemaVersion: 1, contactURL}` in `/v1/node`. See the [operator review and reporting procedure](OPERATIONS.md#content-moderation).

For private resources, sign as the owner or use an owner-issued download ticket. A ticket grants temporary access to the named object to anyone who holds its URL. Keep ticket URLs private. Deletion applies to the local node and cannot recall downloaded copies or externally indexed metadata.

Upload initialization and status return `id`, `partSize`, `byteCount`, `sha256`, `expiresAt` and `parts`. Each part includes `index`, `sha256` and `byteCount`. Compare the fixed local payload hash and every reported part hash before skipping previously uploaded parts. Indices start at zero. Only the final part can be shorter than `partSize`. Replaying identical part bytes is safe, but a new hash at an occupied index is rejected. Retrying completion returns the same resource. Unfinished uploads expire at the configured lifetime.

Completed resources include `id`, `title`, `summary`, nullable `language`, `tags`, `sha256`, `byteCount`, `sources`, `encrypted`, `publisherID`, ISO 8601 `createdAt`, `downloads` and `visibility`. Public and unlisted resources also include `moderationStatus`. Catalog responses include `items` and `nextCursor`, which is null on the final page. The cursor represents an offset into the current ranking. Deduplicate IDs because concurrent publishing and downloads can reorder results. Search uses bounded SQLite substring matching with case folding for ASCII.

The node checks the archive magic and outer hash. ATS validates the full manifest, signature, decryption and media. Encrypted packages are stored without content keys. A public package still exposes its title, summary, tags and size.

### Downloads and local ranking

1. Create an observation ticket with a signed POST and an empty JSON object.
2. Fetch the full object or its ranges through the returned `downloadURL`.
3. Validate the bytes and SHA-256, then send signed JSON `{ "sha256": "..." }` to the completion endpoint.

The node requires completed response ranges covering every byte. It tracks up to 1,024 merged ranges per ticket and deduplicates completions per identity, resource and day. A counted response has the form `{ "counted": true, "downloads": 1 }`. Interrupted transfers, repeated ranges and anonymous direct GET requests cannot each add a count. Counts reflect observed deliveries to participating identities. Trending ranks this local activity over 30 days with a diminishing weight on a two-day time scale.

### Signed federation and replica sources

A mesh envelope contains `payloadBytes`, `publicKey` and `signature`. The payload is standard padded Base64 of the original UTF-8 JSON. The key and signature are standard Base64 of the raw 32-byte Ed25519 key and 64-byte signature. Verify the original payload bytes before parsing JSON. The provider ID is lowercase hexadecimal SHA-256 of the raw key. Configure pins in `NODE_PEERS=[{"url":"https://peer.example","providerID":"64hex"}]`.

Snapshots require a fresh timestamp and the expected signer and origin. Forwarded publications retain the origin node signature and the exact publisher-authenticated upload request. Legacy publications missing that request are available only in the local catalog.

`/v1/mesh/resources` signs `{schemaVersion:1,type:"ats-mesh-catalogue-v1",providerID,issuedAt,expiresAt,items,nextCursor,rankingScope,federation}`. Timestamps are Unix seconds and the signature envelope expires after five minutes. `/v1/resources` returns the same page without the envelope. Federated entries add `originProviderID`, `originURL`, `publisherAuthentication`, `originDescriptor` and `replicas`. Each replica has `{providerID,url,sourceResourceID,verifiedAt,status:"hash-verified-custody"}`.

The selected catalog node signs its observations. Origin descriptors independently authenticate the publisher request and originating node assignment. Sources come from configured origins and signed inventories. Download counts and Trending retain their local scope across federation.

| Mesh setting | Default |
| --- | --- |
| `NODE_DESIRED_REPLICAS` | `2` |
| `NODE_MESH_INTERVAL_SECONDS` | `60` |
| `NODE_REPLICA_QUOTA_BYTES` | `10737418240`, capped by the total quota |
| `NODE_PEER_STALE_SECONDS` | `3600` |
| `NODE_DRAIN` | `0` |

Use `NODE_ALLOW_PRIVATE_PEERS=1` only for explicit development origins, including allowed HTTP origins. Production peers use HTTPS. The node resolves each request destination and pins the connection to the checked address. It rejects redirects and public peers that resolve to private addresses.

The mesh supports up to 32 pinned peers, 1,000 remote descriptors, 100 entries per snapshot page and 1,000 descriptors per peer reconciliation. A local snapshot exports up to 1,000 descriptors. Shard catalogs when those limits are insufficient. Placement is deterministic across the current node and reachable allowed peers. Only the pinned origin can refresh a resource's signed approval. Entries and replica routes become unavailable after `NODE_PEER_STALE_SECONDS` without renewal. The node cleans up stale replicas after seven days. An observed origin tombstone blocks reintroduction of that version for up to 30 days, subject to `NODE_MAX_ENTRIES`.

Replica downloads persist a reservation and a `.partial` file. On restart, the node resumes with Range and exact ETag and Content-Range checks. It promotes a copy after verifying the complete length, SHA-256 and archive magic. Available replicas can serve as fallbacks when the origin is offline, and reconciliation repairs eligible copies within quota. A draining node serves existing copies while declining uploads, new retention orders and automatic placements. Verified custody describes a copy served by a pinned node. Independent hardware or operators require separate verification.

### Funded retention acknowledgement

Send signed JSON `{"resourceID":"uuid","retainUntil":<Unix seconds>}` to `/v1/retention/quotes`. Retention can run from one hour to 366 days. The node returns a signed quote valid for 15 minutes. It includes `quoteID`, the publisher, provider and resource IDs, the archive hash and size, the requested retention time and `priceMode:"external-settlement-required"`. Funding takes place separately.

After a settlement integration confirms the funded chain order, send signed JSON `{"quoteID":"uuid","settlementReceipt":<signed envelope>}` to `/v1/retention/orders`. Configure `NODE_SETTLEMENT_PUBLIC_KEYS` with comma-separated SHA-256 fingerprints of trusted raw public keys. The node rejects every receipt until an issuer is configured. The receipt payload has this form:

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

The node checks the exact quote and resource binding, owner acknowledgement, receipt freshness, replay scope across chain, market and service order, strictly increasing lease nonces and nondecreasing renewal expiry. It accepts an identical receipt idempotently while the quote remains valid. An active lease blocks publisher and administrator deletion. Expired orders stay visible and best-effort storage may continue. Renew through a fresh quote and a newly funded receipt. Settlement authorization comes from the pinned issuer. Retention preserves the existing visibility and indexing policy.
