#!/usr/bin/env bash
#
# The whole run in one command: start a clean container from the image, drive it
# with Playwright, then take the container away.
#
#   ./run-e2e.sh [image] [port] [volume-prefix]
#
# Defaults: ghcr.io/sigma-gigachad/z-cloudium:latest, 3032, zcloudium-e2e-pw
#
# KEEP=1 leaves the container running after the suite, which is what to use when
# a failure needs looking at by hand: the report says which port it is on.
#
# E2E_PANEL=on starts the container with ZCLOUDIUM_BROWSER_PANEL=on, which is what
# the panel specs of the suite need; without it the container is started with the
# panel explicitly off, and those specs skip with a reason. The image runs the
# panel on by default, so both positions are asked for rather than inherited. Run
# the suite twice to cover both, with two ports and two prefixes:
#
#   ./run-e2e.sh zcloudium:latest 3032 zcloudium-e2e-pw
#   E2E_PANEL=on ./run-e2e.sh zcloudium:latest 3033 zcloudium-e2e-pw-panel
#
# The suite is not installed by this script: run `npm ci` in e2e/ first, and
# `npx playwright install --with-deps chromium` once per machine.

set -euo pipefail
cd "$(dirname "$0")"

IMAGE="${1:-ghcr.io/sigma-gigachad/z-cloudium:latest}"
PORT="${2:-3032}"
PREFIX="${3:-zcloudium-e2e-pw}"

here="$(pwd)/.."

./start-container.sh "$IMAGE" "$PORT" "$PREFIX"

status=0
if [ ! -d "$here/node_modules/@playwright/test" ]; then
  echo "The suite is not installed: run 'npm ci' in $here first." >&2
  status=1
else
  (cd "$here" && E2E_BASE_URL="http://127.0.0.1:$PORT" npx playwright test) || status=$?
fi

if [ "${KEEP:-0}" = "1" ]; then
  echo "==> KEEP=1: $PREFIX is still running on http://127.0.0.1:$PORT"
else
  ./stop-container.sh "$PREFIX"
fi

exit "$status"
