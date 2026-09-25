#!/usr/bin/env bash
#
# Stops the container the suite started, and removes its two volumes.
#
#   ./stop-container.sh [volume-prefix]
#
# Defaults: zcloudium-e2e-pw
#
# Targeted on purpose: it removes the container named by the prefix and the two
# volumes derived from it, and nothing else. No prune, no bulk cleanup: this
# machine and the runner can host unrelated containers and volumes.

set -euo pipefail

PREFIX="${1:-zcloudium-e2e-pw}"

CONTAINER="$PREFIX"
DATA_VOLUME="$PREFIX-data"
WS_VOLUME="$PREFIX-ws"

echo "==> Removing $CONTAINER"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

echo "==> Removing $DATA_VOLUME and $WS_VOLUME"
docker volume rm "$DATA_VOLUME" >/dev/null 2>&1 || true
docker volume rm "$WS_VOLUME" >/dev/null 2>&1 || true

echo "==> Done"
