#!/usr/bin/env bash
# The public marketing surface and its path to signup.
HOST="${HOST:-http://127.0.0.1:8085}"
DB="mysql -u root -h 127.0.0.1 -P 3306 -D pulsely"
JAR=$(mktemp)

report() { printf '%-46s %s\n' "$1" "$2"; }

HOME_HTML=$(curl -s -m 30 "$HOST/")

echo "== reachable without a session =="
report "landing page is public" \
  "$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$HOST/")"
report "/pricing is public" \
  "$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$HOST/pricing")"
report "dashboard still requires a session" \
  "$(curl -s -m 30 -o /dev/null -w '%{http_code} -> %{redirect_url}' "$HOST/dashboard")"

echo
echo "== call to action =="
report "signup CTAs present" \
  "$(grep -o 'href="/dashboard/signup"' <<<"$HOME_HTML" | wc -l | tr -d ' ') link(s)"
report "primary CTA is styled as primary" \
  "$(grep -o 'btn btn-primary btn-lg' <<<"$HOME_HTML" | wc -l | tr -d ' ') prominent button(s)"
report "sign-in offered for existing users" \
  "$(grep -o 'href="/dashboard/login"' <<<"$HOME_HTML" | wc -l | tr -d ' ') link(s)"

echo
echo "== how it works walkthrough =="
report "five steps are present" \
  "$(grep -o 'role="tab"' <<<"$HOME_HTML" | wc -l | tr -d ' ') tab(s), $(grep -o 'role="tabpanel"' <<<"$HOME_HTML" | wc -l | tr -d ' ') panel(s)"
report "first step is open, rest collapsed" \
  "$(grep -o 'aria-selected="true"' <<<"$HOME_HTML" | wc -l | tr -d ' ') selected, $(grep -o 'role="tabpanel"[^>]*hidden' <<<"$HOME_HTML" | wc -l | tr -d ' ') hidden"
report "every tab controls a real panel" \
  "$(for ID in create subscribe publish secure replay; do grep -q "id=\"panel-$ID\"" <<<"$HOME_HTML" && echo ok; done | wc -l | tr -d ' ')/5 resolved"
report "walkthrough documents the signing scheme" \
  "$(grep -c 'X-Pulsely-Signature' <<<"$HOME_HTML") mention(s)"
report "walkthrough documents the auth webhook contract" \
  "$(grep -c 'authorized' <<<"$HOME_HTML") mention(s)"
report "walkthrough closes with a signup CTA" \
  "$(grep -c 'walkthrough-cta' <<<"$HOME_HTML") CTA block(s)"
report "tab script is served" \
  "$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$HOST/assets/js/marketing-tabs.js")"

echo
echo "== pricing reflects the database =="
for PLAN in Sandbox Startup Business; do
  report "plan shown: $PLAN" "$(grep -c ">$PLAN<" <<<"$HOME_HTML") occurrence(s)"
done
STARTUP_CENTS=$($DB -N -e "SELECT price_cents FROM plans WHERE name='Startup';")
report "Startup price matches plans table" \
  "db=${STARTUP_CENTS}c page=$(grep -oE '\$[0-9]+' <<<"$HOME_HTML" | sort -u | tr '\n' ' ')"
SANDBOX_MSGS=$($DB -N -e "SELECT FORMAT(message_daily_limit,0) FROM plans WHERE name='Sandbox';")
report "Sandbox message limit matches" \
  "db=$SANDBOX_MSGS page=$(grep -c "$SANDBOX_MSGS" <<<"$HOME_HTML") match(es)"

echo
echo "== inactive plans stay hidden =="
$DB -e "UPDATE plans SET is_active=0 WHERE name='Startup';" 2>/dev/null
report "deactivated plan disappears from pricing" \
  "$(curl -s -m 30 "$HOST/" | grep -c '>Startup<') occurrence(s)"
$DB -e "UPDATE plans SET is_active=1 WHERE name='Startup';" 2>/dev/null
report "reactivated plan returns" \
  "$(curl -s -m 30 "$HOST/" | grep -c '>Startup<') occurrence(s)"

echo
echo "== signed-in visitors =="
curl -s -m 30 -c "$JAR" -o /dev/null "$HOST/dashboard/login"
curl -s -m 30 -b "$JAR" -c "$JAR" -o /dev/null -X POST "$HOST/dashboard/login" \
  -d "email=dev@example.com" -d "password=pulsely"
SIGNED=$(curl -s -m 30 -b "$JAR" "$HOST/")
report "nav swaps to dashboard link when signed in" \
  "$(grep -c 'Go to dashboard' <<<"$SIGNED") dashboard link(s) in header"
report "header no longer pushes signup at signed-in users" \
  "$(grep -c 'class="btn btn-primary">Start free' <<<"$SIGNED") header signup button(s)"

echo
echo "== assets =="
for ASSET in /assets/css/base.css /assets/css/marketing.css /assets/css/dashboard.css; do
  report "asset served: $ASSET" "$(curl -s -m 30 -o /dev/null -w '%{http_code}' "$HOST$ASSET")"
done

rm -f "$JAR"
