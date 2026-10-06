#!/usr/bin/env bash
#
# Backs up and restores the /data volume of a deployment: the accounts, the
# session signing key, the TLS certificate, the settings, the skills and the
# agent configuration. Everything that makes an instance *this* instance lives
# there, which is why it is the one thing to back up.
#
#   ./backup-data.sh                                  -> ./z-cloudium-data-<timestamp>.tar.gz
#   ./backup-data.sh my-data-volume                   -> same, for a named volume
#   ./backup-data.sh --restore z-cloudium-data-...tar.gz [volume]
#   ./backup-data.sh --list                           -> the backups of the current directory
#
# The backup runs through a throwaway container (alpine, no entrypoint, no
# network), so nothing is installed on the host and the deployment does not need
# to be stopped: a tar of files that are only appended or replaced atomically is
# a consistent snapshot for practical purposes. Stop the container first if you
# want the guarantee rather than the approximation.
#
# The archive is written with the uid/gid of the volume's files (1000:1000 in
# the restricted profile) and is NOT encrypted: it contains scrypt hashes and
# TOTP secrets, so store it where you would store the volume itself.
#
# Restore replaces the whole volume content. The deployment must be stopped:
# a live gateway would keep its in-memory state over a half-replaced /data.

set -euo pipefail
cd "$(dirname "$0")"

VOLUME="${ZCLOUDIUM_DATA_VOLUME:-z-cloudium-data}"
MODE="backup"
FILE=""

case "${1:-}" in
  --restore) MODE="restore"; FILE="${2:?usage: ./backup-data.sh --restore <file.tar.gz> [volume]}"; VOLUME="${3:-$VOLUME}" ;;
  --list) MODE="list" ;;
  ""|*) [ "${1:0:2}" != "--" ] && VOLUME="${1:-$VOLUME}" || { echo "Unknown option: $1" >&2; exit 2; } ;;
esac

if [ "$MODE" = "list" ]; then
  ls -lh z-cloudium-data-*.tar.gz 2>/dev/null || echo "No backup in $(pwd)."
  exit 0
fi

if ! docker volume inspect "$VOLUME" >/dev/null 2>&1; then
  echo "The volume '$VOLUME' does not exist." >&2
  echo "Name it with ./backup-data.sh <volume>, or set ZCLOUDIUM_DATA_VOLUME." >&2
  exit 1
fi

if [ "$MODE" = "backup" ]; then
  STAMP="$(date +%Y%m%d-%H%M%S)"
  OUT="z-cloudium-data-${STAMP}.tar.gz"
  echo "==> Backing up volume '$VOLUME' into ./$OUT"
  docker run --rm --network none \
    -v "$VOLUME:/data:ro" \
    -v "$PWD:/backup" \
    alpine:3.20 \
    tar -czf "/backup/$OUT" -C /data .
  echo "==> Done: $(du -h "$OUT" | cut -f1). It is not encrypted: store it accordingly."
  exit 0
fi

if [ ! -f "$FILE" ]; then
  echo "The backup '$FILE' was not found." >&2
  exit 1
fi
if [ "$(docker ps -q --filter volume="$VOLUME" | wc -l)" -gt 0 ]; then
  echo "A container is using the volume '$VOLUME' right now: stop it before restoring." >&2
  docker ps --filter volume="$VOLUME" --format '  {{.Names}}' >&2
  exit 1
fi

echo "==> Restoring '$FILE' into volume '$VOLUME' (its current content is replaced)"
# The filename crosses as an environment variable, never interpolated into the
# shell text, and the wipe is a find so no dotfile shape survives it.
docker run --rm --network none \
  -v "$VOLUME:/data" \
  -v "$PWD:/backup:ro" \
  -e BACKUP_FILE="$FILE" \
  alpine:3.20 \
  sh -c 'find /data -mindepth 1 -delete; tar -xzf "/backup/$BACKUP_FILE" -C /data'
echo "==> Done. Start the container again: the accounts, the sessions key and the certificate are back."
