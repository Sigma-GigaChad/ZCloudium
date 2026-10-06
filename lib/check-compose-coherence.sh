# Shared helper: parse a compose file and assert the workspace/home coherence.
#
# Source this file, then call assert_compose_profile "<file>". The function
# exits 1 with a clear message when the file drifts: a leftover `command:`
# block, or HOME / ZCODE_DATA_BASE_DIR / ZCODE_SERVER_WORKSPACE missing or
# disagreeing on the path.
#
# On success it prints three lines and exports:
#   COMPOSE_HOME=<path>
#   COMPOSE_WORKSPACE=<path>
#   COMPOSE_IMAGE=<image>
# so the caller can start its throwaway container from what the file declares,
# not from literals in the script.

assert_compose_profile() {
  local compose_file="$1"
  local workspace_must_match_home="${2:-true}"
  local json

  if [ ! -f "$compose_file" ]; then
    echo "FAIL: compose file '$compose_file' not found" >&2
    return 1
  fi

  json=$(docker compose -f "$compose_file" config --format json 2>/dev/null) || {
    echo "FAIL: docker compose could not parse '$compose_file'" >&2
    return 1
  }

  local env_block command_val home_val data_dir_val workspace_val image_val
  env_block=$(printf '%s' "$json" | jq -r '.services["z-cloudium"].environment // {}')
  command_val=$(printf '%s' "$json" | jq -r '.services["z-cloudium"].command // empty')
  image_val=$(printf '%s' "$json" | jq -r '.services["z-cloudium"].image // empty')

  echo "==> Asserting '$compose_file' declares what it promises"

  local failed=0

  echo -n "  1. no leftover command: block (the entrypoint ignores it): "
  if [ -n "$command_val" ] && [ "$command_val" != "null" ]; then
    echo "FAIL (command: '$command_val' present; the entrypoint would ignore it and the agent would fall back to the image default workspace)"
    failed=1
  else
    echo "OK"
  fi

  home_val=$(printf '%s' "$env_block" | jq -r '.HOME // empty')
  data_dir_val=$(printf '%s' "$env_block" | jq -r '.ZCODE_DATA_BASE_DIR // empty')
  workspace_val=$(printf '%s' "$env_block" | jq -r '.ZCODE_SERVER_WORKSPACE // empty')

  echo -n "  2. HOME present: "
  if [ -z "$home_val" ]; then
    echo "FAIL (missing)"
    failed=1
  else
    echo "OK ($home_val)"
  fi

  echo -n "  3. ZCODE_DATA_BASE_DIR present: "
  if [ -z "$data_dir_val" ]; then
    echo "FAIL (missing)"
    failed=1
  else
    echo "OK ($data_dir_val)"
  fi

  echo -n "  4. ZCODE_SERVER_WORKSPACE present: "
  if [ -z "$workspace_val" ]; then
    echo "FAIL (missing; the image default /workspace would win and die with the container on this profile)"
    failed=1
  else
    echo "OK ($workspace_val)"
  fi

  echo -n "  5. HOME and ZCODE_DATA_BASE_DIR agree: "
  if [ -n "$home_val" ] && [ -n "$data_dir_val" ] && [ "$home_val" = "$data_dir_val" ]; then
    echo "OK (both '$home_val')"
  else
    echo "FAIL (HOME='$home_val' ZCODE_DATA_BASE_DIR='$data_dir_val')"
    failed=1
  fi

  if [ "$workspace_must_match_home" = "true" ]; then
    echo -n "  6. ZCODE_SERVER_WORKSPACE matches HOME (required on full access): "
    if [ -n "$workspace_val" ] && [ "$workspace_val" = "$home_val" ]; then
      echo "OK (all three point at '$home_val')"
    else
      echo "FAIL (HOME='$home_val' ZCODE_SERVER_WORKSPACE='$workspace_val')"
      failed=1
    fi
  else
    echo "  6. ZCODE_SERVER_WORKSPACE present (may differ from HOME on restricted profile): OK ($workspace_val)"
  fi

  if [ "$failed" != 0 ]; then
    return 1
  fi

  COMPOSE_HOME="$home_val"
  COMPOSE_WORKSPACE="$workspace_val"
  COMPOSE_IMAGE="$image_val"
  export COMPOSE_HOME COMPOSE_WORKSPACE COMPOSE_IMAGE
  return 0
}
