#!/usr/bin/env bash
# Dashboard flows and the boundaries the dashboard introduces.
HOST=http://127.0.0.1:8085
JAR=$(mktemp)
DB="mysql -u root -h 127.0.0.1 -P 3306 -D pulsely"
APP_ID=22222222222222222222222222222222

# Pull the CSRF token out of a page, exactly as a browser would before posting.
tok() {
  curl -s -m 30 -b "$JAR" -c "$JAR" "$1" \
    | grep -oE 'name="csrf" id="csrf" value="[A-Fa-f0-9]+"' \
    | grep -oE '[A-Fa-f0-9]{20,}' | head -1
}

login() {
  local T; T=$(tok "$HOST/dashboard/login")
  curl -s -m 30 -b "$JAR" -c "$JAR" -o /dev/null -X POST "$HOST/dashboard/login" \
    -d "csrf=$T" -d "email=$1" -d "password=$2"
}
code() { curl -s -m 30 -b "$JAR" -o /dev/null -w '%{http_code}' "$@"; }
report() { printf '%-46s %s\n' "$1" "$2"; }

echo "== access control =="
rm -f "$JAR"; touch "$JAR"
report "anonymous /dashboard redirects to login" \
  "$(curl -s -m 30 -o /dev/null -w '%{http_code} -> %{redirect_url}' "$HOST/dashboard")"

login dev@example.com wrongpassword
report "bad password does not create a session" \
  "$(code "$HOST/dashboard") $(curl -s -m 30 -b "$JAR" "$HOST/dashboard" | grep -c 'Your apps')"

login dev@example.com pulsely
report "good password reaches dashboard" \
  "$(curl -s -m 30 -b "$JAR" "$HOST/dashboard" | grep -c 'Your apps') section(s)"

echo
echo "== login throttling =="
# Uses a throwaway address so the dev account stays usable for the rest of the run.
rm -f "$JAR"; touch "$JAR"
THROTTLE_EMAIL="throttle-$$@test.local"
for i in 1 2 3 4 5; do
  T=$(tok "$HOST/dashboard/login")
  curl -s -m 30 -b "$JAR" -c "$JAR" -o /dev/null -X POST "$HOST/dashboard/login" \
    -d "csrf=$T" -d "email=$THROTTLE_EMAIL" -d "password=wrong$i" >/dev/null
done
T=$(tok "$HOST/dashboard/login")
SIXTH=$(curl -s -m 30 -b "$JAR" -c "$JAR" -o /dev/null -w '%{redirect_url}' -X POST "$HOST/dashboard/login" \
  -d "csrf=$T" -d "email=$THROTTLE_EMAIL" -d "password=wrong6")
report "sixth failed attempt is throttled" \
  "$(grep -c 'Too+many+failed' <<<"$SIXTH") lockout message(s)"

report "an untouched account is unaffected" \
  "$(T2=$(tok "$HOST/dashboard/login"); curl -s -m 30 -b "$JAR" -c "$JAR" -o /dev/null -w '%{redirect_url}' \
     -X POST "$HOST/dashboard/login" -d "csrf=$T2" -d "email=other-$$@test.local" -d "password=nope" \
     | grep -c 'Invalid') normal rejection(s)"

echo
echo "== csrf =="
# Every state-changing endpoint must reject a request with no token, a forged
# token, and another session's token.
rm -f "$JAR"; touch "$JAR"
login dev@example.com pulsely
GOOD_T=$(tok "$HOST/dashboard")

APPS_BEFORE=$($DB -N -e "SELECT COUNT(*) FROM apps;")
curl -s -m 30 -b "$JAR" -o /dev/null -X POST "$HOST/dashboard/createApp" -d "name=CSRF No Token"
curl -s -m 30 -b "$JAR" -o /dev/null -X POST "$HOST/dashboard/createApp" -d "csrf=deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" -d "name=CSRF Bad Token"
APPS_AFTER=$($DB -N -e "SELECT COUNT(*) FROM apps;")
report "createApp refuses missing and forged tokens" "$APPS_BEFORE -> $APPS_AFTER apps"

# A token minted in a different session must not work in this one.
OTHER_JAR=$(mktemp)
OTHER_T=$(curl -s -m 30 -c "$OTHER_JAR" "$HOST/dashboard/login" \
  | grep -oE 'name="csrf" id="csrf" value="[A-Fa-f0-9]+"' | grep -oE '[A-Fa-f0-9]{20,}' | head -1)
