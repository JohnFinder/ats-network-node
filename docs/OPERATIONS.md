# Operating an ATS network

Storage operators provide disk space and network capacity on their own infrastructure. Publishers and sponsors fund explicit orders. For development, configure bounded quotas and test currency, and keep the development RPC and deterministic wallets off the public Internet.

## Deployment choices

| Compose file or component | Use |
| --- | --- |
| `compose.yaml` | One persistent storage node bound to host loopback |
| `compose.gpu.yaml` | Authenticated speech gateway and private NVIDIA VoxCPM2 engine. Capacity is configurable from 1 to 128, with a default of 8. See the [GPU guide](../tts/README.md) |
| `compose.full.yaml` | Isolated three-node development mesh with development HTTP and generated peer pins |
| `compose.services.yaml` | Separately persisted EVM indexer, observer and coordinator. See the [service guide](../services/README.md) for manifests, pins and secrets |
| `compose.public.yaml` | Caddy HTTPS edge for a real DNS name. Start the optional services before routing `/v2` and `/wallet` to them |
| `compose.gpu-public.yaml` | Public speech routes, used with the base, GPU and HTTPS overlays |
| `storage/` | Optional [Filecoin PDP adapter](../storage/README.md) with separate funding and storage commitments |

Give each writable volume one owner process, and keep storage, indexer, observer and coordinator identities separate. For redundancy, place nodes in independently operated failure domains.

Preserve the existing Compose project name, credentials, engine tuning and volumes when upgrading. See [deployment, upgrade and recovery](DEPLOYMENT.md). Deployments are initiated by operators, and GitHub acceptance runs on manual dispatch.

## Joining a mesh

1. Start each node with an empty peer list and a persistent data volume. Retrieve its provider fingerprint from `/v1/node` and verify it out of band.
2. Set `NODE_PEERS` to a JSON list of pinned origins and fingerprints, for example `[{ "url": "https://peer.example", "providerID": "64-lowercase-hex" }]`. Restart with the new configuration. Public peers use HTTPS. Reserve `NODE_ALLOW_PRIVATE_PEERS=1` for isolated development.
3. Set the desired replica count, replica quota and total quota. A peer exports signed snapshots of public publications with the original publisher request signature. Public descriptions, ciphertext sizes and hashes, and publishing identities remain visible for encrypted public packages. Private and unlisted records and decryption keys stay outside federation.

Monitor `/health`, `/v1/stats`, `/v1/mesh/status` and the service's `/v2/network` endpoint. Alert on stale synchronization, offline peers, failed copies, exhausted replica quotas, indexing lag, code hash mismatches, depleted gas and settlement retries. Synchronize host clocks. Configure request limits and abuse controls at the public edge, and redact ticket query strings and request bodies from proxy logs.

## Chain and spending

Use a reviewed chain and RPC for V2 deployments. Inject the deployer secret through `ATS_DEPLOYER_PRIVATE_KEY` using the operator's secret manager. Mount separate keys for observers and coordinators. Indexers verify the chain ID, addresses, deployment height and runtime bytecode against the manifest. Give each observer an independently controlled funded wallet, separate volume and configured committee role. Providers cannot act as their own observers. Committee members remain trusted to report their observations accurately.

The ATS wallet portal checks the domain-scoped Ed25519 proof, EVM typed signature and confirmed contract state. Wallet binding and publication are separate from authorization to spend tokens. Storage, staking and funded rewards each require explicit wallet transactions. Keep the accepted terms of quotes, which are scoped to a chain, market, nonce and expiry. Download counters are local observations and carry no spending or minting authority.

Configure only settlement issuer fingerprints you trust. A paid retention receipt binds the chain, market, order, provider, publication, archive hash, byte count and expiry. The receipt authorizes a retention commitment. Verify service separately with independent retrieval observations or a storage proof system. Reconcile expiry, renewal and cancellation, and retain evidence for disputes.

## Backup and restore

Encrypt backups of data volumes, which include private identities and user content. Keep decryption credentials separately. Stop every process using the volume before copying, including its SQLite WAL state. The scripts refuse volumes in use and refuse to restore into a nonempty destination. Install `age` on the operator host.

```sh
# Substitute the running deployment's actual node volume.
docker compose stop node
./scripts/volume-backup.sh myproject_node-data /secure/ats-backup.tar.gz.age --recipient age1YOUR_RECIPIENT
docker compose up -d node

# Restore to a new empty volume.
docker volume create myproject_restored
./scripts/volume-restore.sh myproject_restored /secure/ats-backup.tar.gz.age --identity /secure/age-identity
```

Use `--plaintext-development` only with synthetic acceptance fixtures. Restore trusted backups and use a new empty volume after a failed partial restore. Before putting a restored service online, confirm its identity fingerprint, catalog membership, complete archive hashes and canonical chain height as applicable. Shut down the original instance before starting another copy with the same identity. Keep off-host backups, verify recovery and account for writes since the last snapshot.

## Exit and incident response

For a planned exit, set `NODE_DRAIN=1` to keep serving existing copies while refusing new uploads and placements. Coordinate paid obligations with sponsors, let peers repair, and retrieve replacement copies independently before shutting down. Check that reachable peers have space to accept the copies.

Rotate compromised committee or issuer roles through the reviewed administrative procedure. Preserve signed incident records. When restoring older state, reconcile revoked keys and current canonical chain state before restarting service. A deletion or tombstone applies within the participating service and cannot erase previously retained copies or chain history.

Production launch requires funded hosts and domains, independent operators, contract and economic review, a selected public chain and operating monitors. Account for storefront rules and regional token and content requirements in the deployment plan.

### Bind the operator wallet without copying the node key

Verify the service fingerprint from `/v2/network`, then run the binding tool inside the node:

```sh
docker compose exec node node src/bind-wallet.mjs --services https://your-node.example --wallet 0xYOUR_PROVIDER_WALLET --service-id VERIFIED_64_HEX_SERVICE_ID
```

The tool uses the persistent Ed25519 identity in place to sign the domain-scoped statement and produce a short-lived intent. Open the printed URL in the external wallet browser, check the chain, registry and provider fingerprint, and approve the binding transaction. Confirm `edProofVerified` before opening paid orders. Use `--development-http` only with isolated Docker acceptance.
