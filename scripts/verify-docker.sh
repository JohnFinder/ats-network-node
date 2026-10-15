#!/bin/sh
# Runs only isolated synthetic fixtures and a local development chain. No real funds.
set -eu
TASK_PROJECT="ats-verify-$$"
TASK_WORK="$(mktemp -d "${TMPDIR:-/tmp}/ats-network-verify.XXXXXX")"
SCRIPT_ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$SCRIPT_ROOT"
export NODE_PORT="${VERIFY_NODE_PORT:-18788}"
export NODE_PUBLIC_URL="http://127.0.0.1:$NODE_PORT"
export NODE_URL="$NODE_PUBLIC_URL"
export CHAIN_PORT="${VERIFY_CHAIN_PORT:-18546}"
export VERIFY_STATE="$TASK_WORK/state.json"
compose() { docker compose -p "$TASK_PROJECT" -f compose.yaml -f compose.chain.yaml "$@"; }
finish() {
    result=$?
    if [ "$result" -ne 0 ]; then compose logs --tail=60 node chain || true; fi
    if [ "${KEEP_VERIFY_CONTAINERS:-0}" = 1 ]; then
        echo "Preserved project $TASK_PROJECT; private synthetic state $TASK_WORK"
    else
        compose down -v --remove-orphans || true
        rm -rf "$TASK_WORK"
    fi
    exit "$result"
}
trap finish EXIT
compose up -d --wait --build node chain
node scripts/verify-node.mjs prepare
compose restart node
compose up -d --wait node
node scripts/verify-node.mjs resume
NODE_RESOURCE_ID="$(node --input-type=module -e "import fs from 'node:fs'; console.log(JSON.parse(fs.readFileSync(process.env.VERIFY_STATE)).publicResourceID)")"
EXPECTED_NODE_ID="$(node --input-type=module -e "import fs from 'node:fs'; console.log(JSON.parse(fs.readFileSync(process.env.VERIFY_STATE)).providerID)")"
export NODE_RESOURCE_ID EXPECTED_NODE_ID
compose run --rm verify-chain
echo 'PASS Docker storage restart + node evidence + local-chain settlement'
