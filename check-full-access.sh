#!/usr/bin/env bash
#
# Checks that a container started with full access really sees the whole
# filesystem of the VM and behaves as root inside it. Run it ON the VM (or
# through `wsl -e bash`).
#
#   ./check-full-access.sh
#
# The test container is disposable (--rm) and is never exposed on the network:
# the entrypoint is replaced by bash, so no web server is started.
#
# The compose file is parsed first: HOME, ZCODE_DATA_BASE_DIR and the image are
# read from what compose.full-access.yml declares, so a regression that removes
# a variable from the file fails here instead of being masked by a literal.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/check-compose-coherence.sh
source "${SCRIPT_DIR}/lib/check-compose-coherence.sh"

COMPOSE_FILE="${SCRIPT_DIR}/compose.full-access.yml"
assert_compose_profile "$COMPOSE_FILE" || exit 1

FAKE_HOME_DIR="/tmp/zcode-access-check-home"
TEST_REPO="/tmp/zcode-access-check-repo"

## Setup: a fake $HOME holding a .zcode, and a git repository owned by a uid
## other than root (to trigger the "dubious ownership" protection of git).
mkdir -p "${FAKE_HOME_DIR}/.zcode/skills/demo"
echo "test skill" > "${FAKE_HOME_DIR}/.zcode/skills/demo/SKILL.md"
mkdir -p "$TEST_REPO"
git -C "$TEST_REPO" init -q 2>/dev/null || true
chown -R 1234:1234 "$TEST_REPO" 2>/dev/null || true

## Map the file's declared home (/host/home/delta) to our throwaway directory.
DECLARED_HOME="${COMPOSE_HOME#/host}"
mkdir -p "$(dirname "${DECLARED_HOME}")" 2>/dev/null || true

echo
echo "==> Testing image ${COMPOSE_IMAGE} (user=root, / mounted on /host)"
echo "    HOME=${COMPOSE_HOME}, ZCODE_DATA_BASE_DIR=${COMPOSE_HOME}"
echo

docker run --rm \
  --user root \
  -v /:/host \
  -v "${FAKE_HOME_DIR}:${DECLARED_HOME}" \
  -e "HOME=${COMPOSE_HOME}" \
  -e "ZCODE_DATA_BASE_DIR=${COMPOSE_HOME}" \
  -e "REPO=/host${TEST_REPO}" \
  --entrypoint bash \
  "${COMPOSE_IMAGE}" -c '
    echo "uid in the container: $(id -u) ($(id -un))"

    echo -n "reading /host/etc/shadow (root only): "
    if head -c 12 /host/etc/shadow >/dev/null 2>&1; then
      echo "OK (root confirmed)"
    else
      echo "REFUSED"
    fi

    echo -n "writing into /host/tmp: "
    if touch /host/tmp/zcode-write-check && rm -f /host/tmp/zcode-write-check; then
      echo "OK"
    else
      echo "REFUSED"
    fi

    echo -n "HOME/.zcode visible (skills): "
    ls "$HOME/.zcode/skills" 2>/dev/null | tr "\n" " "
    echo

    echo -n "git without the workaround: "
    if git -C "$REPO" status >/dev/null 2>&1; then
      echo "passes (no owner conflict)"
    else
      echo "FAILS (dubious ownership protection)"
    fi

    echo -n "git with GIT_CONFIG_*: "
    if GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0="*" \
       git -C "$REPO" status >/dev/null 2>&1; then
      echo "OK"
    else
      echo "FAILS"
    fi
  '

## Cleanup of the test setup.
rm -rf "$FAKE_HOME_DIR" "$TEST_REPO"
