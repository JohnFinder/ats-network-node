# Network document translation

Translation runs independently of speech synthesis. The gateway authenticates model discovery and translation requests with a bearer API key. `GET /v1/node` advertises the model, endpoints and authentication method in its `translation` field. ATS checks the authenticated model list before using the service.

## Start the gateway

For an operator-managed OpenAI-compatible upstream, set `TRANSLATION_UPSTREAM` to its origin and `TRANSLATION_MODEL` to the exact ID returned by its model list. Set these in the node's private `.env`. The default `TRANSLATION_PROMPT_FORMAT=translategemma` uses the delimiter format expected by the vLLM TranslateGemma template. Use `chat` for a general chat model. If the upstream requires a key, mount it in a Compose override and set `TRANSLATION_UPSTREAM_KEY_FILE` to its container path. The gateway uses that credential separately from the client API key.

Set up a reachable upstream before starting the gateway with the commands below. From the gateway container, a host service uses a reachable host address such as `http://host.docker.internal:8000`. The default `http://translation-engine:8000` resolves only when you include the private NVIDIA backend overlay.

Run one of these commands from the node repository root on Linux.

```sh
scripts/start-translation-node.sh

# LAN discovery requires avahi-daemon and avahi-utils.
scripts/start-translation-node.sh --lan

# HTTPS requires NODE_DOMAIN, DNS and reachable ports 80 and 443.
scripts/start-translation-node.sh --public
```

The script creates or preserves `secrets/translation_api_key`. Share the key with authorized users through a secure channel. The script keeps it out of console output and `.env`.

The default local base is `http://127.0.0.1:8792`. Set `TRANSLATION_PORT` in `.env` to choose a different host port. The container continues to listen on 8792. Update any manually configured base URL to match.

With `--lan`, the gateway listens on the host's IPv4 interfaces. The foreground Avahi publisher advertises `_ats-translation._tcp` using the port that Compose actually published. Limit access to the intended subnet with the host firewall. Stopping the publisher withdraws the advertisement. To stop the gateway as well, run `docker compose -f compose.yaml -f compose.translation.yaml stop translation`. On networks without discovery, enter the host's LAN address and published port manually.

With `--public`, the advertised translation base is `https://node.example.com/translation` for a node at `https://node.example.com`. Replace the example domain with your own. The community node option in ATS requires this same-origin route. For a gateway on a different origin or port, connect directly by entering its base address.

## Run an optional NVIDIA backend

On the NVIDIA host, leave `TRANSLATION_UPSTREAM` unset or set it to `http://translation-engine:8000`. Generate the API key and start the private backend from the node repository root. The first start downloads weights and requires enough GPU memory for the model and runtime.

```sh
umask 077
mkdir -p secrets
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work \
  node:24-alpine node tts/scripts/create-key.mjs secrets/translation_api_key
export TRANSLATION_SECRET_GID=$(stat -c '%g' secrets/translation_api_key)
docker compose -f compose.yaml -f compose.translation.yaml -f compose.translation-engine.yaml up -d --build
```

The overlay uses `vllm/vllm-openai:v0.14.1-cu130` and the compatible `Infomaniak-AI/vllm-translategemma-27b-it` model. The operator obtains model access and complies with the applicable license. Measure memory and scheduling on the target host if speech and translation share a GPU. This guide contains no measured NVIDIA inference result for this backend. [vLLM TranslateGemma recipe](https://docs.vllm.ai/projects/recipes/en/stable/Google/TranslateGemma.html)

## Publish speech and translation on one domain

Apply the overlays in the following order. Each gateway has its own route and API key. Use `https://node.example.com/translation` as the translation base, replacing the example domain with the deployed one.

```sh
docker compose -f compose.yaml \
  -f compose.gpu.yaml \
  -f compose.translation.yaml \
  -f compose.public.yaml \
  -f compose.gpu-public.yaml \
  -f compose.translation-public.yaml \
  -f compose.translation-gpu-public.yaml up -d --build
```

Generate both gateway keys with their startup helpers before running the combined command. On the host, export `TTS_SECRET_GID=$(stat -c '%g' secrets/tts_api_key)` and `TRANSLATION_SECRET_GID=$(stat -c '%g' secrets/translation_api_key)` so Compose grants each gateway access to its secret. Supply an external translation upstream for this overlay sequence. The private NVIDIA backend additionally requires `compose.translation-engine.yaml`.

## API and limits

Send `Authorization: Bearer <API key>` to both endpoints.

| Request | Behavior |
| --- | --- |
| `GET /v1/models` | Checks that the configured upstream serves the model and returns a model entry with `capabilities: ["translation"]`. |
| `POST /v1/translations` | Accepts JSON with `model`, `text`, `source` and `target`. Returns JSON with `model` and `translation`. |

Use explicit language codes such as `en` and `zh-Hans`. ATS resolves automatic language selection before sending the request. Send complete sentences or paragraphs. The gateway rejects over-limit requests and rejects upstream responses with a length stop, tool calls, empty text or a mismatched model. It keeps sentences intact when forwarding text.

The defaults are two concurrent requests, a 120-second upstream deadline and a 2,048-token output budget. The gateway caps request bodies at 256 KiB, text at 200 KiB and upstream response bodies at 2 MiB. Configure capacity and timeouts to fit the upstream. To adjust the output budget, pass `TRANSLATION_MAX_OUTPUT_TOKENS` to the gateway container. Disconnecting the client cancels its upstream request.

## Connect ATS

In the app's translation model settings, choose a nearby service, read the service description from a configured community node, or enter the gateway address. Enter the API key and verify the model list. The app saves node and model selections in local preferences and stores the key in Keychain. Disconnecting preserves the credential. Removing the node deletes its saved key. Discovery does not forward an existing key to a different origin.

When using this optional service, ATS sends the selected document text to the configured node. Local document translation uses the on-device 4B model. App interface localization uses the project's separate approved 27B workflow.
