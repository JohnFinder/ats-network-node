# Deployment, upgrade and recovery

Run the deployment commands from the root of the standalone `ats-network-node` repository or the extracted source package. For a first installation, follow the [quickstart](QUICKSTART.md) or the [GPU guide](../tts/README.md).

## Deployment inputs

| Input | What it controls |
| --- | --- |
| `.env` | Public origins, quotas, peer pins, concurrency and resource limits |
| `secrets/tts_api_key` and `secrets/translation_api_key` | Existing gateway credentials |
| Voice Market data volume | Market database and persistent `issuer.der` |
| Music data directory | Private job database and generated audio |
| `tts/voxcpm2.yaml` | Engine context, KV cache budget, device and runtime settings |
| Compose project name and overlay list | Selection of containers, networks and persistent volumes |
| Data volumes | Storage identity, SQLite state, publications and optional service identities |
| `tts-model-cache` | GPU model and compilation cache |

Keep deployment credentials outside Git. When updating an existing node, merge new settings into its `.env`. Stop every process that writes to a volume before taking a filesystem backup. Follow the [encrypted backup procedure](OPERATIONS.md#backup-and-restore).

## Upgrading an existing node

1. Record the source revision, image references, Compose project name, overlay list, data volume names and custom engine settings. Keep the previous images and a consistent encrypted backup.
2. Fetch the new source into a separate checkout or staging directory. Review the change log and compare the example environment, Compose files and engine YAML against your deployment. Merge any new settings while preserving credentials and hardware tuning.
3. For GPU deployments, choose `TTS_MAX_CONCURRENT` between 1 and 128. The default is 8. A nonempty override changes gateway admission, engine sequence capacity and decode graph batch capacity together. Set a separate graph override to reduce only graph capacity. See [deployment concurrency](../tts/README.md#deployment-concurrency).
4. Rebuild and recreate the affected containers with the same Compose project name and complete overlay list. Use `sh scripts/start-gpu-node.sh` for the standard GPU stack, with `--public` for a public deployment. For a customized stack, retain the original Compose invocation and custom overlays. When switching checkout directories, set the existing project name explicitly so Compose selects the original volumes.
5. Check container health and logs. Gateway logs show `max_concurrent`. Engine logs show `max_num_seqs` and `decode_graph_max_batch_size`. Storage `/health` checks the storage process. Use the authenticated `/v1/models` route to check engine readiness, then send a synthetic speech request if synthesis acceptance was requested.

Existing public and unlisted book listings and existing voice packages enter moderation on upgrade. Configure reviewer fingerprints and the monitored HTTPS contact before rolling out the change, and plan time for reviewers to approve existing content. Private book transfers retain their existing access controls. [Moderation and reporting](OPERATIONS.md#content-moderation)

Recreating the engine interrupts requests in progress. Coordinate the maintenance window with clients and preserve the API key their configurations already use.

## Capacity and overload

The maximum configured capacity is 128 sequences. Actual throughput and the number of long requests the GPU can serve depend on the workload and the hardware. The supplied YAML allocates 6 GiB for KV cache independently of the sequence count. Budget memory for model weights, CFM, AudioVAE, graph pools and other GPU processes. Tune `max_model_len`, `max_num_batched_tokens` and the KV budget on the target host.

Set `TTS_CUDA_GRAPH_MAX_BATCH_SIZE` to reduce the decode graph budget while keeping the gateway's admission limit. The engine allocates other model memory separately. Set gateway memory and CPU limits independently, accounting for simultaneous reference WAV uploads and JSON processing.

At capacity, the gateway returns HTTP 429 with `Retry-After: 2`. Clients should honor that delay and limit their own concurrency. Server settings control admission regardless of the capacity set in ATS.

`TTS_TIMEOUT_SECONDS` defaults to 180 and accepts 5–600. If you increase it for a public node, review the 190-second response header timeout in `Caddyfile.gpu` and any external proxy and client deadlines.

## Troubleshooting

| Symptom | What to check |
| --- | --- |
| HTTP 401 | Endpoint, API key, mounted key permissions and secret group |
| HTTP 429 | Current admission load and the client's retry and concurrency settings |
| HTTP 503 or model unavailable | Engine health, model download or compilation progress, private upstream and engine logs |
| HTTP 504 | Gateway timeout, GPU saturation and proxy or client deadlines |
| Engine rejects settings | Integer limits between 1 and 128, graph capacity at or below sequence capacity, and valid single-stage YAML |
| CUDA out of memory or high latency | KV and context budget, graph, CFM and AudioVAE allocations, and other GPU processes |
| Identity or catalog changes after an update | Compose project and volume names. Locate and preserve the original volume before proceeding |

Remove request bodies, credentials, voice references and private ticket URLs from shared diagnostics.

## Rollback

Restore the recorded source and images with their original overlays, settings and volume names. Restore the previous concurrency value if the old gateway only accepts a lower limit. If an incompatible state migration requires backup recovery, restore to a new empty volume following the [operations runbook](OPERATIONS.md#backup-and-restore). Run only one copy of each provider identity. Keep the reviewed deployment manifests and matching runtime code for any contracts and paid orders, which have a separate lifecycle from containers.

## Validation policy

GitHub acceptance runs on manual dispatch. Run builds, acceptance and benchmarks after an explicit operator request. Record the source revision, environment and workload in any result. See the [storage validation record](VALIDATION.md) and [GPU validation record](../tts/VALIDATION.md) for the scope of prior checks.
