#!/usr/bin/env bash
#
# Verifies that the UNSAFE profile actually delivers what it promises: the
# agent inside the container can act on the machine itself, not only on /host.
#
#   ./check-unsafe.sh
#
# Jetable container, never exposed on the network. The probes are read-only
# against the machine, and the package installation is a SIMULATION
# (apt-get -s), so nothing is installed anywhere.

set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/sigma-gigachad/z-cloudium:latest}"
FAKE_HOME="/tmp/zcloudium-unsafe-home"

mkdir -p "${FAKE_HOME}/.zcode"
echo "unsafe check" > "${FAKE_HOME}/.zcode/marker"

echo "==> Starting a throwaway container with the unsafe profile settings"
CONTAINER=$(docker run -d --rm \
  --user root \
  --privileged \
  --pid host \
  -v /:/host \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -e "HOME=/host${FAKE_HOME}" \
  -e "ZCODE_DATA_BASE_DIR=/host${FAKE_HOME}" \
  --entrypoint bash \
  "$IMAGE" -c 'sleep 300')

trap 'docker rm -f "$CONTAINER" >/dev/null 2>&1 || true' EXIT
sleep 3

exec_in() { docker exec -u root "$CONTAINER" "$@"; }

echo
echo "uid in the container: $(exec_in id -u) ($(exec_in id -un))"

echo -n "1. /host/etc/shadow readable (root on the mounted FS): "
exec_in head -c 12 /host/etc/shadow >/dev/null 2>&1 && echo "OK" || echo "REFUSED"

echo -n "2. nsenter to the machine's PID 1 (host namespaces): "
HOST_NAME=$(exec_in nsenter -t 1 -m -u -i -n -p -- hostname 2>/dev/null || true)
CONT_NAME=$(exec_in hostname)
if [ -n "$HOST_NAME" ] && [ "$HOST_NAME" != "$CONT_NAME" ]; then
  echo "OK (machine '$HOST_NAME', container '$CONT_NAME')"
else
  echo "REFUSED or same namespace (host_name='$HOST_NAME')"
fi

echo -n "3. what the machine itself runs (PID 1 root, may differ from /host on multi distro WSL): "
exec_in nsenter -t 1 -m -u -i -n -p -- sh -c 'head -1 /etc/os-release' 2>/dev/null || echo "(unreadable)"

echo -n "3b. what the /host mount carries: "
exec_in head -1 /host/etc/os-release 2>/dev/null || echo "(no os-release)"

echo -n "4. host package manager, SIMULATION only (no install): "
DONE=0
if exec_in nsenter -t 1 -m -u -i -n -p -- sh -c 'command -v apt-get >/dev/null 2>&1'; then
  if exec_in nsenter -t 1 -m -u -i -n -p -- apt-get -s install -y hello >/dev/null 2>&1; then
    echo "OK (apt-get -s simulation succeeded on the machine, real install: nsenter -t 1 -m -u -i -n -p -- apt-get install -y <pkg>)"
    DONE=1
  else
    echo "apt present but simulation failed (empty package lists on the machine? run apt-get update there once)"
    DONE=1
  fi
fi
if [ "$DONE" = 0 ] && exec_in nsenter -t 1 -m -u -i -n -p -- sh -c 'command -v pacman >/dev/null 2>&1'; then
  if exec_in nsenter -t 1 -m -u -i -n -p -- pacman -S --print --noconfirm curl >/dev/null 2>&1; then
    echo "OK (pacman --print simulation succeeded; real install: nsenter -t 1 -m -u -i -n -p -- pacman -S --noconfirm <pkg>)"
    DONE=1
  else
    echo "pacman present but simulation failed (sync db empty on the machine? run pacman -Sy there once)"
    DONE=1
  fi
fi
[ "$DONE" = 0 ] && echo "no usable package manager found through nsenter (the /host chroot is the other path: chroot /host <package-manager>)"

echo -n "5. the machine's Docker (nsenter to the host CLI): "
HOST_DOCKER=$(exec_in nsenter -t 1 -m -u -i -n -p -- sh -c 'docker ps --format "{{.Names}}" 2>&1' 2>/dev/null | tr '\n' ' ')
if [ -n "$HOST_DOCKER" ]; then
  echo "OK, machine containers: $HOST_DOCKER"
else
  echo "REFUSED"
fi

echo -n "5b. the Docker socket from inside the image (curl --unix-socket): "
VER=$(exec_in curl -s --max-time 5 --unix-socket /var/run/docker.sock http://localhost/version 2>/dev/null | command grep -o '"Version":"[^"]*"' | head -1)
if [ -n "$VER" ]; then
  echo "OK, daemon $VER"
else
  echo "REFUSED"
fi

echo -n "6. home visible through the mount: "
if exec_in sh -c "ls '/host${FAKE_HOME}/.zcode'" >/dev/null 2>&1; then
  echo "OK"
else
  echo "REFUSED"
fi

echo
echo "==> Throwaway container removed."
