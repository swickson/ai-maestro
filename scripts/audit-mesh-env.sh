#!/usr/bin/env bash
# audit-mesh-env.sh — Verify meeting-inject prerequisites on each mesh host.
#
# Checks per host:
#   MAESTRO_MODE                  — expected: full (in pm2 env for ai-maestro)
#   MAESTRO_MEETING_CONTEXT_KINDS — expected: all (routes every harness through hybrid)
#   UserPromptSubmit hook         — expected: at least one entry whose command path
#                                   ends in ai-maestro-hook.cjs in ~/.claude/settings.json
#   /api/sessions                 — expected: HTTP 200 from localhost:23000 (catches the
#                                   "pm2 online but server dead" failure mode)
#
# Usage:
#   audit-mesh-env.sh [--hosts <file>] [--ssh-user <user>] [--expected-kinds <value>]
#
# Run from an ops host that has SSH keys to every mesh member. Shane's laptop is
# the current practical choice; running from a mesh agent host (e.g. bananajr)
# will hit BatchMode auth failures for peer hosts.
#
# Hosts file: one host per line, either 'host' or 'user@host'. Per-host user
# overrides --ssh-user. '#' comments ok. Reads from $HOSTS_FILE,
# ./mesh-hosts.txt, or ~/.aimaestro/mesh-hosts.txt (first match wins) unless
# --hosts is passed.
#
# Exit codes: 0 all hosts pass, 1 any host missing/mismatch, 2 usage error.

set -euo pipefail

HOSTS_FILE_ARG=""
SSH_USER="${USER}"
EXPECTED_KINDS="all"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --hosts)           HOSTS_FILE_ARG="$2"; shift 2 ;;
    --ssh-user)        SSH_USER="$2"; shift 2 ;;
    --expected-kinds)  EXPECTED_KINDS="$2"; shift 2 ;;
    -h|--help)
      sed -n '2,20p' "$0" | sed 's/^# \{0,1\}//'
      exit 0 ;;
    *) echo "Unknown arg: $1" >&2; exit 2 ;;
  esac
done

resolve_hosts_file() {
  if [[ -n "$HOSTS_FILE_ARG" ]]; then echo "$HOSTS_FILE_ARG"; return; fi
  for candidate in "${HOSTS_FILE:-}" ./mesh-hosts.txt "$HOME/.aimaestro/mesh-hosts.txt"; do
    if [[ -n "$candidate" && -f "$candidate" ]]; then echo "$candidate"; return; fi
  done
  echo ""
}

HOSTS_FILE="$(resolve_hosts_file)"
if [[ -z "$HOSTS_FILE" ]]; then
  echo "No hosts file found. Pass --hosts <file> or set HOSTS_FILE." >&2
  exit 2
fi

mapfile -t HOSTS < <(grep -vE '^\s*(#|$)' "$HOSTS_FILE")
if [[ "${#HOSTS[@]}" -eq 0 ]]; then
  echo "Hosts file $HOSTS_FILE is empty." >&2
  exit 2
fi

printf "%-28s %-6s %-14s %-10s %-14s %s\n" "HOST" "MODE" "KINDS" "HOOK" "SESSIONS" "STATUS"
printf "%-28s %-6s %-14s %-10s %-14s %s\n" "----" "----" "-----" "----" "--------" "------"

# Bash-only remote payload. Runs on each host; emits four colon-separated fields:
#   mode:kinds:hook:sessions
# 'missing' for unresolved fields; 'err' for the sessions check.
remote_cmd=$(cat <<'REMOTE'
set -u
pm2_env_output="$(pm2 env 0 2>/dev/null | sed -r 's/\x1B\[[0-9;]*[mK]//g' || true)"
mode="$(printf '%s\n' "$pm2_env_output" | awk -F': ' '/^MAESTRO_MODE:/ {print $2; exit}' | tr -d '[:space:]')"
kinds="$(printf '%s\n' "$pm2_env_output" | awk -F': ' '/^MAESTRO_MEETING_CONTEXT_KINDS:/ {print $2; exit}' | tr -d '[:space:]')"
[ -z "$mode" ] && mode="missing"
[ -z "$kinds" ] && kinds="missing"
hook="missing"
if [ -f "$HOME/.claude/settings.json" ]; then
  if grep -qE '"command"[[:space:]]*:[[:space:]]*"[^"]*ai-maestro-hook\.cjs' "$HOME/.claude/settings.json"; then
    hook="wired"
  fi
fi
sessions_status="$(curl -sf -o /dev/null -w '%{http_code}' --max-time 3 http://localhost:23000/api/sessions 2>/dev/null || echo err)"
echo "${mode}:${kinds}:${hook}:${sessions_status}"
REMOTE
)

any_fail=0

for entry in "${HOSTS[@]}"; do
  entry="${entry%% *}"  # strip trailing fields in case hosts file has extras
  # Parse 'user@host' or 'host' (defaulting user to $SSH_USER)
  if [[ "$entry" == *"@"* ]]; then
    user="${entry%%@*}"
    host="${entry#*@}"
  else
    user="$SSH_USER"
    host="$entry"
  fi
  if [[ "$host" == "localhost" || "$host" == "$(hostname)" || "$host" == "$(hostname -s)" ]]; then
    raw="$(bash -c "$remote_cmd" 2>/dev/null || echo "err:err:err:err")"
  else
    raw="$(ssh -o BatchMode=yes -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new "${user}@${host}" "$remote_cmd" 2>/dev/null || echo "err:err:err:err")"
  fi
  IFS=':' read -r mode kinds hook sessions <<<"$raw"
  status="OK"
  if [[ "$mode" != "full" ]]; then status="MODE_BAD"; any_fail=1; fi
  if [[ "$kinds" != "$EXPECTED_KINDS" ]]; then status="KINDS_BAD"; any_fail=1; fi
  if [[ "$hook" != "wired" ]]; then status="HOOK_MISSING"; any_fail=1; fi
  if [[ "$sessions" != "200" ]]; then status="API_DEAD"; any_fail=1; fi
  printf "%-28s %-6s %-14s %-10s %-14s %s\n" "$host" "$mode" "$kinds" "$hook" "$sessions" "$status"
done

exit "$any_fail"
