#!/usr/bin/env bash
set -euo pipefail
TASK_PROJECT="ats-backup-verify-$$"
TASK_WORK="$(mktemp -d "${TMPDIR:-/tmp}/ats-backup.XXXXXX")"
SCRIPT_ROOT="$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)"
cd "$SCRIPT_ROOT"
export NODE_PORT="${VERIFY_BACKUP_PORT:-18793}" NODE_PUBLIC_URL="http://127.0.0.1:${VERIFY_BACKUP_PORT:-18793}"
export NODE_URL="$NODE_PUBLIC_URL" VERIFY_STATE="$TASK_WORK/state.json"
TASK_VOLUME="${TASK_PROJECT}_restored"
compose() { docker compose -p "$TASK_PROJECT" -f compose.yaml "$@"; }
finish() { result=$?; docker rm -f "${TASK_PROJECT}-restored" >/dev/null 2>&1 || true; compose down -v --remove-orphans >/dev/null; docker volume rm "$TASK_VOLUME" >/dev/null 2>&1 || true; rm -rf "$TASK_WORK"; exit "$result"; }
trap finish EXIT
compose up -d --build --wait node
node scripts/verify-node.mjs prepare
compose restart node
compose up -d --wait node
node scripts/verify-node.mjs resume
TASK_IMAGE="$(docker inspect "$(compose ps -q node)" --format '{{.Config.Image}}')"
# A running volume must never be backed up as a crash-consistent SQLite snapshot.
if scripts/volume-backup.sh "${TASK_PROJECT}_node-data" "$TASK_WORK/unsafe.tar.gz" --plaintext-development; then echo 'FAIL accepted live volume' >&2; exit 1; fi
compose stop node
scripts/volume-backup.sh "${TASK_PROJECT}_node-data" "$TASK_WORK/node.tar.gz" --plaintext-development
docker volume create "$TASK_VOLUME" >/dev/null
scripts/volume-restore.sh "$TASK_VOLUME" "$TASK_WORK/node.tar.gz" --plaintext-development
compose down
docker run -d --name "${TASK_PROJECT}-restored" -p "127.0.0.1:$NODE_PORT:8787" -e "NODE_PUBLIC_URL=$NODE_PUBLIC_URL" --mount "type=volume,source=$TASK_VOLUME,target=/data" "$TASK_IMAGE" >/dev/null
node --input-type=module <<'JS'
import fs from 'node:fs';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';
const state=JSON.parse(fs.readFileSync(process.env.VERIFY_STATE));let node;
for(let i=0;i<100;i++){try{node=await(await fetch(process.env.NODE_URL+'/v1/node')).json();break;}catch{await new Promise(r=>setTimeout(r,100));}}
assert.equal(node.providerID,state.providerID);
const resources=await(await fetch(process.env.NODE_URL+'/v1/resources')).json();const r=resources.items.find(r=>r.id===state.publicResourceID);assert(r);
const data=Buffer.from(await(await fetch(r.sources[0])).arrayBuffer());assert.equal(createHash('sha256').update(data).digest('hex'),r.sha256);assert.equal(data.length,r.byteCount);
console.log('PASS backup restore: same identity, catalogue, complete archive SHA256; running-volume snapshot rejected');
JS
