#!/usr/bin/env bash
# Starts a throwaway Stalwart mail server for the hosted-mail part of tests/comms_it.rs, completes
# its first-start setup and prints the variables that point the test at it:
#
#     tests/stalwart.sh >> "$GITHUB_ENV"             # CI
#     export $(tests/stalwart.sh) && cargo test      # locally
#
# Needs Docker, curl and jq. STALWART_IMAGE, STALWART_PORT and STALWART_NAME (the container)
# override the defaults.
set -euo pipefail
name=${STALWART_NAME:-ferrum-comms-stalwart}
image=${STALWART_IMAGE:-stalwartlabs/stalwart:v1.0}
url="http://127.0.0.1:${STALWART_PORT:-18081}"
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" -p "127.0.0.1:${STALWART_PORT:-18081}:8080" "$image" >/dev/null

up() { # user password
  for _ in $(seq 120); do
    curl -fsS -o /dev/null -u "$1:$2" "$url/jmap/session" 2>/dev/null && return 0
    sleep 0.5
  done
  echo "Stalwart did not let $1 in" >&2 && docker logs "$name" >&2 && return 1
}

# The first start prints a temporary administrator, once.
for _ in $(seq 120); do
  temp=$(docker logs "$name" 2>&1 | sed -n 's/^ *password: *\([^ ]*\).*/\1/p' | head -1)
  [ -n "$temp" ] && break
  sleep 0.5
done
up admin "$temp"
account=$(curl -fsS -u "admin:$temp" "$url/jmap/session" | jq -r '.primaryAccounts["urn:stalwart:jmap"]')
# Setup over JMAP gives the permanent administrator; the server leaves setup mode on restart.
admin=$(curl -fsS -u "admin:$temp" -H 'content-type: application/json' "$url/jmap/" -d "$(jq -n --arg a "$account" '{
  using: ["urn:ietf:params:jmap:core", "urn:stalwart:jmap"],
  methodCalls: [["x:Bootstrap/set", {accountId: $a, update: {singleton: {
    defaultDomain: "mail.test", defaultHostname: "mail.mail.test", requestTlsCertificate: false}}}, "0"]]}')" |
  jq -c '.methodResponses[0][1].updated.singleton')
user=$(jq -r .username <<<"$admin")
secret=$(jq -r .secret <<<"$admin")
[ "$user" != null ] || { echo "setup failed: $admin" >&2; exit 1; }
docker restart "$name" >/dev/null
up "$user" "$secret"
echo "FERRUM_MAIL_URL=$url"
echo "FERRUM_MAIL_ADMIN=$user"
echo "FERRUM_MAIL_ADMIN_SECRET=$secret"
