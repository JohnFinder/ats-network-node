#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
umask 077
mkdir -p secrets
docker run --rm --user "$(id -u):$(id -g)" -v "$PWD:/work" -w /work node:24-alpine node tts/scripts/create-key.mjs secrets/translation_api_key
TRANSLATION_SECRET_GID=$(stat -c '%g' secrets/translation_api_key)
export TRANSLATION_SECRET_GID
case "${1:-}" in
  --lan)
    command -v avahi-publish-service >/dev/null 2>&1 || { echo 'Install avahi-utils for LAN publication.' >&2; exit 1; }
    TRANSLATION_BIND=0.0.0.0
    export TRANSLATION_BIND
    docker compose -f compose.yaml -f compose.translation.yaml up -d --build
    # Read the live mapping so Compose's .env and dynamically assigned ports are honored.
    if ! binding=$(docker compose -f compose.yaml -f compose.translation.yaml port translation 8792); then
      echo 'Could not find the published translation port for LAN discovery.' >&2
      exit 1
    fi
    case "$binding" in
      0.0.0.0:*) ;;
      *) echo 'Expected a published IPv4 translation port for LAN discovery.' >&2; exit 1 ;;
    esac
    published_port=${binding#0.0.0.0:}
    case "$published_port" in
      ''|*[!0-9]*) echo 'Invalid published translation port for LAN discovery.' >&2; exit 1 ;;
    esac
    if [ "${#published_port}" -gt 5 ] || [ "$published_port" -lt 1 ] || [ "$published_port" -gt 65535 ]; then
      echo 'Published translation port is out of range for LAN discovery.' >&2
      exit 1
    fi
    # Foreground publisher: stopping this command withdraws Bonjour immediately.
    exec avahi-publish-service "${TRANSLATION_SERVICE_NAME:-ATS Translation}" _ats-translation._tcp "$published_port" 'authentication=bearer-api-key'
    ;;
  --public)
    exec docker compose -f compose.yaml -f compose.translation.yaml -f compose.public.yaml -f compose.translation-public.yaml up -d --build
    ;;
  '') exec docker compose -f compose.yaml -f compose.translation.yaml up -d --build ;;
  *) echo 'Usage: scripts/start-translation-node.sh [--lan|--public]' >&2; exit 1 ;;
esac
