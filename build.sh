#!/usr/bin/env bash
#
# Builds the ZCode Web image: the runtime compiled from the pinned ZCodium
# sources with the patch series in patches/ (Remote SSH from the web client,
# Cloud Environments). This is the product build, the one CI publishes.
#
#   ./build.sh                 -> ghcr.io/sigma-gigachad/z-cloudium:{<zcode.version>,latest}
#   ./build.sh --push          -> same, then push to the configured registry
#   ./build.sh --precompiled   -> the vendor tarball instead (no patch series,
#                                 no remote workspace features): the check
#                                 path, not the product
#   IMAGE=my-registry/z-cloudium ./build.sh --push
#
# The from-source path needs nothing but Docker (the compiler runs in the
# builder stage); a cold build takes about five minutes, then cache warmth
# applies. The precompiled path is kept because some checks still run it: it
# must never be pushed under the product tags.

set -euo pipefail
cd "$(dirname "$0")"

VERSION_TAG="$(tr -d '[:space:]' < zcode.version)"
EXPECTED_SHA="$(tr -d '[:space:]' < zcode.sha256)"
## Full lowercase name: GHCR requires it, and the compose files pull exactly the
## same reference, so a local build satisfies the compose files as is.
IMAGE="${IMAGE:-ghcr.io/sigma-gigachad/z-cloudium}"
RUNTIME_URL="${RUNTIME_URL:-https://github.com/ZCodium-project/ZCodium/releases/download/${VERSION_TAG}/zcodium-${VERSION_TAG#v}.tar.gz}"
FROM_SOURCE_REPO="${FROM_SOURCE_REPO:-https://github.com/ZCodium-project/ZCodium.git}"

PUSH=0
FROM_SOURCE=1
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    --from-source) FROM_SOURCE=1 ;;
    --precompiled) FROM_SOURCE=0 ;;
    -h|--help) sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ -z "$VERSION_TAG" ] || [ -z "$EXPECTED_SHA" ]; then
  echo "zcode.version or zcode.sha256 is empty." >&2
  exit 1
fi

VERSION="${VERSION_TAG#v}"

echo "==> $IMAGE:$VERSION"
if [ "$FROM_SOURCE" = 1 ]; then
  # The patch series is part of the product: a from-source build without it is
  # refused by the Dockerfile, and one without the pinned revision would not be
  # reproducible. Resolve the exact commit for the image's revision label.
  if [ -z "$(ls patches/*.patch 2>/dev/null)" ]; then
    echo "patches/ carries no .patch file; the from-source build would be a feature-less image." >&2
    exit 1
  fi
  # Annotated tags list a tag object sha first: resolve the peeled ref, and
  # fall back to the plain one for lightweight tags.
  ZCODE_COMMIT="$(git ls-remote "$FROM_SOURCE_REPO" "refs/tags/${VERSION_TAG}^{}" | awk '{print $1}')"
  ZCODE_COMMIT="${ZCODE_COMMIT:-$(git ls-remote "$FROM_SOURCE_REPO" "refs/tags/${VERSION_TAG}" | awk '{print $1}')}"
  if [ -z "$ZCODE_COMMIT" ]; then
    echo "Tag ${VERSION_TAG} not found on ${FROM_SOURCE_REPO}." >&2
    exit 1
  fi
  echo "    source  : $FROM_SOURCE_REPO @ ${VERSION_TAG} (${ZCODE_COMMIT:0:12})"
  echo "    patches : $(ls patches/*.patch | wc -l) file(s)"
  docker build \
    -f Dockerfile.from-source \
    --build-arg "ZCODE_REPO=$FROM_SOURCE_REPO" \
    --build-arg "ZCODE_REF=$VERSION_TAG" \
    --build-arg "ZCODE_COMMIT=$ZCODE_COMMIT" \
    --tag "$IMAGE:$VERSION" \
    --tag "$IMAGE:latest" \
    .
else
  # The tarball path must not ship under the product tags: it carries no patch
  # series, so a push here would replace the product with a feature-less
  # image. Local builds under the version tag are what the checks need.
  if [ "$PUSH" = 1 ]; then
    echo "Refusing to push a --precompiled build: it is the check path, not the product." >&2
    exit 1
  fi
  echo "    runtime : $RUNTIME_URL"
  echo "    sha256  : $EXPECTED_SHA"
  docker build \
    --build-arg "ZCODIUM_VERSION=$VERSION_TAG" \
    --build-arg "TARBALL_URL=$RUNTIME_URL" \
    --build-arg "TARBALL_SHA256=$EXPECTED_SHA" \
    --tag "$IMAGE:$VERSION" \
    .
fi

echo "==> Image $IMAGE:$VERSION built."

if [ "$PUSH" = 1 ]; then
  docker push "$IMAGE:$VERSION"
  docker push "$IMAGE:latest"
  echo "==> Pushed to the registry."
fi
