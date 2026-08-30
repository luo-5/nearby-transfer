#!/bin/bash
# WebDAV interop test script — exercises the DesktopLibraryService WebDAV API
# using curl. Starts a bootstrap server, mints a Bearer token, and issues
# standard WebDAV HTTP requests (PROPFIND/GET/PUT/DELETE/MKCOL/MOVE/OPTIONS).
#
# Run: bash scripts/interop-webdav.sh
#
# Requires: curl, node (v22+)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

passed=0
failed=0

ok() {
  local name="$1" cond="$2" detail="${3:-}"
  if [ "$cond" = "true" ] || [ "$cond" = "0" ]; then
    passed=$((passed + 1))
    echo "  [PASS] $name"
  else
    failed=$((failed + 1))
    echo "  [FAIL] $name${detail:+ — $detail}"
  fi
}

echo "WebDAV Interop Curl Test"
echo ""

# ── Start the bootstrap server ─────────────────────────────────────────────
BOOT_FILE="/tmp/nt-webdav-bootstrap-$$.out"
node "$SCRIPT_DIR/webdav-test-server.js" > "$BOOT_FILE" 2>/dev/null &
SERVER_PID=$!

# Wait for the server to print its readiness lines (up to 5s)
for i in $(seq 1 50); do
  if grep -q "^TOKEN=" "$BOOT_FILE" 2>/dev/null; then
    break
  fi
  sleep 0.1
done

PORT=$(grep "^PORT=" "$BOOT_FILE" 2>/dev/null | head -1 | cut -d= -f2)
TOKEN=$(grep "^TOKEN=" "$BOOT_FILE" 2>/dev/null | head -1 | cut -d= -f2)

cleanup() {
  kill "$SERVER_PID" 2>/dev/null || true
  rm -f "$BOOT_FILE"
}
trap cleanup EXIT

if [ -z "$PORT" ] || [ -z "$TOKEN" ]; then
  echo "FATAL: Could not start bootstrap server or read PORT/TOKEN"
  cat "$BOOT_FILE" 2>/dev/null || true
  exit 1
fi

BASE_URL="https://127.0.0.1:${PORT}"
AUTH="Authorization: Bearer ${TOKEN}"

echo "  Server: ${BASE_URL}/docs/  (PID=${SERVER_PID})"
echo ""

# Helper: get HTTP status code
status() { curl -ks -o /dev/null -w "%{http_code}" "$@"; }
# Helper: get response body
body()   { curl -ks "$@"; }

# ── Test 1: OPTIONS ────────────────────────────────────────────────────────
OPT_HEADERS=$(curl -ksI -X OPTIONS -H "$AUTH" "${BASE_URL}/docs/" 2>/dev/null || true)
ok "OPTIONS returns 200" "$(echo "$OPT_HEADERS" | grep -ci '^HTTP/.* 200' >/dev/null 2>&1 && echo true || echo false)"
ALLOW=$(echo "$OPT_HEADERS" | grep -i '^Allow:' | tr -d '\r')
ok "OPTIONS Allow includes MKCOL" "$(echo "$ALLOW" | grep -qi MKCOL && echo true || echo false)" "$ALLOW"
ok "OPTIONS Allow includes DELETE" "$(echo "$ALLOW" | grep -qi DELETE && echo true || echo false)" "$ALLOW"
ok "OPTIONS Allow includes MOVE" "$(echo "$ALLOW" | grep -qi MOVE && echo true || echo false)" "$ALLOW"
# ── Test 2: PROPFIND root (Depth: 1) ───────────────────────────────────────
PF_ROOT=$(body -X PROPFIND -H "$AUTH" -H "Depth: 1" "${BASE_URL}/docs/")
PF_ROOT_CODE=$(status -X PROPFIND -H "$AUTH" -H "Depth: 1" "${BASE_URL}/docs/")
ok "PROPFIND root returns 207" "$([ "$PF_ROOT_CODE" = "207" ] && echo true || echo false)" "got $PF_ROOT_CODE"
ok "PROPFIND root has displayname" "$(echo "$PF_ROOT" | grep -qi 'displayname' && echo true || echo false)"
ok "PROPFIND root has getcontentlength" "$(echo "$PF_ROOT" | grep -qi 'getcontentlength' && echo true || echo false)"
ok "PROPFIND root has getetag" "$(echo "$PF_ROOT" | grep -qi 'getetag' && echo true || echo false)"
ok "PROPFIND root lists hello.txt" "$(echo "$PF_ROOT" | grep -qi 'hello.txt' && echo true || echo false)"

# ── Test 3: PROPFIND subdirectory ──────────────────────────────────────────
PF_SUB=$(body -X PROPFIND -H "$AUTH" -H "Depth: 1" "${BASE_URL}/docs/subfolder/")
ok "PROPFIND subdir lists nested.txt" "$(echo "$PF_SUB" | grep -qi 'nested.txt' && echo true || echo false)"

# ── Test 4: PROPFIND Depth: 0 omits children ───────────────────────────────
PF_D0=$(body -X PROPFIND -H "$AUTH" -H "Depth: 0" "${BASE_URL}/docs/")
ok "PROPFIND Depth:0 omits hello.txt" "$(! echo "$PF_D0" | grep -qi 'hello.txt' && echo true || echo false)"

