# RELAND hand-merge changelog (review artifact)

Author: CelestIA (dev-aimaestro-bananajr). Reviewer: Watson (different-peer).
Base branch: `reconcile/reland` (tip 4535f10 = b11deeb + manifest/gate). Restore source: `18f373a` (= v0.30.93 content).

The partition gate (`verify-keep-ours.mjs`) covers keepOurs (==ours) and adoptUpstream (==upstream) deterministically.
**handMerge files are gate-blind** — this changelog is their review record: what was RESTORED-from-ours vs KEPT-AS-MERGED-from-upstream.

---

## STEP 2 — deterministic keepOurs restores (24 files, gate-covered)
Pure `git checkout 18f373a -- <file>`, no judgment. Gate asserts each == ours@18f373a.
`.gitmodules`, `plugin` (submodule gitlink), `agent-container/agent-server.js`, `lib/amp-inbox-writer.ts`,
`lib/team-registry.ts`, `services/agents-chat-service.ts`, `services/teams-service.ts`, `lib/rag/embeddings.ts`,
`scripts/amp-statusline.sh`, `scripts/registry-sweep-audit.mjs`, `tests/agent-paths.test.ts`,
`tests/agent-runtime.test.ts`, `tests/antigravity-message-normalizer.test.ts`, `tests/gemini-message-normalizer.test.ts`,
+ 10 docs (`AMP-RELAY-SOP`, `ARCHITECTURE`, `CLOUD-AGENT-MCP-DECISION`, `CLOUD-AGENTS`, `STRATEGIC-TIER-AND-MESH-PRIMER`,
`bugfix-hostname-change-resilience`, `bugfix-working-directory`, `meeting-chat-gap-analysis`,
`meeting-chat-implementation-prompt`, `proposals/001_meetings_gaps_and_proposal`).

## STEP 3 — surgical hand-merge files (5) — gate-blind, reviewed below

### agent-container/Dockerfile
- **RESTORED from ours:** `COPY claude-home-merge.cjs ./` + `COPY restoration-gate.cjs ./` (dropped by upstream);
  the `RUN mkdir -p /restoration-ready && chown -R claude:claude /restoration-ready` block + comment (Han EACCES race, kanban fcabb870).
  Coupled: `agent-server.js` (keepOurs) require()s those .cjs; without the COPY + mkdir the container crash-loops on boot.
