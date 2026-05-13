#!/usr/bin/env bash
# =============================================================================
# test_server.sh  –  Production Readiness Test for Communicator (Server 1)
# Usage:  bash test_server.sh [HOST] [SECRET]
# Defaults: HOST=http://localhost:3000   SECRET=from .env
# =============================================================================

set -euo pipefail

HOST="${1:-http://localhost:3000}"
# Pull secret from .env if not passed as arg
SECRET="${2:-$(grep SHARED_SECRET_KEY "$(dirname "$0")/.env" 2>/dev/null | cut -d'=' -f2- | tr -d '"' || true)}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'

pass() { echo -e "${GREEN}  ✅ PASS${NC}  $1"; }
fail() { echo -e "${RED}  ❌ FAIL${NC}  $1"; FAILURES=$((FAILURES+1)); }
info() { echo -e "${YELLOW}  ──${NC} $1"; }

FAILURES=0

echo ""
echo "======================================================="
echo "  Communicator Production Readiness Test"
echo "  Target: $HOST"
echo "======================================================="
echo ""

# ---------------------------------------------------------------------------
# 1. Health endpoint
# ---------------------------------------------------------------------------
info "Test 1: GET /health → expect 200 + JSON"
STATUS=$(curl -s -o /tmp/comm_health.json -w "%{http_code}" "$HOST/health")
if [ "$STATUS" = "200" ]; then
    READY=$(cat /tmp/comm_health.json | grep -o '"ready":[a-z]*' | cut -d: -f2)
    DEPTH=$(cat /tmp/comm_health.json | grep -o '"queueDepth":[0-9]*' | cut -d: -f2)
    pass "/health returned 200  |  ready=$READY  queueDepth=$DEPTH"
else
    fail "/health returned HTTP $STATUS (expected 200)"
fi

# ---------------------------------------------------------------------------
# 2. Auth guard – missing secret
# ---------------------------------------------------------------------------
info "Test 2: POST /send-alert with NO secret → expect 403"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$HOST/send-alert" \
    -H "Content-Type: application/json" \
    -d '{"phone":"1234567890","message":"test"}')
[ "$STATUS" = "403" ] && pass "403 returned for missing secret" || fail "Expected 403, got $STATUS"

# ---------------------------------------------------------------------------
# 3. Auth guard – wrong secret
# ---------------------------------------------------------------------------
info "Test 3: POST /send-alert with WRONG secret → expect 403"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$HOST/send-alert" \
    -H "Content-Type: application/json" \
    -H "x-secret-key: wrong_secret_value" \
    -d '{"phone":"1234567890","message":"test"}')
[ "$STATUS" = "403" ] && pass "403 returned for wrong secret" || fail "Expected 403, got $STATUS"

# ---------------------------------------------------------------------------
# 4. Missing phone field
# ---------------------------------------------------------------------------
info "Test 4: POST /send-alert with missing 'phone' → expect 400"
STATUS=$(curl -s -o /tmp/comm_res.json -w "%{http_code}" -X POST "$HOST/send-alert" \
    -H "Content-Type: application/json" \
    -H "x-secret-key: $SECRET" \
    -d '{"message":"hello"}')
[ "$STATUS" = "400" ] && pass "400 returned for missing phone  |  body: $(cat /tmp/comm_res.json)" \
                       || fail "Expected 400, got $STATUS"

# ---------------------------------------------------------------------------
# 5. Missing message field
# ---------------------------------------------------------------------------
info "Test 5: POST /send-alert with missing 'message' → expect 400"
STATUS=$(curl -s -o /tmp/comm_res.json -w "%{http_code}" -X POST "$HOST/send-alert" \
    -H "Content-Type: application/json" \
    -H "x-secret-key: $SECRET" \
    -d '{"phone":"1234567890"}')
[ "$STATUS" = "400" ] && pass "400 returned for missing message  |  body: $(cat /tmp/comm_res.json)" \
                       || fail "Expected 400, got $STATUS"

# ---------------------------------------------------------------------------
# 6. @lid phone rejection
# ---------------------------------------------------------------------------
info "Test 6: POST /send-alert with @lid phone → expect 400"
STATUS=$(curl -s -o /tmp/comm_res.json -w "%{http_code}" -X POST "$HOST/send-alert" \
    -H "Content-Type: application/json" \
    -H "x-secret-key: $SECRET" \
    -d '{"phone":"249241297522744@lid","message":"hello"}')
[ "$STATUS" = "400" ] && pass "400 returned for @lid JID  |  body: $(cat /tmp/comm_res.json)" \
                       || fail "Expected 400, got $STATUS"

# ---------------------------------------------------------------------------
# 7. Oversized payload (>64 KB) – should be rejected by Express body parser
# ---------------------------------------------------------------------------
info "Test 7: POST /send-alert with 70 KB body → expect 413"
BIG_MSG=$(python3 -c "print('A'*71680)")
STATUS=$(curl -s -o /tmp/comm_res.json -w "%{http_code}" -X POST "$HOST/send-alert" \
    -H "Content-Type: application/json" \
    -H "x-secret-key: $SECRET" \
    -d "{\"phone\":\"1234567890\",\"message\":\"$BIG_MSG\"}")
[ "$STATUS" = "413" ] && pass "413 returned for oversized payload" \
                       || fail "Expected 413, got $STATUS (body: $(cat /tmp/comm_res.json))"

# ---------------------------------------------------------------------------
# 8. Malformed JSON body
# ---------------------------------------------------------------------------
info "Test 8: POST /send-alert with malformed JSON → expect 400"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$HOST/send-alert" \
    -H "Content-Type: application/json" \
    -H "x-secret-key: $SECRET" \
    --data-raw 'this is not json')
[ "$STATUS" = "400" ] && pass "400 returned for malformed JSON" || fail "Expected 400, got $STATUS"

# ---------------------------------------------------------------------------
# 9. Numeric phone field (type safety)
# ---------------------------------------------------------------------------
info "Test 9: POST /send-alert with phone as a NUMBER (not string) → expect 400"
STATUS=$(curl -s -o /tmp/comm_res.json -w "%{http_code}" -X POST "$HOST/send-alert" \
    -H "Content-Type: application/json" \
    -H "x-secret-key: $SECRET" \
    -d '{"phone":1234567890,"message":"hello"}')
[ "$STATUS" = "400" ] && pass "400 returned for numeric phone  |  body: $(cat /tmp/comm_res.json)" \
                       || fail "Expected 400, got $STATUS"

# ---------------------------------------------------------------------------
# 10. Load test – 50 rapid /health requests (smoke test for event-loop stall)
# ---------------------------------------------------------------------------
info "Test 10: 50 concurrent GET /health requests (event-loop smoke test)"
for i in $(seq 1 50); do
    curl -s -o /dev/null "$HOST/health" &
done
wait
pass "50 concurrent /health requests completed without hanging"

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "======================================================="
if [ "$FAILURES" -eq 0 ]; then
    echo -e "${GREEN}  ALL TESTS PASSED – Server is production-ready ✅${NC}"
else
    echo -e "${RED}  $FAILURES TEST(S) FAILED ❌${NC}"
fi
echo "======================================================="
echo ""
exit $FAILURES