# ── Test 5: GET file ────────────────────────────────────────────────────────
GET_BODY=$(body -H "$AUTH" "${BASE_URL}/docs/hello.txt")
ok "GET file content matches" "$([ "$GET_BODY" = "Hello WebDAV World" ] && echo true || echo false)" "$GET_BODY"
GET_HEADERS=$(curl -ksI -H "$AUTH" "${BASE_URL}/docs/hello.txt" 2>/dev/null || true)
ok "GET returns Accept-Ranges" "$(echo "$GET_HEADERS" | grep -qi 'accept-ranges' && echo true || echo false)"
ok "GET returns ETag" "$(echo "$GET_HEADERS" | grep -qi 'etag' && echo true || echo false)"

# ── Test 6: PUT upload ─────────────────────────────────────────────────────
PUT_CODE=$(curl -ks -o /dev/null -w "%{http_code}" -X PUT -H "$AUTH" -d 'Uploaded via curl WebDAV' "${BASE_URL}/docs/curl-upload.txt")
ok "PUT upload returns 201" "$([ "$PUT_CODE" = "201" ] && echo true || echo false)" "got $PUT_CODE"
GET_UPLOADED=$(body -H "$AUTH" "${BASE_URL}/docs/curl-upload.txt")
ok "PUT file content round-trips" "$([ "$GET_UPLOADED" = "Uploaded via curl WebDAV" ] && echo true || echo false)" "$GET_UPLOADED"

# ── Test 7: MKCOL ───────────────────────────────────────────────────────────
MKCOL_CODE=$(curl -ks -o /dev/null -w "%{http_code}" -X MKCOL -H "$AUTH" "${BASE_URL}/docs/curl-dir/")
ok "MKCOL returns 201" "$([ "$MKCOL_CODE" = "201" ] && echo true || echo false)" "got $MKCOL_CODE"

# ── Test 8: MOVE ────────────────────────────────────────────────────────────
MOVE_CODE=$(curl -ks -o /dev/null -w "%{http_code}" -X MOVE -H "$AUTH" -H "Destination: ${BASE_URL}/docs/curl-moved.txt" -H "Overwrite: T" "${BASE_URL}/docs/curl-upload.txt")
ok "MOVE returns 201/204" "$([ "$MOVE_CODE" = "201" ] || [ "$MOVE_CODE" = "204" ] && echo true || echo false)" "got $MOVE_CODE"
ok "MOVE destination accessible" "$([ "$(status -H "$AUTH" "${BASE_URL}/docs/curl-moved.txt")" = "200" ] && echo true || echo false)"

# ── Test 9: DELETE ──────────────────────────────────────────────────────────
DEL_CODE=$(curl -ks -o /dev/null -w "%{http_code}" -X DELETE -H "$AUTH" "${BASE_URL}/docs/curl-moved.txt")
ok "DELETE returns 204" "$([ "$DEL_CODE" = "204" ] && echo true || echo false)" "got $DEL_CODE"

# ── Test 10: URL encoding — Chinese filename ────────────────────────────────
CN_NAME="%E6%B5%8B%E8%AF%95%E6%96%87%E4%BB%B6.txt"
CN_PUT=$(curl -ks -o /dev/null -w "%{http_code}" -X PUT -H "$AUTH" -d 'Chinese content' "${BASE_URL}/docs/${CN_NAME}")
ok "PUT Chinese filename returns 201" "$([ "$CN_PUT" = "201" ] && echo true || echo false)" "got $CN_PUT"
CN_GET=$(body -H "$AUTH" "${BASE_URL}/docs/${CN_NAME}")
ok "GET Chinese filename content matches" "$([ "$CN_GET" = "Chinese content" ] && echo true || echo false)" "$CN_GET"
CN_PF=$(body -X PROPFIND -H "$AUTH" -H "Depth: 1" "${BASE_URL}/docs/")
ok "PROPFIND root lists encoded Chinese href" "$(echo "$CN_PF" | grep -qi "$CN_NAME" && echo true || echo false)"

# ── Test 11: Unauthorized returns 401 ───────────────────────────────────────
UNAUTH_CODE=$(curl -ks -o /dev/null -w "%{http_code}" -X PROPFIND -H "Depth: 1" "${BASE_URL}/docs/")
ok "Unauthenticated PROPFIND returns 401" "$([ "$UNAUTH_CODE" = "401" ] && echo true || echo false)" "got $UNAUTH_CODE"

# ── Test 12: Path traversal blocked ─────────────────────────────────────────
# Use --path-as-is so curl sends the literal ../ segments without normalizing
TRAVERSE_CODE=$(curl -ks --path-as-is -o /dev/null -w "%{http_code}" -H "$AUTH" "${BASE_URL}/docs/../../../etc/passwd")
ok "Path traversal returns 403" "$([ "$TRAVERSE_CODE" = "403" ] && echo true || echo false)" "got $TRAVERSE_CODE"

echo ""
echo "  Results: $passed passed, $failed failed"
if [ "$failed" -gt 0 ]; then
  exit 1
fi
echo "  ALL WEBDAV CURL INTEROP TESTS PASSED"
