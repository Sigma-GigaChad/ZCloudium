#!/usr/bin/env bash
#
# Construit l'image ZCode Web depuis le runtime précompilé épinglé.
#
#   ./build.sh                 -> zcode-web:3.14.3 + zcode-web:latest
#   ./build.sh --push          -> idem, puis push vers le registry configuré
#   IMAGE=ghcr.io/moi/zcode ./build.sh --push
#   RUNTIME_URL=<autre tarball> ./build.sh
#
# Ni pnpm, ni Node, ni aucune dépendance de build n'est nécessaire sur la machine
# qui lance ce script : l'image ne fait que télécharger, vérifier et extraire.

set -euo pipefail
cd "$(dirname "$0")"

VERSION_TAG="$(tr -d '[:space:]' < zcode.version)"
EXPECTED_SHA="$(tr -d '[:space:]' < zcode.sha256)"
IMAGE="${IMAGE:-zcode-web}"
RUNTIME_URL="${RUNTIME_URL:-https://github.com/ZCodium-project/ZCodium/releases/download/${VERSION_TAG}/zcodium-${VERSION_TAG#v}.tar.gz}"

PUSH=0
for arg in "$@"; do
  case "$arg" in
    --push) PUSH=1 ;;
    -h|--help) sed -n '2,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Option inconnue : $arg" >&2; exit 2 ;;
  esac
done

if [ -z "$VERSION_TAG" ] || [ -z "$EXPECTED_SHA" ]; then
  echo "zcode.version ou zcode.sha256 est vide." >&2
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

echo "==> Image $IMAGE:$VERSION construite."

if [ "$PUSH" = 1 ]; then
  docker push "$IMAGE:$VERSION"
  docker push "$IMAGE:latest"
  echo "==> Poussée vers le registry."
fi
