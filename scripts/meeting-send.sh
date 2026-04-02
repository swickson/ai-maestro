#!/bin/bash
#
# meeting-send.sh — Post a message to a meeting's shared timeline
#
# Usage:
#   meeting-send.sh <meetingId> <message> [--from <id>] [--alias <name>] [--host <url>]
#
# Examples:
#   meeting-send.sh abc-123 "Hello team!"
#   meeting-send.sh abc-123 "I agree with @kai" --from agent-uuid --alias Watson
#
# Environment:
#   AIMAESTRO_HOST    — API base URL (default: http://localhost:23000)
#   AIMAESTRO_AGENT_ID — Default sender ID
#   AIMAESTRO_AGENT_NAME — Default sender display name
#

set -euo pipefail

MEETING_ID=""
MESSAGE=""
FROM="${AIMAESTRO_AGENT_ID:-}"
ALIAS="${AIMAESTRO_AGENT_NAME:-}"
FROM_TYPE="agent"
HOST="${AIMAESTRO_HOST:-http://localhost:23000}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from)     FROM="$2"; shift 2 ;;
    --alias)    ALIAS="$2"; shift 2 ;;
    --type)     FROM_TYPE="$2"; shift 2 ;;
    --host)     HOST="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: meeting-send.sh <meetingId> <message> [--from <id>] [--alias <name>]"
      exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *)
      if [[ -z "$MEETING_ID" ]]; then
        MEETING_ID="$1"
      elif [[ -z "$MESSAGE" ]]; then
        MESSAGE="$1"
      fi
      shift ;;
  esac
done

if [[ -z "$MEETING_ID" || -z "$MESSAGE" ]]; then
  echo "Error: meetingId and message required" >&2
  echo "Usage: meeting-send.sh <meetingId> <message> [--from <id>] [--alias <name>]" >&2
  exit 1
fi

# Try to resolve identity from AMP config if not provided
if [[ -z "$FROM" ]]; then
  AMP_CONFIG="${HOME}/.agent-messaging/config.json"
  if [[ -f "$AMP_CONFIG" ]]; then
    FROM=$(jq -r '.agent.id // empty' "$AMP_CONFIG" 2>/dev/null)
    [[ -z "$ALIAS" ]] && ALIAS=$(jq -r '.agent.name // empty' "$AMP_CONFIG" 2>/dev/null)
  fi
fi

if [[ -z "$FROM" ]]; then
  echo "Error: sender ID required. Set --from, AIMAESTRO_AGENT_ID, or initialize AMP." >&2
  exit 1
fi

[[ -z "$ALIAS" ]] && ALIAS="$FROM"

RESPONSE=$(curl -sf -X POST "${HOST}/api/meetings/${MEETING_ID}/chat" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg from "$FROM" \
    --arg alias "$ALIAS" \
    --arg type "$FROM_TYPE" \
    --arg msg "$MESSAGE" \
    '{from: $from, fromAlias: $alias, fromType: $type, message: $msg}')" 2>/dev/null)

if [[ -z "$RESPONSE" ]]; then
  echo "Error: Could not reach meeting chat API at ${HOST}" >&2
  exit 1
fi

SUCCESS=$(echo "$RESPONSE" | jq -r '.success // false' 2>/dev/null)
if [[ "$SUCCESS" == "true" ]]; then
  echo "✅ Message posted to meeting ${MEETING_ID}"
else
  ERROR=$(echo "$RESPONSE" | jq -r '.error // "Unknown error"' 2>/dev/null)
  echo "Error: ${ERROR}" >&2
  exit 1
fi
