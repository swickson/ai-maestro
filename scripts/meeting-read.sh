#!/bin/bash
#
# meeting-read.sh — Read messages from a meeting's shared timeline
#
# Usage:
#   meeting-read.sh <meetingId> [--since <ISO>] [--limit <N>] [--host <url>]
#
# Examples:
#   meeting-read.sh abc-123                    # Read all messages
#   meeting-read.sh abc-123 --limit 5          # Last 5 messages
#   meeting-read.sh abc-123 --since 2026-04-01T23:00:00Z  # Since timestamp
#

set -euo pipefail

MEETING_ID=""
SINCE=""
LIMIT=""
HOST="${AIMAESTRO_HOST:-http://localhost:23000}"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --since) SINCE="$2"; shift 2 ;;
    --limit) LIMIT="$2"; shift 2 ;;
    --host)  HOST="$2"; shift 2 ;;
    --help|-h)
      echo "Usage: meeting-read.sh <meetingId> [--since <ISO>] [--limit <N>] [--host <url>]"
      exit 0 ;;
    -*) echo "Unknown option: $1" >&2; exit 1 ;;
    *)  MEETING_ID="$1"; shift ;;
  esac
done

if [[ -z "$MEETING_ID" ]]; then
  echo "Error: meetingId required" >&2
  echo "Usage: meeting-read.sh <meetingId> [--since <ISO>] [--limit <N>]" >&2
  exit 1
fi

# Build query string
PARAMS=""
[[ -n "$SINCE" ]] && PARAMS="${PARAMS}&since=${SINCE}"
[[ -n "$LIMIT" ]] && PARAMS="${PARAMS}&limit=${LIMIT}"
PARAMS="${PARAMS#&}"
[[ -n "$PARAMS" ]] && PARAMS="?${PARAMS}"

RESPONSE=$(curl -sf "${HOST}/api/meetings/${MEETING_ID}/chat${PARAMS}" 2>/dev/null)

if [[ -z "$RESPONSE" ]]; then
  echo "Error: Could not reach meeting chat API at ${HOST}" >&2
  exit 1
fi

# Pretty-print messages
echo "$RESPONSE" | jq -r '.messages[] | "[\(.fromType)] \(.fromAlias): \(.message)"' 2>/dev/null

echo ""
COUNT=$(echo "$RESPONSE" | jq -r '.messages | length' 2>/dev/null)
echo "--- ${COUNT} message(s) ---"
