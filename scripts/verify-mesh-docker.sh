#!/bin/sh
# Isolated synthetic local mesh. Never uses production data or real assets.
set -eu
SCRIPT_ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$SCRIPT_ROOT"
TASK_LOG="${VERIFY_MESH_LOG:-/tmp/ats-mesh-verification-$(date +%Y%m%d-%H%M%S)-$$.log}"
echo "Mesh verification record: $TASK_LOG"
# The JavaScript runner owns cleanup and records the report; no pipeline may mask failure.
VERIFY_MESH_LOG="$TASK_LOG" "${NODE_BINARY:-node}" scripts/verify-mesh-docker.mjs
