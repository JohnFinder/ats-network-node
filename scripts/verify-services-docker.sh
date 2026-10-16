#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
exec node scripts/verify-services-docker.mjs
