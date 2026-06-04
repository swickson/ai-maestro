#!/usr/bin/env bash
# aimaestro-mount — add, remove, or list operator bind mounts on a cloud agent.
#
# Usage:
#   aimaestro-mount list <agent>
#   aimaestro-mount add <agent> <host-path> <container-path> [--ro]
#   aimaestro-mount remove <agent> <container-path>
#
# <agent> may be the agent name or UUID. The command resolves it via the
# ai-maestro HTTP API (defaults to http://localhost:23000; override with
# --host or AIMAESTRO_HOST).
#
# Backed by POST /api/agents/<id>/update-runtime (kanban 66115ea3) — rebuilds
# the agent's container with the updated mount list while keeping its UUID,
# AMP keypair, and per-agent state directory stable. The container restarts
# on every mount change; in-flight tmux state inside the container is lost.
#
# IMPORTANT for legacy agents (created before v0.30.84): The /update-runtime
# rebuild reads cpus / memory / autoRemove from the agent's persisted
# deployment.cloud.runtime block. Agents created before that block was added
# will silently fall back to createDockerAgent defaults (cpus=2, memory=4g) —
# silent downsize for any agent originally sized higher via dashboard. Run
# `aimaestro-backfill-runtime` ONCE per host before operating on legacy
# agents with this tool (kanban 1ef9eabd). The backfill is idempotent and
# reads docker inspect — no container restart, no UUID rotation.
#
# Standalone — no dependency on the aimaestro-agent.sh modular CLI. Requires
# only curl + jq.

set -euo pipefail

AIMAESTRO_HOST="${AIMAESTRO_HOST:-http://localhost:23000}"

print_err() { printf '[ERROR] %s\n' "$*" >&2; }
print_info() { printf '%s\n' "$*"; }

