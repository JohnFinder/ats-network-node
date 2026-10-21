# ATS Network Node

Independent storage, signed discovery and optional NVIDIA speech synthesis for ATS `.atsbook` audiobooks. Operators choose their own capacity, peers, credentials and infrastructure.

[繁體中文](README.zh-Hant.md) · [Deployment and upgrades](docs/DEPLOYMENT.md) · [GPU / VoxCPM2 guide](tts/README.zh-Hant.md) · [Apache-2.0](LICENSE)

This repository contains the **node services only**. The ATS Apple application, user libraries, private configuration, Docker images and model weights are not included.

## Capabilities

- Resumable 8 MiB upload parts, restart recovery, exact size and SHA-256 verification.
- Public, unlisted and private publications; Ed25519 authentication and persisted replay protection.
- Search, byte-range downloads, bounded quotas and persistent node signing identity.
- Signed peer catalogues, pinned identities, public-only replicas, source failover, repair and draining.
- Optional VoxCPM2 synthesis and reference-audio voice cloning through an authenticated OpenAI-compatible speech endpoint.
- Configurable speech admission and engine sequence capacity from **1 to 128**, defaulting to **8**.
- Optional EVM identity/publication/storage/task/reward contracts, independent operator services and a Filecoin adapter.

Storage integrity checks establish received bytes, not content ownership. Node statements and retrieval observations do not establish independent physical replicas. Download counts do not mint tokens; optional paid services require separately configured funding and infrastructure.

## Choose a deployment

| Deployment | Configuration | Requirements |
| --- | --- | --- |
| Storage and discovery | `compose.yaml` | Docker with Compose V2 and persistent disk |
| Storage plus speech | Add `compose.gpu.yaml` | Linux x86_64, compatible NVIDIA GPU/driver and Container Toolkit |
| Public storage HTTPS | Add `compose.public.yaml` | Domain, DNS and reachable ports 80/443 |
| Public storage and speech HTTPS | Add both public overlays, including `compose.gpu-public.yaml` | GPU requirements plus HTTPS |
| Chain/operator services | `compose.services.yaml` and reviewed configuration | Explicit RPC, chain manifest, separate credentials and funding |

The storage listener is `127.0.0.1:8787`; the speech gateway is `127.0.0.1:8791`. The GPU inference engine has no published host port. Run only one writer per data volume.

## Quick start: storage

```sh
git clone https://github.com/JohnFinder/ats-network-node.git
cd ats-network-node
cp .env.example .env
docker compose up -d --build
```

These commands are for a new deployment. Existing operators should follow the [upgrade procedure](docs/DEPLOYMENT.md#upgrading-an-existing-node), retaining their original `.env`, credentials, Compose project name and volumes.

`GET /health` reports process health; `GET /v1/node` publishes the node identity and capabilities. Files and SQLite state persist in `node-data`. Removing that volume removes the node identity and publications.

## Quick start: NVIDIA speech node

From the repository root on the target Linux NVIDIA host, configure `.env`, then use:

```sh
sh scripts/start-gpu-node.sh
```

For public HTTPS, configure `NODE_DOMAIN` and DNS first, then use `sh scripts/start-gpu-node.sh --public`. The script creates private `secrets/tts_api_key` when missing and preserves an existing key. It builds and starts storage, the gateway and the private inference engine.

Speech requests use `Authorization: Bearer <API key>`. `GET /v1/models` checks engine readiness; `POST /v1/audio/speech` returns a WAV. See the [endpoint contract and GPU prerequisites](tts/README.zh-Hant.md) for request fields, pinned versions and credentials.

### Speech concurrency

Set deployment capacity in `.env`:

```dotenv
TTS_MAX_CONCURRENT=8
```

Values **1–128** configure gateway admission, engine `max_num_seqs` and unified decode graph batch capacity together. A nonempty environment override takes precedence over engine YAML. `TTS_CUDA_GRAPH_MAX_BATCH_SIZE` can select a smaller graph capacity. YAML-only engine configuration is also supported; see the [parameter precedence examples](tts/README.zh-Hant.md#部署並發參數).

At capacity the gateway returns `429` with `Retry-After: 2`. Additional HTTP connection capacity leaves room for probes and busy responses. Gateway RAM and CPU limits are configurable with `TTS_GATEWAY_MEMORY_LIMIT` and `TTS_GATEWAY_CPUS`.

**128 is a configurable software capacity, not a measured hardware guarantee.** The supplied KV budget remains 6 GiB; CFM, AudioVAE and graph allocations also need GPU memory. Configure memory and context limits for your workload, leaving capacity for other services. No 128-way GPU performance result is claimed.

## Repository map

| Path | Contents |
| --- | --- |
| `src/` | Storage API, signed mesh and wallet binding CLI |
| `tts/` | Speech gateway, pinned GPU image, YAML and deployment entrypoint |
| `contracts/` | EVM contracts, deployment tooling and local development chain |
| `services/` | Indexer, observer, settlement integration and wallet portal |
| `storage/` | Optional Filecoin Synapse adapter |
| `scripts/` | Deployment, backup/restore and explicitly invoked acceptance tools |
| `docs/` | Protocol, deployment, operations, trust boundaries and validation records |

## Documentation

- [繁體中文快速入門](docs/QUICKSTART.zh-Hant.md)
- [Deployment, upgrades, rollback and troubleshooting](docs/DEPLOYMENT.md)
- [VoxCPM2 GPU deployment and speech protocol](tts/README.zh-Hant.md)
- [Storage configuration, authenticated API and mesh protocol](docs/PROTOCOL.md)
- [Operations, backup/restore and node exit](docs/OPERATIONS.md)
- [Contracts](contracts/README.md), [operator services](services/README.md) and [Filecoin adapter](storage/README.md)
- [Threat model](docs/THREAT-MODEL.md), [delivery status](docs/PLAN.md) and [validation record](docs/VALIDATION.md)
- [Change log](CHANGELOG.md), [contributing](CONTRIBUTING.md), [security reporting](SECURITY.md) and [third-party components](THIRD_PARTY_NOTICES.md)

GitHub acceptance jobs are **manual only**. Publishing code does not run builds or tests. Historical records identify their scope; they do not establish that a later commit passed or that a public node is deployed. GPU performance experiments require an explicit operator invocation.

## License

Project-owned code and documentation are licensed under the **Apache License, Version 2.0**. See [LICENSE](LICENSE) and [NOTICE](NOTICE). Dependencies, images and model weights retain their respective upstream licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
