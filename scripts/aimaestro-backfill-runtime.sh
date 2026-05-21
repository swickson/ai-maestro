#!/usr/bin/env bash
# aimaestro-backfill-runtime — one-time backfill of deployment.cloud.runtime
# (cpus, memory, autoRemove) from docker inspect for cloud agents created
# before PR #146 (v0.30.84).
#
# Usage:
#   aimaestro-backfill-runtime [--dry-run] [--host URL]
#
# Walks /api/agents, filters cloud agents (provider=local-container, !deleted)
# whose runtime.cpus or runtime.memory is null, and calls
# POST /api/agents/<id>/backfill-runtime for each. Server reads docker inspect
# and persists via updateAgentRuntimeConfig (registry-only — no container
# restart, no UUID rotation).
#
# Without this migration, /recreate and /update-runtime on these legacy
# agents silently fall back to createDockerAgent defaults (cpus=2, memory=4g),
# downsizing any agent originally created with non-default sizing via dashboard.
#
# Idempotent. Safe to re-run — already-backfilled agents return action=skipped.
#
# Requires only curl + jq.

set -euo pipefail

AIMAESTRO_HOST="${AIMAESTRO_HOST:-http://localhost:23000}"
DRY_RUN=false

print_err() { printf '[ERROR] %s\n' "$*" >&2; }
print_info() { printf '%s\n' "$*"; }

usage() {
    cat <<'EOF'
Usage:
  aimaestro-backfill-runtime [--dry-run] [--host URL]

Options:
  --dry-run        List targets without calling backfill endpoint
  --host URL       Base URL of ai-maestro server (default: http://localhost:23000;
                   also configurable via AIMAESTRO_HOST env var)
  -h, --help       Show this message

Environment:
  AIMAESTRO_HOST   Same as --host
EOF
}

require_dep() {
    local dep="$1"
    if ! command -v "$dep" >/dev/null 2>&1; then
        print_err "$dep is required but not installed"
        exit 1
    fi
}

require_dep curl
require_dep jq

while [[ $# -gt 0 ]]; do
    case "$1" in
        --dry-run) DRY_RUN=true; shift ;;
        --host=*)  AIMAESTRO_HOST="${1#--host=}"; shift ;;
        --host)    AIMAESTRO_HOST="$2"; shift 2 ;;
        -h|--help) usage; exit 0 ;;
        *)         print_err "Unknown argument: $1"; usage; exit 1 ;;
    esac
done

# Fetch agents
agents_json=$(curl -fsS "${AIMAESTRO_HOST}/api/agents" 2>/dev/null) || {
    print_err "Could not reach ai-maestro at ${AIMAESTRO_HOST} — is the server running?"
    exit 1
}

# Filter cloud-container agents missing runtime.cpus or runtime.memory.
# Tab-separated for downstream parsing.
targets=$(printf '%s' "$agents_json" | jq -r '
    .agents
    | map(select(
        .deployment.type == "cloud"
        and .deployment.cloud.provider == "local-container"
        and .deletedAt == null
        and (
          .deployment.cloud.runtime == null
          or .deployment.cloud.runtime.cpus == null
          or .deployment.cloud.runtime.memory == null
        )
      ))
    | .[]
    | "\(.id)\t\(.name)\t\(.deployment.cloud.containerName // "<no-container>")"
')

if [[ -z "$targets" ]]; then
    print_info "No cloud agents need runtime backfill. Nothing to do."
    exit 0
fi

target_count=$(printf '%s\n' "$targets" | wc -l)
print_info "${target_count} cloud agent(s) need runtime backfill:"
printf '%s\n' "$targets" | awk -F'\t' '{printf "  %-40s %-25s %s\n", $1, $2, $3}'

if [[ "$DRY_RUN" == true ]]; then
    print_info ""
    print_info "Dry-run complete. Re-run without --dry-run to apply."
    exit 0
fi

print_info ""
print_info "Calling POST /api/agents/<id>/backfill-runtime for each..."
print_info ""

backfilled=0
skipped=0
errored=0

while IFS=$'\t' read -r agent_id agent_name container_name; do
    [[ -z "$agent_id" ]] && continue
    printf '  %-25s ' "${agent_name}:"
    resp=$(curl -sS -w '\n%{http_code}' -X POST \
        -H 'Content-Type: application/json' \
        "${AIMAESTRO_HOST}/api/agents/${agent_id}/backfill-runtime" 2>&1)
    http_code=$(printf '%s' "$resp" | tail -n1)
    payload=$(printf '%s' "$resp" | sed '$d')

    if [[ "$http_code" != 200 ]]; then
        errored=$((errored + 1))
        printf 'HTTP %s — %s\n' "$http_code" "$(printf '%s' "$payload" | jq -r '.message // .error // .' 2>/dev/null || printf '%s' "$payload")"
        continue
    fi

    action=$(printf '%s' "$payload" | jq -r '.data.action // "unknown"')
    case "$action" in
        backfilled)
            backfilled=$((backfilled + 1))
            runtime=$(printf '%s' "$payload" | jq -r '.data.runtime | "cpus=\(.cpus) memory=\(.memory) autoRemove=\(.autoRemove)"')
            printf 'backfilled (%s)\n' "$runtime"
            ;;
        skipped)
            skipped=$((skipped + 1))
            reason=$(printf '%s' "$payload" | jq -r '.data.reason // ""')
            printf 'skipped (%s)\n' "$reason"
            ;;
        *)
            errored=$((errored + 1))
            printf 'unexpected response: %s\n' "$payload"
            ;;
    esac
done <<< "$targets"

print_info ""
print_info "Summary: ${backfilled} backfilled, ${skipped} skipped, ${errored} errored"

[[ "$errored" -gt 0 ]] && exit 1 || exit 0
