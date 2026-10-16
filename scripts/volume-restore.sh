#!/usr/bin/env bash
# Restore only a trusted backup to an existing EMPTY, stopped volume.
set -euo pipefail
if [[ $# -lt 2 ]]; then echo 'Usage: volume-restore.sh VOLUME ARCHIVE.age --identity AGE_KEY_FILE | --plaintext-development' >&2; exit 2; fi
TASK_VOLUME="$1"; TASK_ARCHIVE="$2"; shift 2
[[ "$TASK_VOLUME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$ && -f "$TASK_ARCHIVE" ]] || exit 2
docker volume inspect "$TASK_VOLUME" >/dev/null
[[ -z "$(docker ps -q --filter "volume=$TASK_VOLUME")" ]] || { echo 'Stop all containers using this volume first' >&2; exit 2; }
docker run --rm --network none --read-only --cap-drop ALL --cap-add CHOWN --security-opt no-new-privileges:true --user 0:0 --mount "type=volume,source=$TASK_VOLUME,target=/target" node:24-alpine sh -c 'test -z "$(ls -A /target)" && chown 1000:1000 /target' || { echo 'Restore requires an empty, writable volume' >&2; exit 2; }
restore() { docker run --rm -i --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 1000:1000 --mount "type=volume,source=$TASK_VOLUME,target=/target" node:24-alpine tar -C /target -xzf -; }
if [[ "${1:-}" == --identity && $# == 2 ]]; then
    command -v age >/dev/null
    age -d -i "$2" "$TASK_ARCHIVE" | restore
elif [[ "${1:-}" == --plaintext-development && $# == 1 ]]; then
    restore < "$TASK_ARCHIVE"
else echo 'Select age decryption or explicit plaintext development mode' >&2; exit 2; fi
echo 'Restore complete. Verify node fingerprint, catalogue and archive hashes before returning to service.'
