#!/usr/bin/env bash
#
# Verifies that compose.yml declares the restricted profile correctly: no
# leftover command: block, HOME/ZCODE_DATA_BASE_DIR/ZCODE_SERVER_WORKSPACE all
# present, and the home/data directory coherent.
#
#   ./check-restricted.sh
#
# Unlike check-full-access.sh, this script does not start a
# container: the restricted profile runs as an unprivileged user with a
# read-only rootfs and named volumes, so the runtime probes would require a
# full setup wizard run. The static assertion is enough to catch the drift the
# other two checks catch: a missing ZCODE_SERVER_WORKSPACE, or a leftover
# command: block that the entrypoint would ignore.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/check-compose-coherence.sh
source "${SCRIPT_DIR}/lib/check-compose-coherence.sh"

COMPOSE_FILE="${SCRIPT_DIR}/compose.yml"
## On the restricted profile, ZCODE_SERVER_WORKSPACE (/workspace) is a named
## volume and may differ from HOME (/data), so the three-way equality check is
## relaxed: HOME must equal ZCODE_DATA_BASE_DIR, and WORKSPACE must be present.
assert_compose_profile "$COMPOSE_FILE" false || exit 1

echo
echo "==> compose.yml is coherent."
