#!/usr/bin/env node
// build-manifest.mjs — generate the exhaustive RELAND partition manifest.
//
// The 23blocks reconciliation re-land (PR #161 incident follow-up). The #161
// root cause was *serial discovery* of should-be-ours files hiding in the
// took-upstream bucket. This builder classifies EVERY contested file into
// exactly one of three buckets so no file can land as took-upstream silently:
//
//   keepOurs      — must == OURS  (18f373a, our known-good v0.30.93) after restore
//   adoptUpstream — must == BASE  (upstream merge-base) — we took theirs intentionally
//   handMerge     — allowed to differ from both; ENUMERATED, never a catch-all.
//                   Gate-blind (intra-file regressions hide here) → mandatory per-file review.
//
// Output: scripts/reconcile/reland-manifest.json (the gate's input + the peer dev (dev-host)'s restore worklist).

import { execSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const OURS = '18f373a';                 // our known-good v0.30.93 (restore source)
const EXPECT_BASE = 'e48965751c58a85c186f6e43b152a176589930da'; // upstream merge-base, pinned
const EXPECT_COUNT = 250;
const RECONCILE_BRANCH = 'reconcile/23blocks-merge';
// The canonical reconcile tip we are re-landing onto. The LOCAL reconcile/23blocks-merge
// branch is stale (f952215, pre-Decision-5 fold-in); the remote tip b11deeb includes the
// operatorSupplied fold-in 46bc5dd + yarn.lock regen. Classify against b11deeb, never the
// local branch name — a 7-file (Decision-5) drift otherwise corrupts the handMerge defaults.
const RECONCILE_TIP = 'b11deeb';

// GIT_LITERAL_PATHSPECS=1 is MANDATORY: contested set has 24 bracketed route paths
// (app/api/agents/[id]/...) where git would otherwise treat [id] as a glob char-class
// and mis-diff the file — silently corrupting the partition.
const GENV = { ...process.env, GIT_LITERAL_PATHSPECS: '1' };
const sh = (c) => execSync(c, { encoding: 'utf8', env: GENV }).trim();

// --- Host-agnostic upstream base: the pinned SHA IS the base. Do NOT derive via
// `git merge-base <branch> origin/main` — that throws wherever origin != 23blocks upstream
// or the reconcile branch is remote-only (the prod host, swickson CI). --is-ancestor still validates. ---
const BASE = EXPECT_BASE;
try { execSync(`git cat-file -e ${EXPECT_BASE}`, { env: GENV }); }
catch { console.error(`FATAL: pinned upstream base ${EXPECT_BASE} not present (fetch the 23blocks upstream commit).`); process.exit(1); }
try { execSync(`git merge-base --is-ancestor ${EXPECT_BASE} ${RECONCILE_TIP}`, { env: GENV }); }
catch { console.error(`FATAL: pinned base ${EXPECT_BASE} is not an ancestor of ${RECONCILE_TIP}.`); process.exit(1); }

// Verify the reconcile tip we classify against matches the canonical remote tip (not the stale local branch).
const tipSha = sh(`git rev-parse ${RECONCILE_TIP}`);
let remoteTip;
try { remoteTip = sh(`git rev-parse swickson/reconcile/23blocks-merge`); } catch { remoteTip = null; }
if (remoteTip && !remoteTip.startsWith(tipSha) && !tipSha.startsWith(remoteTip.slice(0, 7))) {
  console.error(`FATAL: RECONCILE_TIP ${RECONCILE_TIP}(${tipSha}) != swickson/reconcile/23blocks-merge (${remoteTip}). Re-pin to the canonical tip.`);
  process.exit(1);
}

// --- Compute the full contested set ---
const contested = sh(`git diff --name-only ${OURS} ${BASE}`).split('\n').filter(Boolean);
if (contested.length !== EXPECT_COUNT) {
  console.error(`FATAL: contested set is ${contested.length}, expected ${EXPECT_COUNT}. Wrong base.`);
  process.exit(1);
}
const contestedSet = new Set(contested);

// --- Empirical resolution of each file on the reconcile branch tip (for cross-check / defaults) ---
const matches = (a, b, f) => {
  try { execSync(`git diff --quiet ${a} ${b} -- "${f}"`, { env: GENV }); return true; } catch { return false; }
};
function empirical(f) {
  if (matches(OURS, RECONCILE_TIP, f)) return 'OURS';
  if (matches(BASE, RECONCILE_TIP, f)) return 'UPSTREAM';
  return 'MERGE';
}

// --- Explicit INTENDED overrides (from RECONCILIATION-PLAN §6, §9 completeness corrections,
//     RELAND-PLAN 2026-06-06, and the peer dev (dev-host)'s pre-stage findings). These encode the human
//     disposition; the empirical bucket is only the default when a file isn't named here. ---

// keepOurs forced: files the merge mis-resolved (took upstream / dropped) that must be restored to ours.
const FORCE_KEEP_OURS = [
  // Full-restore regressions (took upstream or partial-merge; must == ours)
  'agent-container/agent-server.js',          // crash-loop regression (#H), took upstream
  'services/agents-chat-service.ts',          // cloud + Gemini/antigravity chat — MAJOR
  'lib/amp-inbox-writer.ts',                  // zombie-inbox → silent AMP loss
  'lib/team-registry.ts',                     // team mesh-sync
  'services/teams-service.ts',                // team mesh-sync (Users subsystem KEEP_OURS)
  'lib/rag/embeddings.ts',                    // device cpu (no-GPU host safety); ours == cpu
  // Dropped files the merge silently deleted (ours-only; restore from 18f373a)
  'plugin',                                   // submodule gitlink — runtime-load-bearing (swickson plugins fork)
  '.gitmodules',                              // COUPLED with plugin: ours points at swickson/ai-maestro-plugins; b11deeb took 23blocks-OS url (wrong submodule source)
  'scripts/amp-statusline.sh',
  'scripts/registry-sweep-audit.mjs',
  'tests/agent-paths.test.ts',
  'tests/agent-runtime.test.ts',              // §9 P2 coverage-drop (theirs -139)
  'tests/antigravity-message-normalizer.test.ts',
  'tests/gemini-message-normalizer.test.ts',
  'docs/AMP-RELAY-SOP.md',
  'docs/ARCHITECTURE.md',
  'docs/CLOUD-AGENT-MCP-DECISION.md',
  'docs/CLOUD-AGENTS.md',
  'docs/STRATEGIC-TIER-AND-MESH-PRIMER.md',
  'docs/bugfix-hostname-change-resilience.md',
  'docs/bugfix-working-directory.md',
  'docs/meeting-chat-gap-analysis.md',
  'docs/meeting-chat-implementation-prompt.md',
  'docs/proposals/001_meetings_gaps_and_proposal.md',
];

// handMerge forced: surgical files with WANTED merged changes (do NOT full-restore) + append-disjoint tests.
// These WILL differ from both sides after the peer dev (dev-host)'s surgical edits — classified up front so the
// "adoptUpstream must==upstream" check doesn't falsely fail them post-edit.
const FORCE_HAND_MERGE = [
  'agent-container/Dockerfile',               // restore 2 COPY lines + /restoration-ready mkdir-chown; keep other merged changes
  'services/sessions-service.ts',             // 3 surgical restores (cloud-skip, history-skip, registry-preference) + keep UUID@host fallback
  'lib/meeting-inject-queue.ts',              // re-add antigravity AgentKind + gpt branch into upstream's PR#25/#50 rewrite
  'app/teams/[id]/page.tsx',                  // restore &meeting=new URL param onto upstream base
  'scripts/cron-wake-agent.sh',             // restore-then-scrub (Decision-7: no hardcoded operator data) → differs from ours
  'tests/services/sessions-service.test.ts',  // §9 P2 append-disjoint (theirs +22 additive)
  'tests/meeting-inject-utils.test.ts',       // §9 P2 append-disjoint
  // Tests binding to keepOurs/handMerge sources — taking theirs risks dropping coverage of
  // symbols we restore. Append-disjoint (per §9 precedent); the peer dev (dev-host) decides restore-vs-append per-file.
  'tests/agent-utils.test.ts',                // §6 MERGE_BOTH append-disjoint; agent-utils.ts is keepOurs
  'tests/amp-canonical-json.test.ts',         // §6 attachments KEEP_OURS overlay blocks
  'tests/meeting-inject-queue.test.ts',       // §6 ESCALATE bind-to-source (meeting-inject-queue.ts handMerge)
  'tests/services/teams-service.test.ts',     // §6 ESCALATE bind-to-source (teams-service.ts keepOurs)
];

// Files left in adoptUpstream but FLAGGED for human review (ESCALATE feature calls, not mechanical).
// Surfaced in the manifest so the reviewer consciously ratifies rather than silently trusting.
const REVIEW_FLAGGED_ADOPT_UPSTREAM = [
  'components/team-meeting/MeetingChatPanel.tsx', // §3.2 ESCALATE — taking theirs = operator decision-2 (adopt rendering); routes/plumbing stay ours
  'components/team-meeting/MeetingRoom.tsx',      // §3.2 ESCALATE — same
  // server.mjs (peer dev (prod-host), prod-host review): adoptUpstream is a 966+/92- WHOLESALE swap of the most
  // constraint-laden host file (WS upgrade handler + session pooling per CLAUDE.md). Upstream's
  // terminal-history path differs architecturally from ours (inline `capture-pane -e` 5000-line +
  // delayed-broadcast-join redraw-dedup vs ours' runtime.capturePane() 2000-line no-escape) and
  // pairs with a KEEP_OURS client (TerminalView/useTerminal). The gate asserts ==upstream but
  // CANNOT judge whether adoptUpstream was the right CALL. NOT a dropped-fix (the single
  // history-complete emit is unconditional-after-150ms, covers both ours' try+catch paths), but
  // the server↔client terminal contract is HARD-GATED on the peer dev (prod-host)'s HOST local-tmux canary
  // (scrollback + Ctrl+L discriminator) — the cloud-agent canary does not exercise the host server.mjs path.
  'server.mjs',
];

const forceKeepOurs = new Set(FORCE_KEEP_OURS);
const forceHandMerge = new Set(FORCE_HAND_MERGE);

// --- Classify ---
const keepOurs = [], adoptUpstream = [], handMerge = [];
const rationale = {};
const empiricalCount = { OURS: 0, UPSTREAM: 0, MERGE: 0 };

for (const f of contested) {
  const emp = empirical(f);
  empiricalCount[emp]++;
  let bucket;
  if (forceKeepOurs.has(f)) { bucket = 'keepOurs'; rationale[f] = `forced keepOurs (was empirical ${emp})`; }
  else if (forceHandMerge.has(f)) { bucket = 'handMerge'; rationale[f] = `forced handMerge surgical (was empirical ${emp})`; }
  else if (emp === 'OURS') { bucket = 'keepOurs'; rationale[f] = 'empirical: matches ours'; }
  else if (emp === 'UPSTREAM') { bucket = 'adoptUpstream'; rationale[f] = 'empirical: matches upstream (adopted theirs)'; }
  else { bucket = 'handMerge'; rationale[f] = 'empirical: differs from both (merged)'; }
  if (bucket === 'keepOurs') keepOurs.push(f);
  else if (bucket === 'adoptUpstream') adoptUpstream.push(f);
  else handMerge.push(f);
}

// --- Exhaustiveness + disjointness self-check (builder-side; the gate re-checks independently) ---
const all = [...keepOurs, ...adoptUpstream, ...handMerge];
const allSet = new Set(all);
if (all.length !== contested.length || allSet.size !== contested.length) {
  console.error(`FATAL: partition not exhaustive/disjoint. union=${all.length} uniq=${allSet.size} contested=${contested.length}`);
  process.exit(1);
}
for (const f of contested) if (!allSet.has(f)) { console.error(`FATAL: ${f} unclassified`); process.exit(1); }

const manifest = {
  _comment: 'RELAND exhaustive partition of the 250-file contested set. Generated by build-manifest.mjs. The gate (verify-keep-ours.mjs) re-derives the contested set independently and asserts this partitions it exactly. handMerge files are gate-blind (intra-file regressions) → mandatory per-file review.',
  oursRef: OURS,
  upstreamBase: BASE,
  upstreamBaseNote: 'merge-base(reconcile/23blocks-merge, origin/main); pinned; do NOT use a moving branch ref',
  contestedCount: contested.length,
  empiricalOnReconcileTip: empiricalCount,
  counts: { keepOurs: keepOurs.length, adoptUpstream: adoptUpstream.length, handMerge: handMerge.length },
  reviewFlaggedAdoptUpstream: REVIEW_FLAGGED_ADOPT_UPSTREAM,
  keepOurs: keepOurs.sort(),
  adoptUpstream: adoptUpstream.sort(),
  handMerge: handMerge.sort(),
  rationale,
};

const out = new URL('./reland-manifest.json', import.meta.url).pathname;
writeFileSync(out, JSON.stringify(manifest, null, 2) + '\n');
console.log(`Manifest written: ${out}`);
console.log(`  contested:     ${contested.length}`);
console.log(`  keepOurs:      ${keepOurs.length}`);
console.log(`  adoptUpstream: ${adoptUpstream.length}`);
console.log(`  handMerge:     ${handMerge.length}`);
console.log(`  empirical(reconcile tip): OURS=${empiricalCount.OURS} UPSTREAM=${empiricalCount.UPSTREAM} MERGE=${empiricalCount.MERGE}`);
