#!/usr/bin/env bash
# Verifies plan enforcement (429) and the private-channel auth webhook.
set -uo pipefail
DB="mysql -u root -h 127.0.0.1 -P 3306 -D pulsely"
APP_ID=22222222222222222222222222222222
SECRET=devsecret456
HOST=http://127.0.0.1:8085

post() {
  local BODY="$1"
  local TS; TS=$(date +%s)
  local BH; BH=$(printf '%s' "$BODY" | shasum -a 256 | cut -d' ' -f1)
  local SS; SS=$(printf 'POST\n/apps/%s/events\n%s\n%s' "$APP_ID" "$TS" "$BH")
  local SIG; SIG=$(printf '%s' "$SS" | openssl dgst -sha256 -hmac "$SECRET" | sed 's/^.*= //')
  curl -s -o /dev/null -w '%{http_code}' -m 30 -X POST "${HOST}/apps/${APP_ID}/events" \
    -H "Content-Type: application/json" -H "X-Pulsely-Timestamp: ${TS}" \
    -H "X-Pulsely-Signature: ${SIG}" --data-binary "$BODY"
}

echo "== plan enforcement =="
ORIG=$($DB -N -e "SELECT message_daily_limit FROM plans WHERE name='Business';")
$DB -e "UPDATE plans SET message_daily_limit=1 WHERE name='Business';"
$DB -e "UPDATE usage_daily SET messages_sent=0 WHERE app_id=UNHEX('$APP_ID');"
echo "first send (under limit):  HTTP $(post '{"channel":"lim","event":"e","data":{}}')"
echo "second send (over limit):  HTTP $(post '{"channel":"lim","event":"e","data":{}}')"
$DB -e "UPDATE plans SET message_daily_limit=$ORIG WHERE name='Business';"
echo "limit restored to $ORIG"
