# Deployment, upgrade and recovery

Run commands from the standalone `ats-network-node` repository root. [繁體中文快速入門](QUICKSTART.zh-Hant.md) and the [GPU guide](../tts/README.zh-Hant.md) provide first-install examples. Commands below are operator instructions, not evidence that a deployment has been performed.

## Deployment inputs

| Input | Purpose |
| --- | --- |
| `.env` | Public origins, quotas, peer pins, concurrency and resource limits |
| `secrets/tts_api_key` | Private speech gateway key, preserved across updates |
| `tts/voxcpm2.yaml` | Engine context, KV budget, device and runtime configuration |
| Compose project name and overlays | Identify the existing services, networks and persistent volumes |
| Data volumes | Storage identity, SQLite state, publications and optional service identities |
| `tts-model-cache` | Model and compilation cache for GPU deployments |

Do not commit private inputs or replace an existing `.env` with `.env.example`. Every process sharing a writable data volume must be stopped before a filesystem backup. See the [encrypted backup procedure](OPERATIONS.md#backup-and-restore).

## Upgrading an existing node

1. Record the running source revision, image references, Compose project name, overlay list, data volume names and custom YAML settings. Retain rollback images and a consistent encrypted backup.
2. Fetch the desired source into a separate checkout or staging directory. Review the change log and compare `.env.example`, Compose files and engine YAML with your deployment. Copy new code while preserving existing private inputs and merging resource tuning.
3. Set `TTS_MAX_CONCURRENT` to the desired value in 1–128. The default is 8. A nonempty shared override changes gateway admission, engine sequences and decode graph batch capacity together; a separate graph override can reduce graph capacity. For independently configured YAML engine limits, follow the precedence example in the [GPU guide](../tts/README.zh-Hant.md#部署並發參數).
4. Rebuild and recreate affected containers using the same Compose project name and complete overlay list as before. The standard GPU helper is `sh scripts/start-gpu-node.sh`; a public GPU deployment retains `--public`. For customized deployments use the original Compose invocation, including custom overlays. Changing a checkout directory must not silently change the project name or select empty replacement volumes.
5. Check container health and logs. Gateway logs show `max_concurrent`; engine logs show `max_num_seqs` and `decode_graph_max_batch_size`. Storage `/health` checks the storage process; gateway `/health` alone does not establish GPU readiness. Authenticated `/v1/models` checks engine readiness. An authorized synthetic speech request is a separate operator acceptance step.

Recreating the engine interrupts in-flight synthesis. Coordinate that interruption with clients. Preserve the existing speech API key so authorized clients keep their configured credential.

## Capacity and overload

128 is the maximum configurable admission/sequence value. It does not guarantee 128 resident long requests or a particular throughput. KV cache is explicitly 6 GiB in the supplied YAML and does not grow automatically with the sequence count. Account separately for model weights, CFM, AudioVAE, graph pools and other GPU processes. Tune `max_model_len`, `max_num_batched_tokens` and KV budget on the target hardware.

`TTS_CUDA_GRAPH_MAX_BATCH_SIZE` can reduce graph capacity without reducing gateway admission. It does not bound the other model allocations. Gateway memory/CPU limits are independently configurable; simultaneous reference WAV uploads increase host RAM and JSON processing demand.

At admission capacity the gateway rejects new synthesis with HTTP 429 and `Retry-After: 2`. Clients should honor that delay and limit their own concurrency. The gateway does not create an unlimited waiting queue. Configuring the ATS client to 128 cannot override a server configured to 8.

`TTS_TIMEOUT_SECONDS` defaults to 180 and accepts 5–600. If increased for a public node, adjust `Caddyfile.gpu`'s 190-second response header timeout and any external proxy/client deadlines as appropriate.

## Troubleshooting

| Symptom | Check |
| --- | --- |
| HTTP 401 | Correct endpoint and existing API key; mounted key readability and configured secret group |
| HTTP 429 | Gateway admission is full; honor retry delay and compare client/server capacity |
| HTTP 503 / model not ready | Engine health, model download/compilation progress, configured private upstream and engine logs |
| HTTP 504 | Gateway timeout, GPU saturation and proxy/client deadlines |
| Engine refuses configuration | Integer values 1–128; graph capacity must not exceed sequence capacity; valid single-stage YAML |
| CUDA OOM or high latency | KV/context settings, graph/CFM/VAE allocations and other GPU services; lower capacity and inspect target-host metrics |
| Identity or catalogue appears different after update | Compose project and volume selection; never initialize over or delete the original volume as a repair shortcut |

Do not publish request bodies, API keys, voice references or private ticket URLs when sharing logs.

## Rollback

Use the previously recorded source and images with the original overlays, configuration and volume names. A previous gateway with a lower concurrency limit may reject a newer value: restore its compatible deployment settings too. Restore a backup only when required for an incompatible state migration, to a new empty volume using the operations runbook; never run restored and original identities concurrently. Contract deployments and paid orders are separate from container rollback and must continue to use their reviewed manifests and matching runtime code.

## Validation policy

This publication has static source, metadata and documentation checks only. It does not establish GPU performance or a live HTTPS deployment. GitHub acceptance is manual only. Run build, acceptance or benchmark workloads only after an explicit operator request, and record their exact source revision and target environment.
