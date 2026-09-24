#!/usr/bin/env bash
#
# Vérifie qu'un conteneur lancé en accès total voit réellement tout le FS de la
# VM et s'y comporte en root. À lancer SUR LA VM (ou via `wsl -e bash`).
#
#   ./check-full-access.sh
#
# Le conteneur de test est jetable (--rm) et n'est jamais exposé sur le réseau :
# l'entrypoint est remplacé par bash, donc aucun serveur web n'est démarré.

set -euo pipefail

IMAGE="${IMAGE:-ghcr.io/sigma-gigachad/z-cloudium:latest}"
FAKE_HOME="/tmp/zcode-access-check-home"
TEST_REPO="/tmp/zcode-access-check-repo"

## Décor : un faux $HOME contenant un .zcode, et un dépôt git appartenant à un
## autre uid que root (pour déclencher la protection « dubious ownership » de git).
mkdir -p "${FAKE_HOME}/.zcode/skills/demo"
echo "skill de test" > "${FAKE_HOME}/.zcode/skills/demo/SKILL.md"
mkdir -p "$TEST_REPO"
git -C "$TEST_REPO" init -q 2>/dev/null || true
chown -R 1234:1234 "$TEST_REPO" 2>/dev/null || true

echo "==> Test de l'image $IMAGE (user=root, / monté sur /host)"
echo

docker run --rm \
  --user root \
  -v /:/host \
  -e "HOME=/host${FAKE_HOME}" \
  -e "ZCODE_DATA_BASE_DIR=/host${FAKE_HOME}" \
  -e "REPO=/host${TEST_REPO}" \
  --entrypoint bash \
  "$IMAGE" -c '
    echo "uid dans le conteneur : $(id -u) ($(id -un))"

    echo -n "lecture de /host/etc/shadow (root seul) : "
    if head -c 12 /host/etc/shadow >/dev/null 2>&1; then
      echo "OK (root confirme)"
    else
      echo "REFUSE"
    fi

    echo -n "ecriture dans /host/tmp : "
    if touch /host/tmp/zcode-write-check && rm -f /host/tmp/zcode-write-check; then
      echo "OK"
    else
      echo "REFUSE"
    fi

    echo -n "HOME/.zcode visible (skills) : "
    ls "$HOME/.zcode/skills" 2>/dev/null | tr "\n" " "
    echo

    echo -n "git sans correctif : "
    if git -C "$REPO" status >/dev/null 2>&1; then
      echo "passe (aucun conflit de proprietaire)"
    else
      echo "ECHOUE (protection dubious ownership)"
    fi

    echo -n "git avec GIT_CONFIG_* : "
    if GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*" \
       git -C "$REPO" status >/dev/null 2>&1; then
      echo "OK"
    else
      echo "ECHOUE"
    fi
  '

## Nettoyage du décor de test.
rm -rf "$FAKE_HOME" "$TEST_REPO"