- **KEPT as merged (upstream):** everything else — base image, npm globals, all other bind-mount pre-create dirs.
- Verified by `verify-agent-container-requires.mjs` (every relative require target is COPY'd).

### services/sessions-service.ts  (3 restores + 1 kept ADD)
- **RESTORED from ours:** (1) removed `if (agent.deployment?.type === 'cloud') continue` cloud-skip in standalone-discovery;
  (2) removed `if ((agent.sessions||[]).length > 0) continue` session-history skip; (3) restored
  `workingDirectory: agentWorkingDir || disc.workingDirectory` + the `agentWorkingDir` registry-preference computation +
  comment (CLAUDE.md: workingDirectory is STORED on the agent; tmux reports $HOME on tilde failure); (4) restored the
  OURS comment block on the heartbeat-discovery loop (the upstream comment documented the *removed* skip behavior and
  would be false-after-removal).
- **KEPT as merged (upstream ADD):** the UUID@host session-name fallback (`let agent` + uuidMatch → getAgent), the
  `isCallSession` companion-fork skip, and the `hookState` chat-broadcast in `broadcastActivityUpdate`.

### lib/meeting-inject-queue.ts  (surgical onto upstream's PR#25/#50 rewrite)
- **RESTORED from ours:** `AgentKind` += `'antigravity'`; `inferKindFromProgram` codex branch `|| p.includes('gpt')`;
  new `if (p.includes('antigravity')) return 'antigravity'` branch, ordered BEFORE gemini (defensive: agy state lives under .gemini/antigravity-cli/).
- **KEPT as merged (upstream):** the entire file rewrite (FIFO queue impl, flag parsing, doc comments) from upstream PRs #25/#50.

### app/teams/[id]/page.tsx
- **RESTORED from ours:** `handleStartMeeting` URL `?meeting=new&team=${teamId}` (upstream dropped the `meeting=new` param).
- **KEPT as merged (upstream):** rest of the page (= upstream base).

### scripts/cron-wake-hardin.sh  (RESTORE-then-SCRUB — Decision-7: no hardcoded operator data)
- **RESTORED from ours:** the whole script (upstream had deleted it).
- **SCRUBBED (differs from BOTH sides — Decision-7):** removed hardcoded operator data → parameterized via env:
  `AGENT_ID` (was hardcoded Hardin UUID `7ee4d1cc…`, now required env), `API_BASE` (was hardcoded bananajr IP
  `http://100.112.62.82:23000`, now defaults to `http://localhost:23000`); removed operator name "Shane" from the
  distill prompt; genericized the schedule-comment path and log prefix (`[cron-hardin]`→`[cron-distill]`).
  Behavior/logic unchanged. **Reviewer note:** confirm the scrub scope matches Decision-7 intent.

## Append-disjoint test files (6) — my per-file call; principle = union, no coverage drop, all green
Empirically run against the resolved sources (224/224 pass for these 6; full suite 1111 with gate).

- **tests/services/sessions-service.test.ts** — KEPT theirs (theirs ⊇ ours: +2 `__call` filtering tests, drops nothing). Passes vs my surgical source.
- **tests/meeting-inject-utils.test.ts** — KEPT theirs (same 4 tests reworded; source `meeting-inject-utils.ts` is adoptUpstream). No coverage delta.
- **tests/agent-utils.test.ts** — KEPT theirs (theirs ⊇ ours: +15 call-session/permission-mode tests). Symbols resolve from `types/agent.ts` (merged, present), `agent-utils.ts` (keepOurs) supplies `agentToSession`. All pass.
- **tests/amp-canonical-json.test.ts** — RESTORED ours (ours ⊋ theirs: ours has 3 attachment pinned-vector tests — amp-v1/legacy/mixed-shape — upstream DROPPED; restoring recovers that coverage, theirs adds nothing). All pass.
- **tests/meeting-inject-queue.test.ts** — KEPT theirs as base + APPENDED 4 table rows (`gpt-5-codex`→codex, 3× antigravity) to cover the antigravity/gpt source branches I restored. Upstream table lacked both. All pass.
- **tests/services/teams-service.test.ts** — RESTORED ours (identical 70 titles, but upstream's mock block was incompatible with the keepOurs `teams-service.ts` source → getTeamById returned 404; ours' test matches ours' source). All pass.

## Build-surfaced regression fix (handMerge, gate-blind)

### types/team.ts  (KAI had cleared on field-presence; build caught a narrowed literal)
- **RESTORED from ours:** line 37 `TeamsFile.version: 1` → `version: 1 | 2`. The merge silently narrowed the
  union (ours@18f373a = `1 | 2`). Our restored keepOurs `lib/team-registry.ts` (lines 48,67) writes `version: 2`
  for the v1→v2 hostId migration → `tsc: Type '2' is not assignable to type '1'`, build-blocking.
- **KEPT as merged:** line 77 `Team.version: 1` (correct — that's the per-team schema field, not the file envelope)
  and all other merged fields (loopGuard, operatorId/Name, hostId, source). team-registry.ts stays ==ours (gate green).
- Reported to KAI (msg t7zu6sv). Lesson: field-presence review on handMerge type files must also check
  literal/union-type narrowing.
- **keepOurs-vs-handMerge determination (for reviewer):** my-fixed types/team.ts is NOT byte-identical to ours —
  it retains a merged field-*ordering* difference (`Team.hostId?` relocated from after `chiefOfStaffId?` to after
  `lastActivityAt`; functionally identical for a TS interface, field order is immaterial). So it stays genuinely
  handMerge (justified), not effectively keepOurs. Only the `TeamsFile.version` literal was restored to ours.

## Pre-cleared by KAI
- `services/headless-router.ts` — 216 route-patterns ⊇ our 199; Users subsystem registered; no P0. (Confirmed, no action.)
