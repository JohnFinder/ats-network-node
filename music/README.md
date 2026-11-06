# Music node service

The music service accepts text-to-music jobs and serves authenticated WAV downloads. Its model list, job queue and credentials are separate from the book node and TTS gateway. In ATS settings, select the ATS music adapter and enter the music service HTTPS base URL.

## Deploy the music service

Run the commands below from the root of the standalone `ats-network-node` checkout. The music service is a separate host process. It needs Node.js 24 or newer and uses built-in Node modules. Start at least one model worker, then start `node music/server.mjs` with the worker URL and credentials. Install the licensed weights separately for your chosen inference backend.

Supply `NODE_MUSIC_API_KEYS` to the node process. Give each worker its own key and configure the corresponding key on the node. Keep client and worker keys separate. On a remote deployment, expose the node's loopback listener through a TLS reverse proxy on a dedicated HTTPS origin. Keep the workers on loopback. Point ATS to the HTTPS origin for the music service.

| Variable | Default / meaning |
|---|---|
| `NODE_MUSIC_API_KEYS` | Required comma-separated client keys, at least 24 characters each |
| `NODE_MUSIC_HOST` / `NODE_MUSIC_PORT` | `127.0.0.1` / `8791`; expose through an authenticated TLS proxy |
| `NODE_MUSIC_DATA_DIR` | `./data/music`; SQLite records and private WAV results |
| `NODE_MUSIC_MODEL` | `stabilityai/stable-audio-open-1.0` |
| `NODE_MUSIC_MAX_SECONDS` | Legacy/Stable Audio path: `47`, maximum `120` for a different compatible worker; does not cap MM3 |
| `NODE_MUSIC_MAX_JOBS` | `200`; explicit retention bound, operator archives expired jobs offline |
| `NODE_MUSIC_WORKER_URL` | `http://127.0.0.1:8792/generate`; fixed by operator, never by client |
| `NODE_MUSIC_WORKER_API_KEY` | Separate worker credential, used by node and worker |

The music defaults of 8791 and 8792 overlap the default speech and translation ports. The examples below use port 8794 for the music node, 8795 for the Stable Audio worker and 8793 for the MiniMax Music 3 adapter. Use the same ports in your worker URLs, proxy configuration and client settings. If you also deploy Voice Market on the host, give it a different port such as 8796. [Voice Market deployment](../voice-market/README.md)

For Stable Audio, the worker receives `{model,prompt,duration_seconds,instrumental:true}` and returns a PCM WAV. Use loopback for HTTP workers. The node rejects redirects, keeps client credentials at the music service, and serves results from its own origin.

Stable Audio Open is the default. Set `NODE_MUSIC_MODEL` to select MiniMax Music 3 (MM3), or configure per-model worker URLs to expose both in `/v1/models` through the same queue. The MM3 worker accepts `instrumental:false` or an omitted value, plus optional `instructions` (or `caption`) and `seed`. The Stable Audio worker ignores an optional caption and keeps its existing instrumental behavior and idempotency fingerprint.

## Stable Audio Open worker

