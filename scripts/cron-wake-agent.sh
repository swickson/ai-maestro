#!/bin/bash
#
# Cron job: Wake the distill agent and prompt the daily distill process
#
# Schedule (example): 0 6 * * * /path/to/ai-maestro/scripts/cron-wake-agent.sh
#
# Configuration (override via environment; no operator data is hardcoded):
#   AGENT_ID   — required; the agent UUID to wake (e.g. export AGENT_ID=...)
#   API_BASE   — AI Maestro API base URL (default: http://localhost:23000)
#
# This script:
# 1. Checks the agent's status
# 2. Wakes it if hibernated/offline
# 3. Waits for the session to be ready
# 4. Sends the distill prompt via the session API
#

AGENT_ID="${AGENT_ID:?AGENT_ID is required (the agent UUID to wake)}"
API_BASE="${API_BASE:-http://localhost:23000}"
LOG_PREFIX="[cron-distill]"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $LOG_PREFIX $1"; }

# 1. Check status
status=$(curl -sf "${API_BASE}/api/agents/${AGENT_ID}" | jq -r '.agent.status // "unknown"')
log "Agent status: ${status}"

# 2. Wake if not active
if [[ "$status" != "active" ]]; then
    log "Waking agent..."
    wake_result=$(curl -sf -X POST "${API_BASE}/api/agents/${AGENT_ID}/wake")
    wake_error=$(echo "$wake_result" | jq -r '.error // empty')
    if [[ -n "$wake_error" ]]; then
        log "ERROR: Wake failed: $wake_error"
        exit 1
    fi
    log "Wake successful, waiting for session to initialize..."
    sleep 15
else
    log "Agent is already active"
fi

# 3. Wait for session to be ready (up to 60s)
for i in $(seq 1 12); do
    session_exists=$(curl -sf "${API_BASE}/api/agents/${AGENT_ID}/session" | jq -r '.exists // false')
    if [[ "$session_exists" == "true" ]]; then
        log "Session ready"
        break
    fi
    if [[ $i -eq 12 ]]; then
        log "ERROR: Session not ready after 60s, aborting"
        exit 1
    fi
    sleep 5
done

# 4. Send distill prompt
log "Sending distill prompt..."
prompt_result=$(curl -sf -X PATCH "${API_BASE}/api/agents/${AGENT_ID}/session" \
    -H "Content-Type: application/json" \
    -d '{
        "command": "Good morning. It'\''s time for the daily distill run. Please check the YouTube channels for new AI content, curate the highlights, and prepare the daily summary.",
        "requireIdle": false,
        "addNewline": true
    }')

prompt_error=$(echo "$prompt_result" | jq -r '.error // empty')
if [[ -n "$prompt_error" ]]; then
    log "WARNING: Prompt delivery reported: $prompt_error (may still have been sent)"
else
    log "Distill prompt sent successfully"
fi

log "Done"
