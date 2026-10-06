#!/usr/bin/env bash
#
# Compares the pinned version (zcode.version) with the latest published release
# and reports available updates.
#
#   ./check-upstream.sh            -> up to date? (exit 0) or update available? (exit 1)
#   ./check-upstream.sh --bump     -> updates zcode.version + zcode.sha256, without building
#   ./check-upstream.sh --build    -> --bump, then ./build.sh
#   REPO=zai-org/ZCode ./check-upstream.sh    -> watch the original upstream instead
#
# No dependency (no jq, no node): curl, grep, cut and sed are enough. Meant for
# a cron job.

set -euo pipefail
cd "$(dirname "$0")"

REPO="${REPO:-ZCodium-project/ZCodium}"
MODE="check"

for arg in "$@"; do
  case "$arg" in
    --bump) MODE="bump" ;;
    --build) MODE="build" ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

CURRENT="$(tr -d '[:space:]' < zcode.version)"
RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")"
LATEST="$(printf '%s' "$RELEASE_JSON" | grep -o '"tag_name": *"[^"]*"' | head -n 1 | cut -d '"' -f 4)"

if [ -z "$LATEST" ]; then
  echo "Cannot read the latest release of $REPO." >&2
  exit 2
fi

if [ "$CURRENT" = "$LATEST" ]; then
  echo "Up to date: $CURRENT ($REPO)"
  exit 0
fi

echo "Update available on $REPO: $CURRENT -> $LATEST"

if [ "$MODE" = "check" ]; then
  echo "To bump: ./check-upstream.sh --bump"
  exit 1
fi

## Fetches the official sha256 of the release and pins it in the repository.
TARBALL="zcodium-${LATEST#v}.tar.gz"
SHA_URL="https://github.com/${REPO}/releases/download/${LATEST}/sha256.txt"
SHA="$(curl -fsSL "$SHA_URL" | grep -F "$TARBALL" | awk '{print $1}' | head -n 1)"

if [ -z "$SHA" ]; then
  echo "no sha256 found for $TARBALL in $SHA_URL" >&2
  exit 2
fi

printf '%s\n' "$LATEST" > zcode.version
printf '%s\n' "$SHA" > zcode.sha256

echo "zcode.version -> $LATEST"
echo "zcode.sha256  -> $SHA"

if [ "$MODE" = "build" ]; then
  ./build.sh
fi
