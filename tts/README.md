# Run a VoxCPM2 GPU node

The GPU profile runs the ATS storage node, an authenticated speech gateway and a private VoxCPM2 engine. The ATS app sends text and any reference recording to the selected node. The gateway keeps text, audio and API keys out of logs. Operators issue a speech API key separately from the storage and settlement services.

## Install and start

Use Linux x86-64, a BF16-capable NVIDIA GPU, Docker with Compose V2 and the NVIDIA Container Toolkit. Start with a dedicated GPU with at least 24 GB of VRAM, 32 GB of system RAM and 30 GB of disk space for model and compilation caches. Suitable GPU candidates include the RTX 4090, L4, A10, A100 and H100. Check that a CUDA container can see the GPU before deploying. The pinned image uses CUDA 13.0. Use a compatible NVIDIA driver such as R580 or later and check NVIDIA's requirements for your hardware and compatibility mode. [NVIDIA CUDA compatibility](https://docs.nvidia.com/deploy/cuda-compatibility/)

For a first installation, run the following from the repository root. On an existing node, keep your current environment file and follow the upgrade runbook. [Deployment and upgrades](../docs/DEPLOYMENT.md#upgrading-an-existing-node)

```sh
cp .env.example .env
sh scripts/start-gpu-node.sh
```

The startup script prints the GPU model, VRAM and driver version. It creates a random key at `secrets/tts_api_key` if the file is absent and configures the gateway's supplemental group to read it. The key file has mode `0640`, and a newly created secrets directory has mode `0700`. Share the key with authorized users through a secure channel. Keep it out of Git, environment files and command output.

The first start downloads the pinned weights and compiles GPU kernels. Compose gives the engine a 15-minute health check start period. Keep the `tts-model-cache` volume across restarts to reuse the weights and compilation cache.

The default deployment binds storage to loopback port `8787` and the gateway to loopback port `8791`. The engine listens only on its Docker network. For a public deployment, set `NODE_DOMAIN` in `.env`, point DNS at the host and open ports 80 and 443. Start the GPU stack with Caddy and its TLS routes.

```sh
sh scripts/start-gpu-node.sh --public
```

In the app, enter the node origin (for example, `https://node.example.org`) and the API key. The node descriptor at `GET /v1/node` advertises the speech endpoint and authentication method. Check engine readiness through the authenticated model list. For CPU storage deployments, use the base Compose file. [Speech API](#speech-api)

To rotate the key, stop the `tts` service with your deployment's Compose files, move the old key to secure backup storage and rerun the startup command. Recreating the gateway cancels in-flight requests. The node uses one shared key. Per-user revocation, usage quotas and billing require a separate credential management layer.

## Engine and quality settings

The engine image pins vLLM-Omni and vLLM to `0.30.0`, VoxCPM to `2.0.3` and the weights to revision `32279effe8c19989596f05d353d1447f51d9e915`. The Dockerfile pins the base image by digest. The deployment YAML follows the upstream release and disables `trust_remote_code` to avoid executing code from the model repository. [Engine Dockerfile](engine.Dockerfile) · [Deployment configuration](voxcpm2.yaml)

The long-running engine uses continuous batching, batched CFM and AudioVAE, fused QKV and MLP, zero-time-step caching and a unified decode CUDA graph inside the model. Keep `enforce_eager: true` for compatibility with the pinned engine. The model's internal decode graph operates with that setting.

The deployment uses the upstream synthesis quality settings. Tune for the GPU, sentence lengths, languages and reference audio your users send. Warm the target GPU and compare throughput, p95 latency and peak VRAM at concurrency levels of 1, 4 and 8 before raising capacity. [Benchmarking](#benchmark-the-target-gpu)

## Deployment concurrency

Set the shared limit in the repository's `.env`. For example, this setting lets the gateway admit up to 128 active requests and sets both engine sequence and unified decode graph capacity to 128.

```dotenv
TTS_MAX_CONCURRENT=128
```

| Setting | Default and range | Effect |
| --- | --- | --- |
| `TTS_MAX_CONCURRENT` | 8, configurable from 1 to 128 | Sets gateway admission. A nonempty value also overrides engine `max_num_seqs` and `unified_decode_graph_max_batch_size`. |
| `TTS_CUDA_GRAPH_MAX_BATCH_SIZE` | Empty, or 1 through the engine sequence limit | Sets the graph batch capacity independently. When empty, the engine uses the shared override if supplied and otherwise keeps the YAML value. |
| `TTS_GATEWAY_MEMORY_LIMIT` | `1g` | Caps gateway system memory. Size it for concurrent request bodies and reference WAV uploads. |
| `TTS_GATEWAY_CPUS` | `2` | Sets the gateway CPU allowance for JSON and WAV processing. |

The engine launcher validates the integer overrides and requires the graph batch capacity to fit within the sequence limit. It applies overrides to a private temporary YAML file before invoking `vllm serve`. Read the startup log for the effective limits. At its admission limit, the gateway immediately responds with `429` and `Retry-After: 2`.

To use YAML for the engine limits, add the following settings to the last Compose override in your deployment.

```yaml
services:
  tts:
    environment:
      TTS_MAX_CONCURRENT: "128"
  voxcpm2:
    environment:
      TTS_MAX_CONCURRENT: ""
      TTS_CUDA_GRAPH_MAX_BATCH_SIZE: ""
```

Set `stages[0].max_num_seqs` and `stages[0].engine_extras.hf_overrides.voxcpm2_runtime_config.unified_decode_graph_max_batch_size` in the mounted `tts/voxcpm2.yaml`. Keep both within 1–128 and gateway admission at or below the sequence limit. The same precedence applies if you run the engine container directly. A standalone gateway defaults to 8 when the environment variable is absent.

After changing limits, recreate both containers. Rerun the startup script for standard deployments and include `--public` if you use the public profile. If you manage Compose yourself, retain the same override files and order when redeploying.

**128 is a configuration limit. Peak VRAM, latency and throughput at that level still need verification on the target GPU.** The shipped KV cache remains fixed at 6 GiB as concurrency increases. Tune `kv_cache_memory_bytes`, `max_model_len` and `max_num_batched_tokens` together to fit your workload. Budget additional VRAM for CFM, AudioVAE, graph pools and other GPU services. Reducing the graph limit only reduces that graph's batch capacity. Long inputs and concurrent reference uploads can also require more gateway memory or a higher `TTS_TIMEOUT_SECONDS` (5–600 seconds). If you raise the timeout on a public deployment, review the `response_header_timeout` in `Caddyfile.gpu`, which defaults to 190 seconds.

## Speech API

Send `Authorization: Bearer <API key>` to the model and speech endpoints.

```http
GET /v1/models
Authorization: Bearer <API key>
```

When the engine is ready, the gateway returns an OpenAI-compatible model list containing `openbmb/VoxCPM2` with a sample rate of 48 kHz. When it is unavailable, the gateway returns `503`.

Send an `application/json` body to `POST /v1/audio/speech`.

```json
{
  "model": "openbmb/VoxCPM2",
  "input": "A complete sentence to synthesize.",
  "voice": "default",
  "response_format": "wav",
  "stream": false,
  "ref_audio": "data:audio/wav;base64,...",
  "ref_text": "The optional transcript of the reference recording."
}
```

Use `default` for the voice. The model accepts `voxcpm2` as an alias. Omit both reference fields to synthesize speech without cloning, or supply a recording with its transcript when available. The gateway validates `language` (`auto` or a language or locale code) for client compatibility and lets VoxCPM2 infer the language from the text. The ATS app handles sentence splitting, prefetch, buffering and playback speed.

The gateway returns each complete result as `audio/wav` after synthesis. It sets `Cache-Control: no-store` and does not persist generated audio. Supply at most 4,096 Unicode code points in `input`. Reference recordings must contain PCM or floating-point WAV audio in a data URI, up to 45 seconds and 8 MiB. The gateway rejects URL and file references, other models and arbitrary inference options.

The default body limit is 12 MiB, the default response limit is 64 MiB and the default synthesis deadline is 180 seconds. Client disconnects cancel the gateway's upstream request. Timeouts, errors and disconnects release the admission slot. The gateway verifies credentials using constant-time comparison of fixed-length hashes. Use TLS for requests outside loopback.

## Benchmark the target GPU

Run the benchmark explicitly against a warmed deployment. The benchmark client needs Node.js 24 and enough memory to hold the concurrent WAV responses. You can also run it in a Linux Docker container with host networking. The script supports 1–128 concurrent requests, 1–1,024 measured requests and two warmup requests. Set the request count at or above concurrency. Each request has a 180-second client deadline.

```sh
mkdir -p artifacts
node tts/scripts/benchmark.mjs --concurrency 1 --requests 8 --output artifacts/tts-c1.json
node tts/scripts/benchmark.mjs --concurrency 4 --requests 16 --output artifacts/tts-c4.json
node tts/scripts/benchmark.mjs --concurrency 8 --requests 24 --output artifacts/tts-c8.json
```

Check latency and VRAM before proceeding to 16, 32, 64 or 128. After configuring the deployment for 128, for example, run `node tts/scripts/benchmark.mjs --concurrency 128 --requests 256 --output artifacts/tts-c128.json` to measure that load.

For a remote benchmark, pass `--url https://node.example.org --key-file /path/to/key`. To exercise voice cloning, pass `--ref-wav reference.wav` and optionally `--ref-text-file transcript.txt`. The report excludes request text, recordings and credentials. It separates warmup from measured requests and records p50 and p95 latency, real-time factor (wall time divided by audio duration), and generated audio seconds per wall-clock second. First response timing includes synthesis and buffering because the model generates a complete result. Record the server GPU and driver separately for remote benchmarks. The report's `clientHardware` describes the machine running the benchmark.

Docker on macOS can validate the gateway image, Compose configuration and authentication with a simulated engine. Use the target Linux NVIDIA host to confirm startup, audio quality, peak VRAM and throughput before public operation. [Dated validation records](VALIDATION.md)

## Upstream references

- [vLLM-Omni v0.30.0 release](https://github.com/vllm-project/vllm-omni/releases/tag/v0.30.0)
- [Pinned upstream VoxCPM2 deployment configuration](https://github.com/vllm-project/vllm-omni/blob/a8576ccb725c4e21cd13c3eb5f9a546b21149d2b/vllm_omni/deploy/voxcpm2.yaml)
- [CUDA installation and Docker instructions for the pinned release](https://github.com/vllm-project/vllm-omni/blob/v0.30.0/docs/getting_started/installation/gpu/cuda.inc.md)
- [Upstream VoxCPM2 recipe and historical measurements](https://github.com/vllm-project/vllm-omni/blob/main/recipes/OpenBMB/VoxCPM2.md)
- [Pinned VoxCPM2 weights](https://huggingface.co/openbmb/VoxCPM2/tree/32279effe8c19989596f05d353d1447f51d9e915)