curl -s -m 30 -b "$JAR" -o /dev/null -X POST "$HOST/dashboard/createApp" -d "csrf=$OTHER_T" -d "name=CSRF Cross Session"
report "createApp refuses another session's token" \
  "$($DB -N -e "SELECT COUNT(*) FROM apps WHERE name LIKE 'CSRF %';") forged app(s) created"
rm -f "$OTHER_JAR"

report "a valid token still works" \
  "$(curl -s -m 30 -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "$HOST/dashboard/createApp" -d "csrf=$GOOD_T" -d "name=CSRF Valid Token")"
report "valid token actually created the app" \
  "$($DB -N -e "SELECT COUNT(*) FROM apps WHERE name='CSRF Valid Token';") row(s)"
$DB -e "DELETE FROM apps WHERE name LIKE 'CSRF %';" 2>/dev/null

report "forged logout is refused" \
  "$(curl -s -m 30 -b "$JAR" -o /dev/null -w '%{http_code}' -X POST "$HOST/dashboard/logout") then still signed in: $(curl -s -m 30 -b "$JAR" "$HOST/dashboard" | grep -c 'Your apps')"

report "trigger API is exempt (machine-to-machine)" \
  "$(./tests/trigger.sh csrf-exempt ok 2>&1 | tail -1 | grep -oE '[0-9]{3}')"

echo
echo "== signup =="
rm -f "$JAR"; touch "$JAR"
NEW_EMAIL="signup-$$-$(date +%s)@test.local"
SIGNUP_T=$(tok "$HOST/dashboard/signup")
report "signup page is reachable anonymously" \
  "$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$HOST/dashboard/signup")"
report "signup redirects into the dashboard" \
  "$(curl -s -m 30 -b "$JAR" -c "$JAR" -o /dev/null -w '%{http_code} -> %{redirect_url}' \
     -X POST "$HOST/dashboard/signup" \
     -d "csrf=$SIGNUP_T" -d "name=Suite User" -d "email=$NEW_EMAIL" -d "password=hunter2hunter2" -d "confirmPassword=hunter2hunter2")"
report "new account is signed in already" \
  "$(curl -s -m 30 -b "$JAR" "$HOST/dashboard" | grep -c 'Create your first app') empty-state(s)"
report "new account landed on the free plan" \
  "$($DB -N -e "SELECT p.name FROM accounts a JOIN plans p ON p.id=a.plan_id WHERE a.email='$NEW_EMAIL';")"
report "password stored as a pbkdf2 hash" \
  "$($DB -N -e "SELECT LEFT(password_hash,14) FROM accounts WHERE email='$NEW_EMAIL';")"

# A second signup with the same address must be refused, not silently duplicated.
rm -f "$JAR"; touch "$JAR"
DUPE_T=$(tok "$HOST/dashboard/signup")
DUPE=$(curl -s -m 30 -b "$JAR" -X POST "$HOST/dashboard/signup" \
  -d "csrf=$DUPE_T" -d "name=Impostor" -d "email=$NEW_EMAIL" -d "password=hunter2hunter2" -d "confirmPassword=hunter2hunter2")
report "duplicate email is refused" \
  "$(grep -c 'already exists' <<<"$DUPE") message(s), $($DB -N -e "SELECT COUNT(*) FROM accounts WHERE email='$NEW_EMAIL';") row(s)"

MM_T=$(tok "$HOST/dashboard/signup")
MISMATCH=$(curl -s -m 30 -b "$JAR" -X POST "$HOST/dashboard/signup" \
  -d "csrf=$MM_T" -d "name=Mismatch" -d "email=mismatch-$$@test.local" -d "password=hunter2hunter2" -d "confirmPassword=different123")
report "password mismatch is refused" \
  "$(grep -c 'passwords' <<<"$MISMATCH") message(s), $($DB -N -e "SELECT COUNT(*) FROM accounts WHERE email='mismatch-$$@test.local';") row(s)"

SHORT_T=$(tok "$HOST/dashboard/signup")
SHORT=$(curl -s -m 30 -b "$JAR" -X POST "$HOST/dashboard/signup" \
  -d "csrf=$SHORT_T" -d "name=Shorty" -d "email=short-$$@test.local" -d "password=abc" -d "confirmPassword=abc")
