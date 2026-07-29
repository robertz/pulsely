#!/usr/bin/env bash
# End-to-end check of the trigger API signing scheme.
# Usage: tests/trigger.sh [channel] [event]
set -euo pipefail

HOST="${HOST:-http://127.0.0.1:8085}"
APP_ID="${APP_ID:-22222222222222222222222222222222}"
APP_SECRET="${APP_SECRET:-devsecret456}"
CHANNEL="${1:-orders}"
EVENT="${2:-created}"

BODY=$(printf '{"channel":"%s","event":"%s","data":{"id":42}}' "$CHANNEL" "$EVENT")
TS=$(date +%s)
PATH_PART="/apps/${APP_ID}/events"
BODY_HASH=$(printf '%s' "$BODY" | shasum -a 256 | cut -d' ' -f1)

SIGNING_STRING=$(printf 'POST\n%s\n%s\n%s' "$PATH_PART" "$TS" "$BODY_HASH")
SIG=$(printf '%s' "$SIGNING_STRING" | openssl dgst -sha256 -hmac "$APP_SECRET" | sed 's/^.*= //')

echo "--> POST ${HOST}${PATH_PART}"
curl -s -w '\nHTTP %{http_code}\n' \
  -X POST "${HOST}${PATH_PART}" \
  -H "Content-Type: application/json" \
  -H "X-Pulsely-Timestamp: ${TS}" \
  -H "X-Pulsely-Signature: ${SIG}" \
  --data-binary "$BODY"
