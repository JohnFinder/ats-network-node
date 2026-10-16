#!/usr/bin/env bash
# Stop the owning node/indexer before snapshotting. Contains private signing identity.
set -euo pipefail
if [[ $# -lt 2 ]]; then echo 'Usage: volume-backup.sh VOLUME ARCHIVE.age --recipient AGE_RECIPIENT | --plaintext-development' >&2; exit 2; fi
TASK_VOLUME="$1"; TASK_ARCHIVE="$2"; shift 2
[[ "$TASK_VOLUME" =~ ^[a-zA-Z0-9][a-zA-Z0-9_.-]+$ ]] || exit 2
[[ ! -e "$TASK_ARCHIVE" && ! -e "$TASK_ARCHIVE.partial" ]] || { echo 'Destination exists' >&2; exit 2; }
docker volume inspect "$TASK_VOLUME" >/dev/null
[[ -z "$(docker ps -q --filter "volume=$TASK_VOLUME")" ]] || { echo 'Stop all containers using this volume first' >&2; exit 2; }
umask 077
trap 'rm -f "$TASK_ARCHIVE.partial"' EXIT
snapshot() { docker run --rm --network none --read-only --cap-drop ALL --security-opt no-new-privileges:true --user 1000:1000 --mount "type=volume,source=$TASK_VOLUME,target=/source,readonly" node:24-alpine tar -C /source -czf - .; }
if [[ "${1:-}" == --recipient && $# == 2 ]]; then
    command -v age >/dev/null
    (set -o noclobber; snapshot | age -r "$2" > "$TASK_ARCHIVE.partial")
elif [[ "${1:-}" == --plaintext-development && $# == 1 ]]; then
    (set -o noclobber; snapshot > "$TASK_ARCHIVE.partial")
else echo 'Select age encryption or explicit plaintext development mode' >&2; exit 2; fi
mv "$TASK_ARCHIVE.partial" "$TASK_ARCHIVE"
echo 'Backup complete. Restart the owning services and preserve the decryption key separately.'
