#!/usr/bin/env bash
# Fast inbox check hook for Claude Code / Codex-cli
#
# Features:
# - Rate limited (checks at most once per INTERVAL seconds)
# - Silent when no mail
# - Uses curl directly (avoids Python import overhead)
# - Outputs a brief reminder only when there are unread messages

set -uo pipefail

PROJECT="${AGENT_MAIL_PROJECT:-}"
AGENT="${AGENT_MAIL_AGENT:-}"
URL="${AGENT_MAIL_URL:-http://127.0.0.1:8765/mcp/}"
TOKEN="${AGENT_MAIL_TOKEN:-}"
INTERVAL="${AGENT_MAIL_INTERVAL:-120}"

if [[ -z "${PROJECT}" || -z "${AGENT}" ]]; then
  exit 0
fi

if [[ "${PROJECT}" == *"YOUR_"* || "${PROJECT}" == *"PLACEHOLDER"* || "${PROJECT}" == "<"*">" ]]; then
  exit 0
fi
if [[ "${AGENT}" == *"YOUR_"* || "${AGENT}" == *"PLACEHOLDER"* || "${AGENT}" == "<"*">" ]]; then
  exit 0
fi

RATE_FILE="/tmp/mcp-mail-check-${AGENT//[^a-zA-Z0-9]/_}"
NOW=$(date +%s)

if [[ -f "${RATE_FILE}" ]]; then
  LAST_CHECK=$(cat "${RATE_FILE}" 2>/dev/null || echo 0)
  ELAPSED=$((NOW - LAST_CHECK))
  if [[ ${ELAPSED} -lt ${INTERVAL} ]]; then
    exit 0
  fi
fi

echo "${NOW}" > "${RATE_FILE}"

json_escape() {
  printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))'
}

PROJECT_JSON=$(json_escape "${PROJECT}")
AGENT_JSON=$(json_escape "${AGENT}")

CURL_ARGS=(-s --max-time 3 -X POST "${URL}" -H "Content-Type: application/json")
if [[ -n "${TOKEN}" ]]; then
  CURL_ARGS+=(-H "Authorization: Bearer ${TOKEN}")
fi

RESPONSE=$(curl "${CURL_ARGS[@]}" \
  -d "{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"tools/call\",\"params\":{\"name\":\"fetch_inbox\",\"arguments\":{\"project_key\":${PROJECT_JSON},\"agent_name\":${AGENT_JSON},\"limit\":10,\"include_bodies\":false}}}" 2>/dev/null || echo "")

if [[ -z "${RESPONSE}" ]]; then
  exit 0
fi

if echo "${RESPONSE}" | grep -q '"isError":true'; then
  exit 0
fi

MSG_COUNT=$(echo "${RESPONSE}" | grep -c '"subject"' 2>/dev/null || echo "0")
MSG_COUNT="${MSG_COUNT//[^0-9]/}"
MSG_COUNT="${MSG_COUNT:-0}"

if [[ "${MSG_COUNT}" -gt 0 ]]; then
  URGENT_COUNT=$(echo "${RESPONSE}" | grep -Ec '"importance":"(urgent|high)"' 2>/dev/null || echo "0")
  URGENT_COUNT="${URGENT_COUNT//[^0-9]/}"
  URGENT_COUNT="${URGENT_COUNT:-0}"

  echo ""
  echo "[INBOX REMINDER]"
  if [[ ${URGENT_COUNT} -gt 0 ]]; then
    echo "You have ${MSG_COUNT} message(s) (${URGENT_COUNT} urgent/high)."
    echo "Use fetch_inbox to check messages."
  else
    echo "You have ${MSG_COUNT} recent message(s)."
    echo "Consider checking with fetch_inbox."
  fi
  echo ""
fi

exit 0