The bundled `music/stable_audio_worker.py` runs Stable Audio Open 1.0 through Diffusers. On a CUDA host, create and activate a Python virtual environment. Install a CUDA build of `torch` using the PyTorch installation selector. Accept the gated model terms and give the worker access to the weights through your Hugging Face credentials or cache. [PyTorch installation](https://pytorch.org/get-started/locally/) · [Stable Audio Open model card](https://huggingface.co/stabilityai/stable-audio-open-1.0)

With `NODE_MUSIC_WORKER_API_KEY` set in the worker environment, install its remaining Python dependencies and start it on loopback.

```sh
python -m pip install diffusers transformers accelerate sentencepiece soundfile
NODE_MUSIC_WORKER_PORT=8795 python music/stable_audio_worker.py
```

In the node process environment, set `NODE_MUSIC_API_KEYS` and the same Stable Audio worker key as `NODE_MUSIC_WORKER_API_KEY_STABLE_AUDIO`. Start the node with the worker's port.

```sh
export NODE_MUSIC_PORT=8794
export NODE_MUSIC_MODEL=stabilityai/stable-audio-open-1.0
export NODE_MUSIC_WORKER_URL_STABLE_AUDIO=http://127.0.0.1:8795/generate
node music/server.mjs
```

Stable Audio Open supports up to 47 seconds of 44.1 kHz stereo and was trained with English prompts. Review its model terms separately from personal voice licenses. Measure generation speed and output quality on your GPU. [Stable Audio Open model card](https://huggingface.co/stabilityai/stable-audio-open-1.0).

## MiniMax Music 3 / SGLang-Omni worker

The `mini_max_music3_worker.py` HTTP adapter uses the Python standard library. Use Python 3.12 or newer for support for extensible PCM WAV headers. Install SGLang-Omni and obtain the licensed MM3 weights separately. Start the inference process in the same network namespace as the adapter. [SGLang-Omni installation](https://sgl-project.github.io/sglang-omni/get_started/installation.html)

```sh
CUDA_VISIBLE_DEVICES=0 sgl-omni serve --model-path /operator/weights/MiniMax-Music3 --host 127.0.0.1 --port 8002
```

Bind SGLang-Omni to loopback. The adapter accepts only loopback upstream URLs, including in container deployments. Run the upstream, adapter and music node as separate process units. Terminate client TLS at the proxy for the music node. [SGLang-Omni server flags](https://github.com/sgl-project/sglang-omni/blob/main/docs/get_started/apiserver_quickstart.md).

An operator reference uses an NVIDIA RTX PRO 6000 with 98 GB, Blackwell `sm_120`, about 54 GB of full-precision weights, and about 41 GB resident GPU memory. Confirm that your Torch, CUDA and SGLang-Omni build supports `sm_120`. The operator manages precision, hardware and process lifetime. On a shared GPU, schedule a music window around speech traffic and drain music jobs before stopping the upstream and releasing its allocation.

### Configuration

Use separate secrets for the client and the worker. The node and adapter reject identical credentials if configured together. The adapter calls the operator-configured loopback URL without forwarding client credentials.

| Variable | Process / default / meaning |
|---|---|
| `NODE_MUSIC_MODEL` | Node: `MiniMaxAI/MiniMax-Music3` selects MM3 as the primary model; leaving it unset preserves Stable Audio |
| `NODE_MUSIC_WORKER_URL_MINIMAX_MUSIC3` | Node: setting it adds MM3 alongside the primary model, e.g. `http://127.0.0.1:8793/generate` |
| `NODE_MUSIC_WORKER_URL_STABLE_AUDIO` | Node: optional explicit Stable Audio route, e.g. `http://127.0.0.1:8792/generate` |
| `NODE_MUSIC_WORKER_URL` | Node: legacy URL for the primary model; default port is 8792 for Stable Audio and 8793 for MM3; a per-model URL takes precedence |
| `NODE_MUSIC_WORKER_API_KEY_MINIMAX_MUSIC3` | Node + MM3 adapter: separate 24–4096 character worker key without whitespace; falls back to `NODE_MUSIC_WORKER_API_KEY` |
| `NODE_MUSIC_WORKER_API_KEY_STABLE_AUDIO` | Node: optional separate Stable Audio route key; its unmodified worker still reads `NODE_MUSIC_WORKER_API_KEY` in its own process environment |
| `NODE_MUSIC_MAX_SECONDS_MINIMAX_MUSIC3` | Node + adapter: `360`, integer 3–360; keep both processes aligned |
| `NODE_MUSIC_MAX_SECONDS_STABLE_AUDIO` | Node: optional model-specific override of the legacy duration limit; the bundled Stable Audio worker itself still accepts only 3–47 seconds |
| `NODE_MUSIC_WORKER_TIMEOUT_SECONDS_MINIMAX_MUSIC3` | Node: MM3 limit × 2 + 30 seconds, default `750`; deadline for the entire worker call and persistence |
| `NODE_MUSIC_WORKER_TIMEOUT_SECONDS_STABLE_AUDIO` | Node: `600`, preserving the previous timeout |
| `NODE_MUSIC_MM3_WORKER_PORT` | Adapter: `8793`, always binds `127.0.0.1` |
| `NODE_MUSIC_MM3_UPSTREAM_URL` | Adapter: `http://127.0.0.1:8002/v1/audio/speech`; HTTP/HTTPS loopback only, no credentials/query/fragment, no redirects or environment proxy |
| `NODE_MUSIC_MM3_UPSTREAM_MODEL` | Adapter: `MiniMaxAI/MiniMax-Music3`; set to the installed SGLang-Omni served model ID if different, e.g. `minimax_ttm` |
| `NODE_MUSIC_MM3_LYRICS_FIELD` | Adapter: `input`, following current official SGLang-Omni; choose `lyrics` for the operator's existing variant; no probing or generation retry |
| `NODE_MUSIC_MM3_UPSTREAM_TIMEOUT_SECONDS` | Adapter: MM3 limit × 2, default `720`; total monotonic wall-clock deadline, including headers and slow response bodies |
| `NODE_MUSIC_MM3_DEFAULT_INSTRUCTIONS` | Adapter: `A coherent song matching the supplied lyrics.`; used when no non-empty caption is supplied |
| `NODE_MUSIC_LEGACY_MODEL` | Node: legacy SQLite rows without a model are assigned to Stable Audio by default; set this before migration only if the old node used a different compatible worker |

Use positive integer timeout overrides up to 86,400 seconds. Set the node timeout above the adapter timeout to leave time to validate and save the WAV. A lower duration cap reduces the default timeouts. Increase them explicitly if the pipeline needs a longer cold start.

Provide `NODE_MUSIC_WORKER_API_KEY_MINIMAX_MUSIC3` to the adapter and the node. Supply `NODE_MUSIC_API_KEYS` only to the node. The adapter defaults to the `input` field used by the upstream example. Set `NODE_MUSIC_MM3_LYRICS_FIELD=lyrics` only if your installed upstream uses that field.

```sh
# Adapter process environment (the upstream is started separately).
export NODE_MUSIC_MM3_UPSTREAM_URL=http://127.0.0.1:8002/v1/audio/speech
python3 music/mini_max_music3_worker.py
```

```sh
# Node process: publish both models using separate loopback workers.
export NODE_MUSIC_PORT=8794
export NODE_MUSIC_MODEL=stabilityai/stable-audio-open-1.0
export NODE_MUSIC_WORKER_URL_STABLE_AUDIO=http://127.0.0.1:8795/generate
export NODE_MUSIC_WORKER_URL_MINIMAX_MUSIC3=http://127.0.0.1:8793/generate
node music/server.mjs
```

Use the node command above in place of the Stable Audio-only node command. For both models, start the Stable Audio worker on port 8795 and supply its matching key to the node. For MM3 alone, set `NODE_MUSIC_MODEL=MiniMaxAI/MiniMax-Music3` and omit the Stable Audio URL.

### API and output

The MM3 model entry includes `sample_rate:32000`, `channels:2`, `stereo:true`, `max_seconds:360`, `generative_only:true`, `instrumental_supported:false`, and `attribution:"MiniMax-Music3"`. A lower configured duration appears in the response. Clients can continue reading `max_duration_seconds` and `audio_format:"wav"`.

```json
{
  "model": "MiniMaxAI/MiniMax-Music3",
  "prompt": "[Verse]\nMorning light along the shore\nEvery wave returns once more\n[Chorus]\nCarry this song across the sea\nBring the morning back to me",
  "instructions": "Global Metadata: acoustic folk, 92 BPM, warm and hopeful.\nVocal Details: intimate lead vocal, clear phrasing.\nArrangement: fingerpicked guitar and soft piano in the verse, wider drums and harmonies in the chorus.",
  "duration_seconds": 30,
  "instrumental": false,
  "seed": 7,
  "idempotency_key": "mm3-song-0001"
}
```

Save this as `mm3-request.json` and set `MUSIC_CLIENT_KEY` to one of the credentials in `NODE_MUSIC_API_KEYS`. Use that client credential and a matching idempotency header.

```sh
export MUSIC_BASE_URL=http://127.0.0.1:8794
curl "${MUSIC_BASE_URL}/v1/models" -H "Authorization: Bearer ${MUSIC_CLIENT_KEY}"
curl "${MUSIC_BASE_URL}/v1/music/jobs" \
  -H "Authorization: Bearer ${MUSIC_CLIENT_KEY}" \
  -H 'Content-Type: application/json' -H 'Idempotency-Key: mm3-song-0001' \
  --data-binary @mm3-request.json
# Use the returned id; poll status, then download only once completed.
curl "${MUSIC_BASE_URL}/v1/music/jobs/${JOB_ID}" -H "Authorization: Bearer ${MUSIC_CLIENT_KEY}"
curl "${MUSIC_BASE_URL}/v1/music/jobs/${JOB_ID}/audio" \
  -H "Authorization: Bearer ${MUSIC_CLIENT_KEY}" --output song.wav
```

The adapter forwards `prompt` as lyrics and `instructions` as the style caption. It accepts `caption` as an alias and rejects conflicts. A caption can cover song metadata, vocal details and arrangement. Empty captions use the configured default because the upstream expects instructions. The adapter sets `max_new_tokens` to `duration_seconds × 25`, up to 9000 frames. The result can end earlier when the model emits its end-of-audio token. If you omit the seed, the node chooses it once, stores it with the job and reports it in status. Retries reuse that seed. Keep model weights, SGLang-Omni and execution settings fixed when checking reproducibility.

Put each recognized structure tag on a separate line. The adapter returns `lyrics_structure_tag_must_be_on_own_line` for inline tags such as `[Verse] these words` to preserve all lyrics. The node and adapter cap lyrics at 16,384 bytes, captions at 8,192 bytes and their combined token estimate at 5000. The estimate uses about three ASCII alphanumeric characters per token and counts CJK characters, punctuation and supplementary Unicode conservatively. An upstream 4xx context rejection becomes worker HTTP 400 `lyrics_too_long`. An already queued job reports that code with status `failed`. The total JSON body caps are 32,768 bytes for MM3 and 20,000 bytes for Stable Audio.

MM3 requests with `instrumental:true` return HTTP 400 `instrumental_not_supported` before the node queues a job. Captions can request fewer vocals, but pure instrumental output is outside this adapter's contract. Durations outside 3 seconds to the configured cap return HTTP 400 `duration_out_of_range`, and an overlength token estimate returns HTTP 400 `lyrics_too_long`. The `generative_only` error covers reference audio, voice, speaker, and melody controls. Invalid credentials return HTTP 401. Identical configured client and worker credentials prevent startup.

The adapter and the node each verify nonempty, 16-bit PCM, 32 kHz stereo WAV within the requested duration. The result uses the upstream bytes directly. At 360 seconds, PCM data uses 46,080,000 bytes, or 46,080,044 bytes with a basic WAV header. The 50,000,000-byte result cap includes WAV metadata.

MM3 status includes `model`, the actual `seed`, Unix timestamps in milliseconds (`created_at`, `started_at`, `finished_at`) and `elapsed_seconds` excluding queue time. Adapter deadlines return HTTP 504 `upstream_timeout`, which the node records on the failed job. The node's outer deadline produces `worker_timeout`. Other bounded errors include `upstream_unavailable`, `upstream_redirect_rejected`, `upstream_request_rejected`, and invalid WAV errors. Error responses omit lyrics, captions and raw diagnostics. Cancellation and restart preserve their recorded outcomes. GPU work can continue after a disconnect, and the node never regenerates it automatically.

On the reference RTX PRO 6000, the operator reported about 48.6 seconds for a warm 30-second song (RTF ≈ 1.62) and 56.8 seconds for the first cold song (RTF ≈ 1.89). A 360-second job may approach 700 seconds by extrapolation. Use the 720-second adapter and 750-second node defaults as starting points. Measure startup, readiness and shared GPU contention in your deployment.

### Attribution and license

The MiniMax-Music3 Community License governs model use. For commercial products or services, display **MiniMax-Music3** prominently in the interface. The model entry supplies the attribution text. Obtain prior written authorization if the combined annual revenue from relevant products and services of your organization and its affiliates exceeds US$20 million. If you make generation available to third parties, implement and regularly check the safeguards required by the license. Preserve copyright and license notices and review the acceptable use terms. [Official license](https://huggingface.co/MiniMaxAI/MiniMax-Music3/blob/main/LICENSE), [model card](https://huggingface.co/MiniMaxAI/MiniMax-Music3), [SGLang-Omni cookbook](https://sgl-project.github.io/sglang-omni/cookbook/minimax_music3.html).

### Deployment handoff

The workspace change record covers syntax review and unsigned Apple builds. Real MM3 generation, mock and Stable Audio regressions, output quality, reproducibility, timeouts and physical-device playback require deployment acceptance. Exercise both lyric field modes with the installed upstream. Inspect a fixed-seed 30-second request for 32 kHz, 16-bit stereo and duration within the cap, repeat it with a new key to check reproducibility, and exercise the listed rejections. A changed request with the same key must return HTTP 409 `idempotency_conflict`.

## Task semantics and limits

The queue runs one task at a time and allows up to 10 queued or running tasks. The per-result byte cap and retained job count bound disk use. Each job belongs to the hash of its client credential. An idempotency key permanently identifies its original request, including after failure. Keep that history when archiving jobs.

A restart resumes queued jobs and marks running jobs `interrupted`. Cancelling aborts the node's upstream request and stops delivery, even if worker inference continues. Treat interrupted and cancelled work as already submitted when planning usage. The node issues a single upstream request per running job.

Back up the database before upgrading. The migration adds model, caption, seed and timing fields and preserves existing records and fingerprints. Rows missing a model receive Stable Audio or the explicit `NODE_MUSIC_LEGACY_MODEL`. If a saved model becomes unavailable, queued jobs report `interrupted` with `model_unavailable`. Older servers use a positional eight-column insert, so rollback needs a coordinated migration that preserves accepted jobs and idempotency history.

Reserve resources for TTS when hosting both services on one GPU. Validate the provider's billing behavior, GPU deployment and playback separately.

The ATS client also supports synchronous ElevenLabs generation through `xi-api-key`, `music_length_ms`, and `force_instrumental`. Enter a model ID enabled for your account. Direct requests lack a recoverable job ID, so the app leaves retries to the user. It exports audio separately from voice certificates and credentials. [ElevenLabs Compose API](https://elevenlabs.io/docs/api-reference/music/compose).
