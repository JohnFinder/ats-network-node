# Three-node mesh acceptance

Run on 2026-10-16 using Docker Engine29.8.2, Node.js24 and three isolated storage containers built from this checkout. The run used an independent `ats-mesh-verify-*` Compose project and fresh synthetic data volumes, then removed only that project's containers/volumes. It did not contact live storage, transfer real tokens, use user documents or touch other Docker projects.

Reproduce from this repository:

```sh
./scripts/verify-mesh-docker.sh
```

Requires Node.js24+ on PATH and Docker Compose. `NODE_BINARY=/absolute/path/to/node` can override the host runtime. Override `VERIFY_MESH_A_PORT`, `VERIFY_MESH_B_PORT`, `VERIFY_MESH_C_PORT` if loopback18871–18873 are occupied. `VERIFY_MESH_LOG` sets the report filename (default `/tmp/ats-mesh-verification-*.log`). `KEEP_VERIFY_CONTAINERS=1` preserves the explicitly named test project on exit; the script prints its cleanup command.

Eight checks passed:

1. Three provider identities survive recreation; pinned peers verify signed announcements.
2. A publisher's fixed upload part survives container restart and is resumed correctly.
3. A signed cross-node catalogue retains exact archive identity, publisher proof and original provider.
4. Two replicas fully match the source SHA-256; private/unlisted publications are absent from public catalogues and forwarded descriptors.
5. Stopping the original node leaves public discovery and replica range downloads available.
6. Restarting another node repairs a durable partial copy from the remaining peer while the original is offline.
7. A draining node rejects new uploads while continuing to serve retained copies.
8. A reachable node with the wrong configured provider fingerprint is rejected.

The replica-recovery check deterministically seeds a 65,536-byte durable prefix from a previously hash-verified replica while the node is stopped, sets its persisted state to `partial`, removes the final file, and restarts it. It verifies full reconstruction through peer fallback. This simulates the on-disk result of interruption without depending on timing a very fast local transfer; it does not claim the harness killed a naturally active transfer at a precise byte.

Full local output: `/tmp/ats-mesh-verification-20261016-pass.log` on the verification host. Test fixtures verify outer archive magic and transport bytes; they are not valid signed playable audiobooks. The run does not establish physical independence of storage operators, Internet reachability, mainnet safety or permanent retention.

`compose.full.yaml` is the three-node local mesh topology. It uses explicitly allowlisted HTTP service names with development-only private-peer permission. Public deployments require HTTPS origins, pinned peer identities and separate storage volumes. The chain/indexer/observer/settlement deployment is provided by `compose.services.yaml`; those services have their own manifests, keys and acceptance runner. This topology does not start or fund a real token network.
