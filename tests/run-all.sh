#!/usr/bin/env bash
# Runs every suite against a running server. Exits non-zero if anything fails.
set -uo pipefail
cd "$( dirname "${BASH_SOURCE[0]}" )/.."

HOST="${HOST:-http://127.0.0.1:8085}"
FAILED=0

echo "=============================================================="
echo " TestBox specs (unit + integration)"
echo "=============================================================="
OUT=$(curl -s -m 300 "$HOST/tests/runner.bxm?reporter=text")
echo "$OUT" | grep -E "^\[Passed:|Bundles/Suites/Specs" | tail -1
if echo "$OUT" | grep -qE "\[Failed: [1-9]|\[Errors: [1-9]"; then
	echo "$OUT" | grep -E "Failure:|Error:" | head -20
	FAILED=1
fi

echo
echo "=============================================================="
echo " Trigger API (HTTP, signed requests)"
echo "=============================================================="
./tests/api-cases.sh || FAILED=1

echo
echo "=============================================================="
echo " Admin console (access control, account management)"
echo "=============================================================="
./tests/admin-check.sh 2>&1 | grep -v "^Warning" || FAILED=1

echo
echo "=============================================================="
echo " Marketing site (public access, CTAs, live pricing)"
echo "=============================================================="
./tests/marketing-check.sh 2>&1 | grep -v "^Warning" || FAILED=1

echo
echo "=============================================================="
echo " Dashboard (sessions, tenant isolation, CRUD)"
echo "=============================================================="
./tests/dashboard-check.sh 2>&1 | grep -v "^Warning" || FAILED=1

echo
echo "=============================================================="
echo " Plan enforcement"
echo "=============================================================="
./tests/limits-and-auth.sh 2>&1 | grep -v "^Warning" || FAILED=1

echo
echo "=============================================================="
echo " STOMP over a real WebSocket"
echo "=============================================================="
node tests/stomp-check.mjs || FAILED=1

echo
echo "=============================================================="
echo " Server SDKs (publish, tokens, signature parity)"
echo "=============================================================="
node tests/sdk-check.mjs || FAILED=1

echo
echo "=============================================================="
echo " Documented code examples actually run"
echo "=============================================================="
node tests/docs-example-check.mjs || FAILED=1

echo
echo "=============================================================="
echo " Private-channel auth webhook"
echo "=============================================================="
node tests/auth-webhook-check.mjs || FAILED=1

echo
echo "=============================================================="
echo " Presence channels (rosters, joins, leaves)"
echo "=============================================================="
node tests/presence-check.mjs || FAILED=1

echo
echo "=============================================================="
echo " Client-published events (guardrails, rate limit)"
echo "=============================================================="
node tests/client-events-check.mjs || FAILED=1

echo
echo "=============================================================="
echo " Outbound event webhooks (delivery, signing, retries)"
echo "=============================================================="
node tests/webhook-check.mjs || FAILED=1

echo
if [ "$FAILED" -eq 0 ]; then
	echo "ALL SUITES PASSED"
else
	echo "SOME SUITES FAILED"
fi
exit "$FAILED"
