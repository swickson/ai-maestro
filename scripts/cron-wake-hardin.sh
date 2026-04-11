#!/bin/bash
#
# Cron job: Wake Hardin and prompt daily distill process
#
# Schedule: 0 6 * * * /home/gosub/projects/ai-maestro/scripts/cron-wake-hardin.sh
#
# This script:
# 1. Checks Hardin's status on bananajr
# 2. Wakes him if hibernated/offline
# 3. Waits for the session to be ready
# 4. Sends the distill prompt via the session API
#

HARDIN_ID="7ee4d1cc-b610-430b-be4f-e373ecce9350"
BANANAJR_API="http://100.112.62.82:23000"
LOG_PREFIX="[cron-hardin]"

log() { echo "$(date '+%Y-%m-%d %H:%M:%S') $LOG_PREFIX $1"; }

# 1. Check status
status=$(curl -sf "${BANANAJR_API}/api/agents/${HARDIN_ID}" | jq -r '.agent.status // "unknown"')
log "Hardin status: ${status}"

# 2. Wake if not active
if [[ "$status" != "active" ]]; then
    log "Waking Hardin..."
    wake_result=$(curl -sf -X POST "${BANANAJR_API}/api/agents/${HARDIN_ID}/wake")
    wake_error=$(echo "$wake_result" | jq -r '.error // empty')
    if [[ -n "$wake_error" ]]; then
        log "ERROR: Wake failed: $wake_error"
        exit 1
    fi
    log "Wake successful, waiting for session to initialize..."
    sleep 15
else
    log "Hardin is already active"
fi

# 3. Wait for session to be ready (up to 60s)
for i in $(seq 1 12); do
    session_exists=$(curl -sf "${BANANAJR_API}/api/agents/${HARDIN_ID}/session" | jq -r '.exists // false')
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
prompt_result=$(curl -sf -X PATCH "${BANANAJR_API}/api/agents/${HARDIN_ID}/session" \
    -H "Content-Type: application/json" \
    -d '{
        "command": "Good morning Hardin. It'\''s time for the daily distill run. Please check the YouTube channels for new AI content, curate the highlights, and prepare the daily summary for Shane.",
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
