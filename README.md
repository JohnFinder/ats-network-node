# ATS Network Node

A Docker-deployable storage and discovery node for ATS portable `.atsbook` audiobooks. It uses Node.js 24, SQLite and the filesystem, with no third-party runtime packages. Each node stores its own catalogue; this release does not automatically federate catalogues or replicate content between nodes.

Features implemented:

- Ed25519 publisher authentication with persisted replay protection.
- Fixed 8 MiB resumable upload parts, persisted across container restarts.
- Final exact-length and SHA-256 verification, plus `ATSBOOK1` format magic.
- Automatic indexing of completed **public** publications, search and pagination.
- Recent, observed-download and recent-activity ranking.
- Byte-range downloads and explicit, identity-deduplicated completion observations.
- Persistent node signing identity and signed storage self-attestations.
- Publisher/admin deletion, configurable quotas and expired-upload cleanup.

This node does **not** mint tokens. The contracts directory provides a separate, explicitly attested escrow/reward foundation. A signed node statement is not proof of independent replicas or a guarantee of future availability. A verifier must actually retrieve and hash the object before accepting a storage/service claim.

## Deploy locally

Install Docker with Compose support, then:

```sh
cp .env.example .env
docker compose up --build -d
docker compose logs --tail=30
curl http://127.0.0.1:8787/health
```

The default port binds only to the host loopback interface. The `node-data` named volume contains all publications, SQLite state and the private provider identity. Restarting or recreating the container preserves it. **Do not run two replicas against the same volume.** `docker compose down -v` destroys the data and identity.

The container runs as an unprivileged user with a read-only application filesystem, dropped Linux capabilities and explicit resource limits. Reserve disk space for both retained parts and the final assembled file; the service preflights temporary space and reports insufficient storage instead of publishing incomplete files.

## Publish an Internet endpoint

1. Obtain a domain and install a TLS reverse proxy on the same host.
2. Set `NODE_PUBLIC_URL=https://your-node.example` in `.env`.
3. Proxy HTTPS to `127.0.0.1:8787`. Permit PUT bodies of at least 8 MiB, preserve the request path/query and `X-ATS-*` headers, disable response caching on ticket URLs, and set suitable request/rate limits.
4. Restart the service using `docker compose up -d`.
5. Check `https://your-node.example/v1/node` before adding that endpoint to a client.

The service rejects a non-HTTPS public origin except HTTP loopback for development. TLS termination and domain provisioning are deployment responsibilities. The host clock must remain synchronized; authenticated requests allow five minutes of clock skew.

Ordinary clients need no storage account or service secret. Their locally generated Ed25519 key identifies a pseudonymous publisher. That also means a malicious client can generate many identities: per-owner quotas are **not** a Sybil-resistant admission system. An open node operator accepts the storage/bandwidth cost and should configure proxy-level abuse controls, monitoring and moderation. No unlimited or permanent free storage is promised.

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

## Operations and recovery

Back up the complete data volume while the node is stopped, or use SQLite's supported backup tooling together with a consistent object snapshot. Protect the provider private key; restoring a different key changes the node identity. Do not commit `.env`, data, wallets, credential files or private keys. Audit attestations and download events are retained for up to 90 days; attestations are additionally bounded to ten times `NODE_MAX_ENTRIES`, evicting oldest entries when full, and cached for 60 seconds per resource. External verifiers should retain the evidence they use for settlement. Completed download totals remain in each resource. Expired tickets and nonces are cleaned automatically. A self-attestation includes the original JSON bytes, hash and signature for external verification.

This first release is a single-node foundation: no automatic chain transactions, settlement authority, independent replica proofs, pinning guarantees, token market, Internet bootstrap service, or federation is bundled. The protocol and deployment are intended to remain publicly reproducible and replaceable.

## Full plan and local chain

- [Detailed delivery and incentive plan](docs/PLAN.md)
- [Threat model and remaining trust](docs/THREAT-MODEL.md)
- [繁體中文部署指南](docs/QUICKSTART.zh-Hant.md)
- [Contracts and local-only token settlement](contracts/README.md)
- [Verification record](docs/VALIDATION.md)

The optional `compose.public.yaml` overlay configures Caddy HTTPS using `NODE_DOMAIN`. It requires real DNS and public ports80/443. The default deployment remains local. The optional `compose.chain.yaml` overlay provides a local chain1337 on loopback18545 and a verification runner. It uses known development accounts and has no real currency. Use the Chinese guide or contract README for the full sequence; do not expose the development RPC to the Internet.

## License

MIT; see `LICENSE` in this repository.

## One-command isolated acceptance

With Docker/Compose and Node.js24+ installed:

```sh
./scripts/verify-docker.sh
```

This builds the storage and local-chain containers, uploads a synthetic multi-part fixture, restarts storage, resumes, checks public/private access and download statistics, then verifies the node evidence and settles local test-token services/bounties/rewards. It defaults to loopback ports18788 and18546; override `VERIFY_NODE_PORT`/`VERIFY_CHAIN_PORT` if occupied. It creates its own project and removes only its own containers/volumes on exit. `KEEP_VERIFY_CONTAINERS=1` preserves that test project and reports the private fixture directory for debugging. Synthetic payloads exercise byte transfer and outer magic; they are not valid signed audio books and do not establish ATS media-playback acceptance.