usage() {
    cat <<'EOF'
Usage:
  aimaestro-mount list <agent>
  aimaestro-mount add <agent> <host-path> <container-path> [--ro]
  aimaestro-mount remove <agent> <container-path>

Arguments:
  <agent>           Agent name or UUID
  <host-path>       Absolute path on the host (must exist)
  <container-path>  Absolute path inside the container (must NOT be /workspace)
  --ro              Mount read-only

Environment:
  AIMAESTRO_HOST    Base URL of ai-maestro server (default: http://localhost:23000)
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

# Resolve an agent name-or-UUID to the agent record. Echoes the JSON record
# on success; exits non-zero on failure.
resolve_agent() {
    local needle="$1"
    local agents_json
    if ! agents_json=$(curl -fsS "${AIMAESTRO_HOST}/api/agents" 2>/dev/null); then
        print_err "Could not reach ai-maestro at ${AIMAESTRO_HOST} — is the server running?"
        exit 1
    fi

    # Try ID match first (exact), then name match (case-insensitive).
    local found
    found=$(printf '%s' "$agents_json" \
        | jq --arg q "$needle" '
            (.agents // .data // .)
            | (if type == "array" then . else [] end)
            | map(select(.id == $q or (.name | ascii_downcase) == ($q | ascii_downcase)))
            | first
            | select(. != null)
        ')

    if [[ -z "$found" || "$found" == "null" ]]; then
        print_err "Agent not found: ${needle}"
        exit 1
    fi
    printf '%s' "$found"
}

# Echo the current operator-mount list as a JSON array (possibly empty).
current_mounts() {
    local agent_json="$1"
    printf '%s' "$agent_json" | jq '(.deployment.sandbox.mounts // [])'
}

call_update_runtime() {
    local agent_id="$1"
    local new_mounts_json="$2"
    local body
    body=$(jq -nc --argjson mounts "$new_mounts_json" '{mounts: $mounts}')
    local resp http_code
    resp=$(curl -sS -w '\n%{http_code}' -X POST \
        -H 'Content-Type: application/json' \
        --data "$body" \
        "${AIMAESTRO_HOST}/api/agents/${agent_id}/update-runtime")
    http_code=$(printf '%s' "$resp" | tail -n1)
    local payload
    payload=$(printf '%s' "$resp" | sed '$d')

    if [[ "$http_code" != 200 ]]; then
        print_err "update-runtime failed (HTTP ${http_code}):"
        printf '%s\n' "$payload" | jq . >&2 2>/dev/null || printf '%s\n' "$payload" >&2
        exit 1
    fi
    printf '%s' "$payload"
}

cmd_list() {
    if [[ $# -lt 1 ]]; then usage; exit 1; fi
    local agent_json
    agent_json=$(resolve_agent "$1")
    local mounts
    mounts=$(current_mounts "$agent_json")

    local count
    count=$(printf '%s' "$mounts" | jq 'length')
    if [[ "$count" == 0 ]]; then
        print_info "No operator mounts configured."
        return 0
    fi
    printf '%s' "$mounts" | jq -r '
        .[] | "  \(.hostPath) -> \(.containerPath)\(if .readOnly then " (ro)" else "" end)"
    '
}

cmd_add() {
    if [[ $# -lt 3 ]]; then usage; exit 1; fi
    local agent_arg="$1" host_path="$2" container_path="$3"
    shift 3
    local read_only=false
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --ro|--read-only) read_only=true; shift ;;
            *) print_err "Unknown flag: $1"; usage; exit 1 ;;
        esac
    done

    # Client-side sanity checks (server re-validates, but failing fast here
    # avoids a destructive container rebuild for a typo).
    if [[ "$host_path" != /* ]]; then
        print_err "host-path must be absolute: ${host_path}"
        exit 1
    fi
    if [[ "$container_path" != /* ]]; then
        print_err "container-path must be absolute: ${container_path}"
        exit 1
    fi
    # Reserved container paths — mirrors services/agents-docker-service.ts
    # ALWAYS_RESERVED_CONTAINER_PATH_ROOTS + OPERATOR_RESERVED_CONTAINER_PATH_ROOTS.
    # Failing fast here avoids a destructive container rebuild + a 400 round-trip
    # for a path that the server would reject. Server is authoritative.
    local reserved_root
    for reserved_root in \
        "/workspace" \
        "/home/claude/.agent-messaging" \
        "/home/claude/.aimaestro" \
        "/home/claude/.local" \
        "/home/claude/.claude" \
        "/home/claude/.claude.json" \
        "/home/claude/.gemini" \
        "/home/claude/.codex" \
        "/home/claude/.config/gh"
    do
        if [[ "$container_path" == "$reserved_root" || "$container_path" == "${reserved_root}/"* ]]; then
            print_err "container-path \"${container_path}\" is reserved by AI Maestro (matches \"${reserved_root}\") — operator mounts cannot shadow AMP common mounts, claude/gemini/codex state, or the agent working directory"
            exit 1
        fi
    done
    if [[ ! -e "$host_path" ]]; then
        print_err "host-path does not exist: ${host_path}"
        exit 1
    fi

    local agent_json
    agent_json=$(resolve_agent "$agent_arg")
    local agent_id
    agent_id=$(printf '%s' "$agent_json" | jq -r '.id')

    local mounts
    mounts=$(current_mounts "$agent_json")

    # Replace any existing entry at the same containerPath (last write wins).
    # Operators reasonably expect `add /a /b` then `add /c /b` to overwrite.
    local new_mounts
    new_mounts=$(printf '%s' "$mounts" | jq \
        --arg host "$host_path" \
        --arg ctr "$container_path" \
        --argjson ro "$read_only" \
        '
            map(select(.containerPath != $ctr))
            + [{hostPath: $host, containerPath: $ctr} + (if $ro then {readOnly: true} else {} end)]
        ')

    print_info "Rebuilding container for agent ${agent_id} with updated mounts..."
    call_update_runtime "$agent_id" "$new_mounts" >/dev/null
    print_info "Mount added: ${host_path} -> ${container_path}$( [[ $read_only == true ]] && printf ' (ro)' )"
}

cmd_remove() {
    if [[ $# -lt 2 ]]; then usage; exit 1; fi
    local agent_arg="$1" container_path="$2"

    local agent_json
    agent_json=$(resolve_agent "$agent_arg")
    local agent_id
    agent_id=$(printf '%s' "$agent_json" | jq -r '.id')

    local mounts
    mounts=$(current_mounts "$agent_json")
    local match_count
    match_count=$(printf '%s' "$mounts" | jq --arg ctr "$container_path" \
        '[.[] | select(.containerPath == $ctr)] | length')
    if [[ "$match_count" == 0 ]]; then
        print_err "No mount found at container-path: ${container_path}"
        exit 1
    fi

    local new_mounts
    new_mounts=$(printf '%s' "$mounts" | jq --arg ctr "$container_path" \
        'map(select(.containerPath != $ctr))')

    print_info "Rebuilding container for agent ${agent_id} with mount removed..."
    call_update_runtime "$agent_id" "$new_mounts" >/dev/null
    print_info "Mount removed: ${container_path}"
}

main() {
    # Strip --host=<url> / --host <url> from anywhere in the arg list so
    # callers can put it before or after the subcommand.
    local -a args=()
    while [[ $# -gt 0 ]]; do
        case "$1" in
            --host=*) AIMAESTRO_HOST="${1#--host=}"; shift ;;
            --host) AIMAESTRO_HOST="$2"; shift 2 ;;
            *) args+=("$1"); shift ;;
        esac
    done

    if [[ ${#args[@]} -eq 0 ]]; then usage; exit 1; fi
    local cmd="${args[0]}"
    set -- "${args[@]:1}"

    case "$cmd" in
        list)   cmd_list "$@" ;;
        add)    cmd_add "$@" ;;
        remove|rm) cmd_remove "$@" ;;
        help|--help|-h) usage ;;
        *) print_err "Unknown command: ${cmd}"; usage; exit 1 ;;
    esac
}

main "$@"
