#!/usr/bin/env bash
# Exercises the trigger API's rejection paths.
HOST="${HOST:-http://127.0.0.1:8085}"
APP_ID="${APP_ID:-22222222222222222222222222222222}"
SECRET="${SECRET:-devsecret456}"

call() { # label, appId, secret, body, timestamp-override
  local LABEL="$1" AID="$2" SEC="$3" BODY="$4" TSOVER="${5:-}"
  local TS; TS="${TSOVER:-$(date +%s)}"
  local BH; BH=$(printf '%s' "$BODY" | shasum -a 256 | cut -d' ' -f1)
  local SS; SS=$(printf 'POST\n/apps/%s/events\n%s\n%s' "$AID" "$TS" "$BH")
  local SIG; SIG=$(printf '%s' "$SS" | openssl dgst -sha256 -hmac "$SEC" | sed 's/^.*= //')
  local OUT; OUT=$(curl -s -m 30 -w '\n%{http_code}' -X POST "${HOST}/apps/${AID}/events" \
    -H "Content-Type: application/json" -H "X-Pulsely-Timestamp: ${TS}" \
    -H "X-Pulsely-Signature: ${SIG}" --data-binary "$BODY")
  printf '%-28s -> HTTP %s  %s\n' "$LABEL" "$(tail -n1 <<<"$OUT")" "$(sed '$d' <<<"$OUT" | tr -d '\n')"
}

call "valid"                 "$APP_ID" "$SECRET" '{"channel":"ok","event":"e","data":{}}'
call "wrong secret"          "$APP_ID" "wrong"   '{"channel":"ok","event":"e","data":{}}'
call "unknown app"           "99999999999999999999999999999999" "$SECRET" '{"channel":"ok","event":"e","data":{}}'
call "stale timestamp"       "$APP_ID" "$SECRET" '{"channel":"ok","event":"e","data":{}}' "$(( $(date +%s) - 4000 ))"
call "missing event"         "$APP_ID" "$SECRET" '{"channel":"ok","data":{}}'
call "dotted channel"        "$APP_ID" "$SECRET" '{"channel":"a.b","event":"e","data":{}}'
call "non-json body"         "$APP_ID" "$SECRET" 'not json'
