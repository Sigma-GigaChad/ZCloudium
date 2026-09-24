#!/usr/bin/env bash
#
# Compare la version épinglée (zcode.version) avec la dernière release publiée,
# et signale les mises à jour disponibles.
#
#   ./check-upstream.sh            -> à jour ? (exit 0) ou mise à jour dispo ? (exit 1)
#   ./check-upstream.sh --bump     -> met à jour zcode.version + zcode.sha256, sans builder
#   ./check-upstream.sh --build    -> --bump puis ./build.sh
#   REPO=zai-org/ZCode ./check-upstream.sh    -> surveiller l'amont d'origine à la place
#
# Aucune dépendance (ni jq, ni node) : curl, grep, cut et sed suffisent.
# Pensé pour un cron.

set -euo pipefail
cd "$(dirname "$0")"

REPO="${REPO:-ZCodium-project/ZCodium}"
MODE="check"

for arg in "$@"; do
  case "$arg" in
    --bump) MODE="bump" ;;
    --build) MODE="build" ;;
    -h|--help) sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Option inconnue : $arg" >&2; exit 2 ;;
  esac
done

CURRENT="$(tr -d '[:space:]' < zcode.version)"
RELEASE_JSON="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest")"
LATEST="$(printf '%s' "$RELEASE_JSON" | grep -o '"tag_name": *"[^"]*"' | head -n 1 | cut -d '"' -f 4)"

if [ -z "$LATEST" ]; then
  echo "Impossible de lire la dernière release de $REPO." >&2
  exit 2
fi

if [ "$CURRENT" = "$LATEST" ]; then
  echo "À jour : $CURRENT ($REPO)"
  exit 0
fi

echo "Mise à jour disponible sur $REPO : $CURRENT -> $LATEST"

if [ "$MODE" = "check" ]; then
  echo "Pour bumper : ./check-upstream.sh --bump"
  exit 1
fi

## Récupère le sha256 officiel de la release et l'épingle dans le repo.
TARBALL="zcodium-${LATEST#v}.tar.gz"
SHA_URL="https://github.com/${REPO}/releases/download/${LATEST}/sha256.txt"
SHA="$(curl -fsSL "$SHA_URL" | grep -F "$TARBALL" | awk '{print $1}' | head -n 1)"

if [ -z "$SHA" ]; then
  echo "sha256 introuvable pour $TARBALL dans $SHA_URL" >&2
  exit 2
fi

printf '%s\n' "$LATEST" > zcode.version
printf '%s\n' "$SHA" > zcode.sha256

echo "zcode.version -> $LATEST"
echo "zcode.sha256  -> $SHA"

if [ "$MODE" = "build" ]; then
  ./build.sh
fi
