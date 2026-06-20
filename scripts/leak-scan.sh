#!/usr/bin/env bash
#
# Public-repo leak scanner — fails if private mesh / agent / client / operator
# tokens are committed. swickson/ai-maestro is a PUBLIC fork (can't go private),
# so committed content must stay generic. See CLAUDE.md "Public-repo hygiene".
#
# DESIGN (so the guard itself never re-leaks): the denylist of ACTUAL private
# tokens (host names, agent names, client/project names, operator handle + email
# domain, the real Tailscale mesh IPs) is supplied at runtime via $LEAK_DENYLIST
# (newline-separated, regex-allowed), sourced from a CI secret and NEVER
# committed. Committing the token list here would itself re-leak it. We do NOT
# use broad structural patterns (e.g. "any 100.64/10 IP"): the repo legitimately
# documents EXAMPLE Tailscale IPs, so only the SPECIFIC real mesh IPs (in the
# secret) are leaks.
#
# Local pre-PR:  LEAK_DENYLIST="$(cat ~/.aimaestro/leak-denylist.txt)" scripts/leak-scan.sh
# CI:            LEAK_DENYLIST from a repo secret (.github/workflows/leak-scan.yml)
set -uo pipefail
cd "$(git rev-parse --show-toplevel)" || exit 2

# KEEP — public, never flag:
#   swickson/      GitHub org in URLs/remotes/submodule
#   23blocks       product / upstream brand
#   leak-scan      this scanner's own docs
#   '[A-Z][a-z]+(IA|AI)'  agent-name-generation ALIAS POOLS (generic name options,
#                  e.g. CelestIA/LeoAI in FEMALE_ALIASES/MALE_ALIASES) — not refs
KEEP_RE="swickson/|23blocks|leak-scan|'[A-Za-z]+(IA|AI)'[,[:space:]]"

files() { git ls-files | grep -viE 'node_modules|\.next/|package-lock|yarn\.lock|/memory/'; }

if [ -z "${LEAK_DENYLIST:-}" ]; then
  echo "⚠️  LEAK_DENYLIST not set — cannot enforce the private-token denylist."
  echo "    Set the LEAK_DENYLIST CI secret (or export it locally from ~/.aimaestro/leak-denylist.txt)."
  echo "    Skipping (non-blocking) so unconfigured forks/CI don't fail spuriously."
  exit 0
fi

pat=$(printf '%s\n' "$LEAK_DENYLIST" | grep -vE '^[[:space:]]*$' | paste -sd '|' -)
if [ -z "$pat" ]; then echo "✅ leak-scan: empty denylist, nothing to check."; exit 0; fi

out=$(files | tr '\n' '\0' | xargs -0 grep -InHE -- "($pat)" 2>/dev/null | grep -viE "$KEEP_RE")
if [ -n "$out" ]; then
  printf '\n❌ leak-scan FOUND private tokens in committed content:\n%s\n\n' "$out"
  echo "Scrub to generic placeholders before merge (CLAUDE.md → Public-repo hygiene)."
  exit 1
fi
echo "✅ leak-scan: clean."
