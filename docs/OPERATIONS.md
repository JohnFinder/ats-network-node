# Operating an ATS network

The storage node has no required ATS-owned backend. Operators supply disk/network service; publishers and sponsors fund explicit orders. A public Git repository does not supply public infrastructure. Start with bounded quotas and test currency. Never expose the local development RPC or deterministic development wallets.

## Deployment choices

- `compose.yaml`: one persistent storage node on host loopback.
- `compose.full.yaml`: isolated three-node mesh demonstration. Read its comments: development HTTP and generated pins are unsuitable as a public deployment unchanged.
- `compose.services.yaml`: independently persisted EVM indexer/observer/coordinator services; read `services/README.md` for required manifest, pinned origins and Docker secrets.
- `compose.public.yaml`: HTTPS/Caddy example; configure DNS and an actual domain. Enable the services overlay before proxying `/v2` and `/wallet` to it.
- `storage/`: optional mature Filecoin PDP adapter. It is not a free storage account and never invents funding or storage proofs.

Use one process per writable volume. Keep storage, indexer, observer and coordinator identities separate. Operators in different failure domains are an operational requirement: three containers on one laptop demonstrate software behavior, not three independent operators.

## Joining a mesh

Bring up each node once with an empty peer list, obtain `/v1/node`, and verify its provider fingerprint out of band. Persist its data volume. Configure `NODE_PEERS` as a JSON list of `{ "url": "https://peer.example", "providerID": "64-lowercase-hex" }`; do not trust unsigned arbitrary discovery advertisements. Restart with the pinned peers. HTTPS is required publicly. `NODE_ALLOW_PRIVATE_PEERS=1` exists only for isolated development fixtures.

Set desired placement, replica quota and total quota explicitly. A peer advertises signed snapshots of public publications with the original upload signature. Federation exports neither private nor link-only records. Encrypted **public** publications reveal their outer public descriptions, sizes, ciphertext hashes and publisher identity; decryption keys are never federated. Local deletion/tombstones do not erase independently retained copies or chain history.

Watch `/health`, `/v1/stats`, `/v1/mesh/status` and service `/v2/network`. Alert on stale synchronization, offline peers, failed copies, replica quota exhaustion, indexing lag, code-hash mismatch, gas exhaustion and settlement retries. Keep host time synchronized. Logs intentionally exclude signing keys; reverse proxies should exclude ticket query strings and bodies. Configure request limits and abuse admission at the public edge.

## Chain and spending

Deploy the V2 contracts using an explicit reviewed chain/RPC and a deployer secret injected through `ATS_DEPLOYER_PRIVATE_KEY` by the operator secret manager. Observer/coordinator keys use separate mounted secret files. The deployment manifest pins chain ID, addresses, deployment height and runtime bytecode; indexers refuse mismatches. Each observer has an independently controlled, funded wallet, a separate volume and a configured committee role. A local threshold committee remains a trust model, not consensus about physical replicas. Providers cannot act as their own observer.

The ATS wallet portal supports explicit user authorization. Device Ed25519 proof and EVM typed signature must agree, and confirmed contract state is checked. Binding/publication does not approve token spending. Storage, staking and funded rewards require separate explicit wallet transactions. Quotes have chain/market/nonce/expiry scope; retain copies of the accepted terms. No download count mints tokens. No token exchange value is promised.

Paid retention receipts are scoped to the chain, market, order, provider, publication, archive hash, bytes and expiry. Configure only settlement issuer fingerprints you actually trust. A receipt authorizes retention; it does not prove that storage happened. Independent retrieval observations and the established PDP layer serve different purposes. Node operators should reconcile expiry, renewal and cancellation, and retain incident evidence for disputes.

## Backup and restore

Volumes contain private identity material and user content. Encrypt backups and keep decryption credentials separately. Stop all processes using a volume before copying it, including SQLite WAL state. The supplied scripts refuse a running source/target volume and refuse a nonempty restore destination.

```sh
# Stop the relevant node first; substitute its actual volume name.
docker compose stop node
./scripts/volume-backup.sh myproject_node-data /secure/ats-backup.tar.gz.age --recipient age1YOUR_RECIPIENT
docker compose up -d node

# Restore to a newly created empty volume, never over live state.
docker volume create myproject_restored
./scripts/volume-restore.sh myproject_restored /secure/ats-backup.tar.gz.age --identity /secure/age-identity
```

`age` must be installed on the operator host. `--plaintext-development` is provided only for synthetic local acceptance. A failed restore can leave partial data; discard that new failed destination and retry into another empty volume. Restore only trusted backups. After restore, verify provider/service fingerprint, catalogue membership, full archive hashes and canonical chain height before returning to service. Do not run both restored and original nodes with the same identity concurrently. Test recovery regularly; keep off-host backups and account for data lost since the last snapshot.

## Exit and incident response

Set `NODE_DRAIN=1` before planned exit: keep serving existing objects, stop accepting new uploads/placements, let peers repair and arrange paid obligations with sponsors. Confirm replacement copies through independent retrieval before shutting down. Drain cannot guarantee replacement when all peers are offline or full. Rotate compromised committee/issuer roles through reviewed administration; preserve the original signed incident records. Restoring an old database must not re-enable revoked keys or replace current chain facts.

Public production launch still requires funded hosts/domains, independent operators, independent contract/economic review, a selected public chain and operational monitoring. Storefront and regional token/content policy review belongs to deployment planning. Local acceptance is not evidence of these external conditions.

### Bind the operator wallet without copying the node key

After verifying the services fingerprint from `/v2/network`, run inside the node:

```sh
docker compose exec node node src/bind-wallet.mjs --services https://your-node.example --wallet 0xYOUR_PROVIDER_WALLET --service-id VERIFIED_64_HEX_SERVICE_ID
```

The CLI signs the exact domain-scoped statement with the persistent node Ed25519 identity in place, creates a short-lived intent and prints its wallet URL. Open that link in the external wallet browser, check the chain/registry/provider fingerprint and approve the binding transaction. No private key is printed or sent to the service. Confirm `edProofVerified` before opening paid orders. The explicit `--development-http` option exists only for isolated Docker acceptance.
