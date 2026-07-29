#!/usr/bin/env bash
# Admin console access control and actions.
#
# Uses throwaway accounts with a known password hash (the same PBKDF2 value the
# dev seed uses for "pulsely"), so no real credentials are needed or changed.
HOST=http://127.0.0.1:8085
DB="mysql -u root -h 127.0.0.1 -P 3306 -D pulsely"
PW='pbkdf2$210000$1ca174a3ae02bc4b1b6e568de2b7bfbc$7fb0bfa64eec075e56aada501c6eb2ef47dcc3849eb5d9eade88485129112f53'

ADMIN_ID=aa110000000000000000000000000ad1
PLAIN_ID=aa110000000000000000000000000f51
ADMIN_EMAIL="admin-suite@test.local"
PLAIN_EMAIL="plain-suite@test.local"

report() { printf '%-52s %s\n' "$1" "$2"; }

tok() {
  curl -s -m 30 -b "$1" -c "$1" "$2" \
    | grep -oE 'name="csrf" id="csrf" value="[A-Fa-f0-9]+"' \
    | grep -oE '[A-Fa-f0-9]{20,}' | head -1
}

login() {  # jar, email
  local T; T=$(tok "$1" "$HOST/dashboard/login")
  curl -s -m 30 -b "$1" -c "$1" -o /dev/null -X POST "$HOST/dashboard/login" \
    -d "csrf=$T" -d "email=$2" -d "password=pulsely"
}

cleanup() {
  $DB -e "DELETE FROM accounts WHERE email IN ('$ADMIN_EMAIL','$PLAIN_EMAIL');" 2>/dev/null
}
trap cleanup EXIT
cleanup

$DB -e "
INSERT INTO accounts (id, email, name, password_hash, plan_id, is_admin, is_active)
SELECT UNHEX('$ADMIN_ID'), '$ADMIN_EMAIL', 'Suite Admin', '$PW', id, 1, 1 FROM plans WHERE name='Sandbox';
INSERT INTO accounts (id, email, name, password_hash, plan_id, is_admin, is_active)
SELECT UNHEX('$PLAIN_ID'), '$PLAIN_EMAIL', 'Suite Plain', '$PW', id, 0, 1 FROM plans WHERE name='Sandbox';
" 2>/dev/null

ADMIN_JAR=$(mktemp); PLAIN_JAR=$(mktemp)

echo "== access control =="
report "anonymous is sent to sign in" \
  "$(curl -s -m 30 -o /dev/null -w '%{http_code} -> %{redirect_url}' "$HOST/admin")"

login "$PLAIN_JAR" "$PLAIN_EMAIL"
report "signed-in non-admin is sent to their dashboard" \
  "$(curl -s -m 30 -b "$PLAIN_JAR" -o /dev/null -w '%{http_code} -> %{redirect_url}' "$HOST/admin")"

login "$ADMIN_JAR" "$ADMIN_EMAIL"
report "admin reaches the console" \
  "$(curl -s -m 30 -b "$ADMIN_JAR" "$HOST/admin" | grep -c 'Accounts') heading(s)"
report "console lists every account" \
  "$(curl -s -m 30 -b "$ADMIN_JAR" "$HOST/admin" | grep -c "$PLAIN_EMAIL") row(s) for the plain user"

echo
echo "== the UI hiding a link is not the control =="
# The real attack: a non-admin POSTing straight at an admin action.
BEFORE=$($DB -N -e "SELECT p.name FROM accounts a JOIN plans p ON p.id=a.plan_id WHERE a.email='$PLAIN_EMAIL';")
BIZ=$($DB -N -e "SELECT LOWER(HEX(id)) FROM plans WHERE name='Business';")
PT=$(tok "$PLAIN_JAR" "$HOST/dashboard")
curl -s -m 30 -b "$PLAIN_JAR" -o /dev/null -X POST "$HOST/admin/setPlan" \
  -d "csrf=$PT" -d "accountId=$PLAIN_ID" -d "planId=$BIZ"
AFTER=$($DB -N -e "SELECT p.name FROM accounts a JOIN plans p ON p.id=a.plan_id WHERE a.email='$PLAIN_EMAIL';")
report "non-admin POST to setPlan changes nothing" "$BEFORE -> $AFTER"

report "non-admin POST to setAdmin changes nothing" \
  "$(curl -s -m 30 -b "$PLAIN_JAR" -o /dev/null -X POST "$HOST/admin/setAdmin" \
      -d "csrf=$PT" -d "accountId=$PLAIN_ID" -d "admin=0"; \
     $DB -N -e "SELECT is_admin FROM accounts WHERE email='$PLAIN_EMAIL';") is_admin"

report "admin POST without a csrf token is refused" \
  "$(curl -s -m 30 -b "$ADMIN_JAR" -o /dev/null -w '%{http_code}' -X POST "$HOST/admin/setPlan" \
      -d "accountId=$PLAIN_ID" -d "planId=$BIZ"); $($DB -N -e "SELECT p.name FROM accounts a JOIN plans p ON p.id=a.plan_id WHERE a.email='$PLAIN_EMAIL';") unchanged"

echo
echo "== admin actions =="
AT=$(tok "$ADMIN_JAR" "$HOST/admin")
curl -s -m 30 -b "$ADMIN_JAR" -o /dev/null -X POST "$HOST/admin/setPlan" \
  -d "csrf=$AT" -d "accountId=$PLAIN_ID" -d "planId=$BIZ"
report "admin can change another account's plan" \
  "$($DB -N -e "SELECT p.name FROM accounts a JOIN plans p ON p.id=a.plan_id WHERE a.email='$PLAIN_EMAIL';")"

AT=$(tok "$ADMIN_JAR" "$HOST/admin")
curl -s -m 30 -b "$ADMIN_JAR" -o /dev/null -X POST "$HOST/admin/setActive" \
  -d "csrf=$AT" -d "accountId=$PLAIN_ID" -d "active=1"
report "admin can suspend another account" \
  "is_active=$($DB -N -e "SELECT is_active FROM accounts WHERE email='$PLAIN_EMAIL';")"

SUSPENDED_JAR=$(mktemp)
login "$SUSPENDED_JAR" "$PLAIN_EMAIL"
report "a suspended account cannot sign in" \
  "$(curl -s -m 30 -b "$SUSPENDED_JAR" "$HOST/dashboard" | grep -c 'Your apps') dashboard(s)"
rm -f "$SUSPENDED_JAR"

echo
echo "== self-lockout guards =="
AT=$(tok "$ADMIN_JAR" "$HOST/admin")
curl -s -m 30 -b "$ADMIN_JAR" -o /dev/null -X POST "$HOST/admin/setActive" \
  -d "csrf=$AT" -d "accountId=$ADMIN_ID" -d "active=1"
report "an admin cannot suspend themselves" \
  "is_active=$($DB -N -e "SELECT is_active FROM accounts WHERE email='$ADMIN_EMAIL';")"

AT=$(tok "$ADMIN_JAR" "$HOST/admin")
curl -s -m 30 -b "$ADMIN_JAR" -o /dev/null -X POST "$HOST/admin/setAdmin" \
  -d "csrf=$AT" -d "accountId=$ADMIN_ID" -d "admin=1"
report "an admin cannot revoke their own access" \
  "is_admin=$($DB -N -e "SELECT is_admin FROM accounts WHERE email='$ADMIN_EMAIL';")"

rm -f "$ADMIN_JAR" "$PLAIN_JAR"
