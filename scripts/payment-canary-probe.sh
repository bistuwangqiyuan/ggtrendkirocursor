#!/usr/bin/env bash
# Ask one deployment whether a customer could pay right now.
#
# Three outcomes, deliberately distinguished:
#   healthy: true    every configured provider opened a checkout session -> pass
#   disabled: true   nothing is configured, so nothing is broken -> pass with a note
#   anything else    a provider that is supposed to work did not -> fail the job,
#                    which mails the repository owner
#
# The middle case is the reason this is a script rather than a grep in the
# workflow: before the provider accounts exist, a daily "unhealthy" email would
# train its only reader to ignore it.
#
# Environment: BASE_URL, CRON_SECRET
set -uo pipefail

: "${BASE_URL:?BASE_URL is required}"
: "${CRON_SECRET:?CRON_SECRET is required}"

body=$(curl -sS --max-time 60 -H "Authorization: Bearer ${CRON_SECRET}" "${BASE_URL}/api/pay/canary")
status=$?
echo "$body"

if [ $status -ne 0 ] || [ -z "$body" ]; then
  echo "::error::payment canary unreachable on ${BASE_URL}"
  exit 1
fi

if echo "$body" | grep -q '"healthy": true'; then
  echo "payments healthy on ${BASE_URL}"
  exit 0
fi

if echo "$body" | grep -q '"disabled": true'; then
  echo "::notice::payments not configured on ${BASE_URL}; nothing to probe"
  exit 0
fi

echo "::error::payment path unhealthy on ${BASE_URL}"
exit 1