report "short password is refused" \
  "$(grep -c '8 characters' <<<"$SHORT") message(s), $($DB -N -e "SELECT COUNT(*) FROM accounts WHERE email='short-$$@test.local';") row(s)"

$DB -e "DELETE FROM accounts WHERE email LIKE 'signup-%@test.local' OR email LIKE 'mismatch-%@test.local' OR email LIKE 'short-%@test.local';" 2>/dev/null
login dev@example.com pulsely

echo
echo "== cross-account isolation =="
OTHER=$($DB -N -e "SELECT LOWER(HEX(a.id)) FROM apps a WHERE a.account_id <> UNHEX('11111111111111111111111111111111') LIMIT 1;")
if [ -n "$OTHER" ]; then
  report "other account's app id is not viewable" \
    "$(curl -s -m 30 -b "$JAR" -o /dev/null -w '%{http_code} -> %{redirect_url}' "$HOST/dashboard/app/$OTHER")"
else
  report "other account's app id is not viewable" "skipped (no second account seeded)"
fi
report "garbage app id is not viewable" \
  "$(curl -s -m 30 -b "$JAR" -o /dev/null -w '%{http_code} -> %{redirect_url}' "$HOST/dashboard/app/deadbeefdeadbeefdeadbeefdeadbeef")"

echo
echo "== app + rule management =="
BEFORE=$($DB -N -e "SELECT COUNT(*) FROM apps;")
APP_T=$(tok "$HOST/dashboard")
curl -s -m 30 -b "$JAR" -o /dev/null -X POST "$HOST/dashboard/createApp" -d "csrf=$APP_T" -d "name=Suite Test App"
AFTER=$($DB -N -e "SELECT COUNT(*) FROM apps;")
report "createApp inserts a row" "$BEFORE -> $AFTER"

RB=$($DB -N -e "SELECT COUNT(*) FROM channel_auth_rules WHERE app_id=UNHEX('$APP_ID');")
RULE_T=$(tok "$HOST/dashboard/app/$APP_ID")
curl -s -m 30 -b "$JAR" -o /dev/null -X POST "$HOST/dashboard/addRule" \
  -d "csrf=$RULE_T" -d "appId=$APP_ID" -d "channelPattern=private-suite-*" -d "ruleType=private" \
  -d "authWebhookUrl=https://example.com/auth"
RA=$($DB -N -e "SELECT COUNT(*) FROM channel_auth_rules WHERE app_id=UNHEX('$APP_ID');")
report "addRule inserts a row" "$RB -> $RA"

RID=$($DB -N -e "SELECT LOWER(HEX(id)) FROM channel_auth_rules WHERE app_id=UNHEX('$APP_ID') AND channel_pattern='private-suite-*' LIMIT 1;")
DEL_T=$(tok "$HOST/dashboard/app/$APP_ID")
curl -s -m 30 -b "$JAR" -o /dev/null -X POST "$HOST/dashboard/deleteRule" -d "csrf=$DEL_T" -d "appId=$APP_ID" -d "ruleId=$RID"
RD=$($DB -N -e "SELECT COUNT(*) FROM channel_auth_rules WHERE app_id=UNHEX('$APP_ID');")
report "deleteRule removes it" "$RA -> $RD"

# Leave the seed app as it was.
$DB -e "DELETE FROM apps WHERE name='Suite Test App';" 2>/dev/null

echo
echo "== reserved ops namespace =="
BODY='{"channel":"$ops","event":"spoof","data":{}}'
TS=$(date +%s); BH=$(printf '%s' "$BODY" | shasum -a 256 | cut -d' ' -f1)
SS=$(printf 'POST\n/apps/%s/events\n%s\n%s' "$APP_ID" "$TS" "$BH")
SIG=$(printf '%s' "$SS" | openssl dgst -sha256 -hmac devsecret456 | sed 's/^.*= //')
report "trigger API rejects publishing to \$ops" \
  "$(curl -s -m 30 -o /dev/null -w '%{http_code}' -X POST "$HOST/apps/$APP_ID/events" \
     -H "Content-Type: application/json" -H "X-Pulsely-Timestamp: $TS" \
     -H "X-Pulsely-Signature: $SIG" --data-binary "$BODY")"

rm -f "$JAR"
