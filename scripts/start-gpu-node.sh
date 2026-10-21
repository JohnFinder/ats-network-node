#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
if [ "$(uname -s)" != Linux ] || [ "$(uname -m)" != x86_64 ]; then
  echo 'GPU serving requires a Linux x86_64 NVIDIA host.' >&2
  exit 1
fi
if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo 'Install the NVIDIA driver and NVIDIA Container Toolkit first.' >&2
  exit 1
fi
nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader
umask 077
mkdir -p secrets
# The host needs Docker only. No host Node.js/Python or manually created key.
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work node:24-alpine node tts/scripts/create-key.mjs
TTS_SECRET_GID=$(stat -c '%g' secrets/tts_api_key)
export TTS_SECRET_GID
if [ "${1:-}" = '--public' ]; then
  exec docker compose -f compose.yaml -f compose.gpu.yaml -f compose.public.yaml -f compose.gpu-public.yaml up -d --build
elif [ "$#" -eq 0 ]; then
  exec docker compose -f compose.yaml -f compose.gpu.yaml up -d --build
else
  echo 'Usage: scripts/start-gpu-node.sh [--public]' >&2
  exit 1
fi
