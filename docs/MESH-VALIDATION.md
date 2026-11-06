# Three-node mesh acceptance

The 2026-10-16 acceptance run used Docker Engine 29.8.2, Node.js 24 and three isolated storage containers built from the checkout at the time. It created a fresh `ats-mesh-verify-*` Compose project with synthetic volumes and cleaned up only that project's containers and volumes.

To reproduce on request from the repository root, install Node.js 24 or newer and Docker Compose, then run:

```sh
./scripts/verify-mesh-docker.sh
```

Set `NODE_BINARY=/absolute/path/to/node` to select a host runtime. Override `VERIFY_MESH_A_PORT`, `VERIFY_MESH_B_PORT` or `VERIFY_MESH_C_PORT` if loopback ports 18871–18873 are occupied. `VERIFY_MESH_LOG` sets the report filename and defaults to `/tmp/ats-mesh-verification-*.log`. Use `KEEP_VERIFY_CONTAINERS=1` to retain the named test project on exit. The script prints its cleanup command.

## Recorded results

1. Three provider identities survived recreation. Pinned peers verified their signed announcements.
2. The first fixed upload part survived a restart and the publisher resumed the upload.
3. A signed cross-node catalog retained the exact archive identity, publisher proof and origin provider.
4. Two replicas matched the source SHA-256. Public catalogs and forwarded descriptors excluded private and unlisted publications.
5. Public discovery and replica range downloads continued after the origin stopped.
6. Another node recovered a persistent partial copy from the remaining peer while the origin stayed offline.
7. A draining node rejected new uploads and continued serving retained copies.
8. A node reachable at the expected URL was rejected when its provider fingerprint differed from the configured pin.

For check 6, the runner seeded a 65,536-byte prefix from a previously verified replica while its node was stopped. It set the persisted state to `partial`, removed the finished copy and restarted the node. Full reconstruction through peer fallback demonstrates recovery from the resulting on-disk state. The run did not depend on interrupting a live transfer at a particular byte.

The verification host retained the full output at `/tmp/ats-mesh-verification-20261016-pass.log`. The fixtures exercise archive magic and transport integrity. Valid signed playable archives, live storage, user documents, real tokens, Internet reachability, independent storage operators, mainnet safety and permanent retention are outside this record.

## Development topology

`compose.full.yaml` defines the local three-node topology. It allows explicitly configured HTTP service names and private addresses for development. For a public mesh, use HTTPS origins, pinned identities and separate storage volumes. Use `compose.services.yaml` for the separate chain, indexer, observer and settlement deployment and its own manifests, keys and acceptance runner.
