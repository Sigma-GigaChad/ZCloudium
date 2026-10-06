#!/usr/bin/env bash
#
# Proves that the compose coherence checks catch regressions by breaking each
# file in turn and showing the check fails for the right reason.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."

# shellcheck source=lib/check-compose-coherence.sh
source lib/check-compose-coherence.sh

echo "=========================================="
echo "TEST 1: compose.full-access.yml - remove ZCODE_SERVER_WORKSPACE"
echo "=========================================="
cp compose.full-access.yml compose.full-access.yml.test
sed -i '/ZCODE_SERVER_WORKSPACE:/d' compose.full-access.yml.test
echo "Running check on broken file..."
OUTPUT=$(assert_compose_profile compose.full-access.yml.test 2>&1 || true)
echo "$OUTPUT"
if echo "$OUTPUT" | grep -q "ZCODE_SERVER_WORKSPACE present: FAIL"; then
  echo "✓ Check correctly detected missing ZCODE_SERVER_WORKSPACE"
  RESULT1="PASS"
else
  echo "✗ Check did not detect the issue"
  RESULT1="FAIL"
fi
rm -f compose.full-access.yml.test

echo
echo "=========================================="
echo "TEST 2: compose.full-access.yml - add leftover command: block"
echo "=========================================="
cp compose.full-access.yml compose.full-access.yml.test
# Add a command: block before cap_add
sed -i '/cap_add:/i \    command: ["--workspace", "/wrong/path"]' compose.full-access.yml.test
echo "Running check on broken file..."
OUTPUT=$(assert_compose_profile compose.full-access.yml.test 2>&1 || true)
echo "$OUTPUT"
if echo "$OUTPUT" | grep -q "no leftover command: block.*FAIL"; then
  echo "✓ Check correctly detected leftover command: block"
  RESULT2="PASS"
else
  echo "✗ Check did not detect the issue"
  RESULT2="FAIL"
fi
rm -f compose.full-access.yml.test

echo
echo "=========================================="
echo "TEST 3: compose.yml - remove ZCODE_SERVER_WORKSPACE"
echo "=========================================="
cp compose.yml compose.yml.test
sed -i '/ZCODE_SERVER_WORKSPACE:/d' compose.yml.test
echo "Running check on broken file..."
OUTPUT=$(assert_compose_profile compose.yml.test false 2>&1 || true)
echo "$OUTPUT"
if echo "$OUTPUT" | grep -q "ZCODE_SERVER_WORKSPACE present: FAIL"; then
  echo "✓ Check correctly detected missing ZCODE_SERVER_WORKSPACE"
  RESULT3="PASS"
else
  echo "✗ Check did not detect the issue"
  RESULT3="FAIL"
fi
rm -f compose.yml.test

echo
echo "=========================================="
echo "TEST 4: compose.full-access.yml - mismatched workspace path"
echo "=========================================="
cp compose.full-access.yml compose.full-access.yml.test
# Change ZCODE_SERVER_WORKSPACE to a different path
sed -i 's|ZCODE_SERVER_WORKSPACE: /host/home/delta|ZCODE_SERVER_WORKSPACE: /host/home/other|' compose.full-access.yml.test
echo "Running check on broken file..."
OUTPUT=$(assert_compose_profile compose.full-access.yml.test 2>&1 || true)
echo "$OUTPUT"
if echo "$OUTPUT" | grep -q "ZCODE_SERVER_WORKSPACE matches HOME.*FAIL"; then
  echo "✓ Check correctly detected mismatched workspace path"
  RESULT4="PASS"
else
  echo "✗ Check did not detect the issue"
  RESULT4="FAIL"
fi
rm -f compose.full-access.yml.test

echo
echo "=========================================="
echo "TEST 5: compose.yml - mismatched HOME and ZCODE_DATA_BASE_DIR"
echo "=========================================="
cp compose.yml compose.yml.test
# Change HOME to a different path
sed -i 's|HOME: /data|HOME: /different|' compose.yml.test
echo "Running check on broken file..."
OUTPUT=$(assert_compose_profile compose.yml.test false 2>&1 || true)
echo "$OUTPUT"
if echo "$OUTPUT" | grep -q "HOME and ZCODE_DATA_BASE_DIR agree: FAIL"; then
  echo "✓ Check correctly detected mismatched HOME and ZCODE_DATA_BASE_DIR"
  RESULT5="PASS"
else
  echo "✗ Check did not detect the issue"
  RESULT5="FAIL"
fi
rm -f compose.yml.test

echo
echo "=========================================="
echo "SUMMARY"
echo "=========================================="
echo "Test 1 (full-access - missing ZCODE_SERVER_WORKSPACE): $RESULT1"
echo "Test 2 (full-access - leftover command: block): $RESULT2"
echo "Test 3 (restricted - missing ZCODE_SERVER_WORKSPACE): $RESULT3"
echo "Test 4 (full-access - mismatched workspace path): $RESULT4"
echo "Test 5 (restricted - mismatched HOME/ZCODE_DATA_BASE_DIR): $RESULT5"

if [ "$RESULT1" = "PASS" ] && [ "$RESULT2" = "PASS" ] && [ "$RESULT3" = "PASS" ] && [ "$RESULT4" = "PASS" ] && [ "$RESULT5" = "PASS" ]; then
  echo
  echo "✓ All tests passed: the checks catch the regressions they are meant to catch."
  exit 0
else
  echo
  echo "✗ Some tests failed."
  exit 1
fi
