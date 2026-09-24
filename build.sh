#!/usr/bin/env bash
#
# Builds the ZCode Web image from the pinned precompiled runtime.
#
#   ./build.sh                 -> ghcr.io/sigma-gigachad/z-cloudium:{3.14.3,latest}
#   ./build.sh --push          -> same, then push to the configured registry
#   IMAGE=my-registry/z-cloudium ./build.sh --push
#   RUNTIME_URL=<another tarball> ./build.sh
#
# Neither pnpm, nor Node, nor any build dependency is needed on the machine that
# runs this script: the image only downloads, verifies and extracts. Chromium,
# the fonts and the browser MCP server are installed by the Dockerfile itself.
#
# Nothing else is required: the arguments of the runtime, the addresses and the
# gateway are decided by the image entrypoint.

set -euo pipefail
cd "$(dirname "$0")"

VERSION_TAG="$(tr -d '[:space:]' < zcode.version)"
EXPECTED_SHA="$(tr -d '[:space:]' < zcode.sha256)"
## Full lowercase name: GHCR requires it, and the compose files pull exactly the
## same reference, so a local build satisfies the compose files as is.
IMAGE="${IMAGE:-ghcr.io/sigma-gigachad/z-cloudium}"
RUNTIME_URL="${RUNTIME_URL:-https://github.com/ZCodium-project/ZCodium/releases/download/${VERSION_TAG}/zcodium-${VERSION_TAG#v}.tar.gz}"

PUSH=0
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    -h|--help) sed -n '2,8p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ -z "$VERSION_TAG" ] || [ -z "$EXPECTED_SHA" ]; then
  echo "zcode.version or zcode.sha256 is empty." >&2
  exit 1
fi

VERSION="${VERSION_TAG#v}"

echo "==> $IMAGE:$VERSION"
echo "    runtime : $RUNTIME_URL"
echo "    sha256  : $EXPECTED_SHA"

docker build \
  --build-arg "ZCODIUM_VERSION=$VERSION_TAG" \
  --build-arg "TARBALL_URL=$RUNTIME_URL" \
  --build-arg "TARBALL_SHA256=$EXPECTED_SHA" \
  --tag "$IMAGE:$VERSION" \
  --tag "$IMAGE:latest" \
  .

echo "==> Image $IMAGE:$VERSION built."

if [ "$PUSH" = 1 ]; then
  docker push "$IMAGE:$VERSION"
  docker push "$IMAGE:latest"
  echo "==> Pushed to the registry."
fi
