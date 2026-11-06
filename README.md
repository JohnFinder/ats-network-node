# ATS Network Node

Run an independent node to store ATS `.atsbook` audiobooks, publish signed listings and discover books across trusted peers. A Linux host with an NVIDIA GPU can also provide VoxCPM2 speech synthesis and reference voice cloning. Operators configure capacity, peers, credentials and hosting. The ATS Apple app is distributed separately.

## Choose a deployment

| Goal | Compose files or entry point | Requirements |
| --- | --- | --- |
| Local storage and discovery | `compose.yaml` | Docker with Compose V2 and persistent disk |
| Public storage over HTTPS | `compose.yaml` and `compose.public.yaml` | A domain, DNS and reachable ports 80 and 443 |
| Storage and speech | `sh scripts/start-gpu-node.sh` | Linux x86_64, an NVIDIA GPU, a compatible driver and NVIDIA Container Toolkit |
| Public storage and speech over HTTPS | `sh scripts/start-gpu-node.sh --public` | GPU and public HTTPS requirements |
| Document translation | `sh scripts/start-translation-node.sh` | A reachable compatible upstream, or the optional Linux NVIDIA backend |
| Music generation | `node music/server.mjs` | Node.js 24 and a configured Stable Audio or MiniMax Music 3 worker |
| Voice Market test environment | `docker compose -f compose.voice-market.yaml up -d --build` | Reviewer configuration and opt-in sandbox credits or Base Sepolia |
| Optional chain and operator services | `compose.services.yaml` | A reviewed chain manifest, explicit RPC, separate credentials and funding |

## Start a storage node

For a new standalone deployment, clone the public repository and create its local configuration.

```sh
git clone https://github.com/JohnFinder/ats-network-node.git
cd ats-network-node
cp .env.example .env
docker compose up -d --build
```

The default listener is `http://127.0.0.1:8787`. Check `GET /health` for process health and `GET /v1/node` for the node's identity and capabilities. The `node-data` volume stores files, SQLite state and the node signing identity. Use a single writer per volume and preserve the volume when replacing containers.

For an existing deployment, retain the original `.env`, credentials, Compose project name and volumes. Follow the documented backup and upgrade sequence. [Deployment and upgrades](docs/DEPLOYMENT.md#upgrading-an-existing-node)

Uploads resume in 8 MiB parts across restarts. The node checks the exact size and SHA-256 digest before accepting an archive. It supports public, unlisted and private visibility, authenticates publishers with Ed25519 and persists replay protection. Search, byte-range downloads and storage quotas are built in. Nodes can exchange signed catalogs with peers whose identities they have pinned. Federation supports public replicas, source failover, repair and draining.

Public and unlisted uploads require a configured reviewer and a monitored HTTPS contact. After upload, they stay in the review queue until an independent reviewer approves them. [Moderation and reporting](docs/OPERATIONS.md#content-moderation)

Digests verify archive bytes. Operators must establish publication rights separately. Signed node statements and retrieval observations cannot establish that replicas occupy separate physical failure domains. Download counts do not mint tokens. The optional EVM contracts, operator services and Filecoin adapter have their own configuration and funding requirements.

## Add NVIDIA speech synthesis

From the repository root on the target host, prepare the GPU runtime and configure `.env`. Run the startup helper.

```sh
sh scripts/start-gpu-node.sh
```

For public HTTPS, configure `NODE_DOMAIN` and DNS, open ports 80 and 443, then use `sh scripts/start-gpu-node.sh --public`. The helper creates `secrets/tts_api_key` if needed and preserves an existing key. The speech gateway binds to `127.0.0.1:8791` by default. The inference engine stays on the private container network.

Send `Authorization: Bearer <API key>` with speech requests. Use `GET /v1/models` to check readiness. `POST /v1/audio/speech` returns WAV or AAC audio. [GPU prerequisites and speech API](tts/README.md)

### Speech concurrency

Set `TTS_MAX_CONCURRENT` in `.env` to a value from **1 to 128**. The default is **8**. The setting configures gateway admission, engine `max_num_seqs` and unified decode graph batch capacity together. A nonempty environment override takes precedence over the engine YAML. Use `TTS_CUDA_GRAPH_MAX_BATCH_SIZE` to set a smaller graph limit. [Parameter precedence and examples](tts/README.md#deployment-concurrency)

At capacity the gateway returns `429` with `Retry-After: 2`. It leaves HTTP connection headroom for probes and busy responses. Use `TTS_GATEWAY_MEMORY_LIMIT` and `TTS_GATEWAY_CPUS` to set the gateway's container limits.

The software accepts 128 concurrent requests as a configuration value. This limit has no measured throughput or latency guarantee. The supplied KV cache budget is 6 GiB. CFM, AudioVAE, CUDA graphs and other services consume additional GPU memory. Size memory and context limits for the target hardware and workload.

## Repository map

| Path | Contents |
| --- | --- |
| `src/` | Storage API, signed mesh and wallet binding CLI |
| `tts/` | Speech gateway, pinned GPU image, engine YAML and startup helper |
| `translation/` | Authenticated translation gateway and upstream integration |
| `music/` | Music job API and Python workers for Stable Audio and MiniMax Music 3 |
| `voice-market/` | Isolated personal voice license test service |
| `contracts/` | EVM contracts, deployment tooling and local chain |
| `services/` | Indexer, observer, settlement integration and wallet portal |
| `storage/` | Optional Filecoin Synapse adapter |
| `scripts/` | Deployment, backup, recovery and acceptance tools |
| `docs/` | Operator guides, protocol, threat model and verification records |

## Documentation

| Topic | Guide |
| --- | --- |
| First deployment | [Quickstart](docs/QUICKSTART.md) |
| Upgrades, rollback and troubleshooting | [Deployment](docs/DEPLOYMENT.md) |
| Backup, recovery, draining and settlement | [Operations](docs/OPERATIONS.md) |
| Storage, authentication and peer exchange | [Protocol](docs/PROTOCOL.md) |
| GPU prerequisites and API | [Speech deployment](tts/README.md) |
| Optional funded services | [Contracts](contracts/README.md), [operator services](services/README.md), [Filecoin adapter](storage/README.md) |
| Trust and release readiness | [Threat model](docs/THREAT-MODEL.md), [delivery status](docs/PLAN.md) |
| Historical verification | [Node](docs/VALIDATION.md), [mesh](docs/MESH-VALIDATION.md), [GPU](tts/VALIDATION.md) |
| Project maintenance | [Change log](CHANGELOG.md), [contributing](CONTRIBUTING.md), [security reporting](SECURITY.md) |

GitHub acceptance runs by manual workflow dispatch. Run builds, acceptance scripts and GPU experiments only when explicitly requested. Each validation record applies to the revision, workload and environment it identifies.

## Optional services

- The translation gateway connects to an operator-configured upstream or a private NVIDIA backend. Start it on loopback, advertise it over a trusted LAN or publish it over HTTPS. [Document translation](translation/README.md)
- The music API runs as a separate Node.js process with a Python worker for each model you enable. Use its own HTTPS origin and ports when sharing a host. [Music generation](music/README.md)
- Voice Market uses a separate data volume and issuer key. Enable sandbox credits or configure Base Sepolia (chain ID 84532) for test transactions. [Voice Market deployment](voice-market/README.md)

## License

Project-owned code and documentation are available under the Apache License, Version 2.0. Dependencies, images and model weights retain their upstream terms. [License](LICENSE) · [Notice](NOTICE) · [Third-party components](THIRD_PARTY_NOTICES.md)
