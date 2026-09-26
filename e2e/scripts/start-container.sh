#!/usr/bin/env bash
#
# Starts the container the end to end suite drives.
#
#   ./start-container.sh [image] [port] [volume-prefix]
#
# Defaults: ghcr.io/sigma-gigachad/z-cloudium:latest, 3032, zcloudium-e2e-pw
#
# The prefix names the container and both its volumes (PREFIX-data and
# PREFIX-ws), so two runs with different prefixes never collide, and the suite
# never touches a container it did not create. Both volumes are removed first:
# the wizard runs once per data volume, so a clean one is what makes the first
# connection testable at all.
#
# E2E_PANEL=on adds ZCLOUDIUM_BROWSER_PANEL=on. The panel specs of the suite need
# it, and they skip with a reason when the container they are pointed at has the
# panel off. Nothing else about the container changes, so one suite covers both
# positions of the switch.
#
# The switch is passed in both cases, on and off, because the image runs the panel
# on by default: a run that wants the off position has to ask for it, and that is
# what keeps the two CI jobs on two known positions rather than on whatever the
# image defaults to on the day it is built.
#
# The hardening flags are the ones the compose files use and are not weakened
# here: read-only root filesystem, a tmpfs for /tmp, no new privileges, no
# capability, and the port published on loopback only.

set -euo pipefail

IMAGE="${1:-ghcr.io/sigma-gigachad/z-cloudium:latest}"
PORT="${2:-3032}"
PREFIX="${3:-zcloudium-e2e-pw}"
E2E_PANEL="${E2E_PANEL:-off}"

CONTAINER="$PREFIX"
DATA_VOLUME="$PREFIX-data"
WS_VOLUME="$PREFIX-ws"

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "The image $IMAGE is not available locally." >&2
  echo "Build it first: ../build.sh, or pull it from the registry." >&2
  exit 1
fi

echo "==> Removing any previous container and volumes from an earlier run"
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker volume rm "$DATA_VOLUME" >/dev/null 2>&1 || true
docker volume rm "$WS_VOLUME" >/dev/null 2>&1 || true

if [ "$E2E_PANEL" = "on" ]; then
  echo "==> Starting $CONTAINER from $IMAGE on 127.0.0.1:$PORT, browser panel on"
  # Split on purpose into two arguments by the unquoted expansion below, so an
  # empty value adds nothing at all.
  PANEL_ARGS="-e ZCLOUDIUM_BROWSER_PANEL=on"
else
  echo "==> Starting $CONTAINER from $IMAGE on 127.0.0.1:$PORT, browser panel off"
  PANEL_ARGS="-e ZCLOUDIUM_BROWSER_PANEL=off"
fi
docker run -d \
  --name "$CONTAINER" \
  -p "127.0.0.1:$PORT:3030" \
  -v "$DATA_VOLUME:/data" \
  -v "$WS_VOLUME:/workspace" \
  --read-only \
  --tmpfs /tmp:size=512m \
  --security-opt no-new-privileges:true \
  --cap-drop ALL \
  ${PANEL_ARGS} \
  "$IMAGE" >/dev/null

echo "==> Waiting for the gateway to answer on /_auth/health"
for attempt in $(seq 1 60); do
  # Silence curl: while the runtime is still starting, the connection is reset
  # rather than refused, and that is expected on the first attempts.
  if curl -fsS -o /dev/null "http://127.0.0.1:$PORT/_auth/health" 2>/dev/null; then
    echo "==> $CONTAINER is up after $attempt attempt(s): http://127.0.0.1:$PORT"
    exit 0
  fi
  sleep 2
done

echo "The gateway never answered. Logs:" >&2
docker logs "$CONTAINER" >&2 || true
exit 1
