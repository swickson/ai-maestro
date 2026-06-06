# 23blocks Reconciliation — RE-LAND gate

Deterministic gate for re-landing the 23blocks fork reconciliation after the PR #161 incident.

> **STATUS (post-reland): MANUAL reconciliation-time tool, NOT a perpetual test.**
> The reland (#165, v0.31.2) is merged, rolled mesh-wide, and soaking — `main` *is* the
> partitioned tree, so the partition is now historical. The vitest wrapper
> (`tests/reconcile-gate.test.ts`) was **removed**: as a permanent `yarn test` invariant it
> froze the ~208 keep-ours/adopt-upstream contested files against any future edit (it asserts
> they stay byte-matched to the partition forever). These scripts remain as **manual tools** —
> run them by hand during a *future* fork-merge (regenerate the manifest for the new contested
> set first). They are not part of the standard test suite.

## Why this exists

PR #161 (v0.31.0) merged the reconciliation, then was reverted (PR #164) after a **systematic
KEEP_OURS-application failure**: the merge silently reverted ~8 of our files to upstream and
dropped others. 1073/1073 tests + a 45h soak passed anyway, because the failure was *serial
discovery* — should-be-ours files hid in the took-upstream bucket and were found one at a time,
never as a complete set.

Root cause: KEEP_OURS was treated as a per-file judgment call when it is **mechanical**
(`git checkout ours -- <file>`). The fix bakes that in and adds a gate that makes the failure
class structurally impossible — for this re-land and every future reconciliation.

## The partition (the load-bearing idea)

Every file in the contested set (`git diff 18f373a <upstream-merge-base>` = **250** files) is
classified into exactly one of three buckets in `reland-manifest.json`:

| bucket | invariant | meaning |
|---|---|---|
| `keepOurs` | must `== 18f373a` (our known-good v0.30.93) | mechanical restore; no judgment |
| `adoptUpstream` | must `== <merge-base>` (pinned `e489657`) | we took theirs, intentionally |
| `handMerge` | enumerated, allowed to differ | genuine merge; **gate-blind → mandatory per-file review** |

The gate (`verify-keep-ours.mjs`) re-derives the 250-file contested set **independently** of the
manifest and asserts `keepOurs ∪ adoptUpstream ∪ handMerge == contested`, failing on **any**
unclassified file. That is what kills serial discovery: no file can land as took-upstream without
a conscious classification. Then it verifies each bucket's resolution mechanically.

`handMerge` files are gate-blind by design — intra-file regressions (e.g. a dropped registry
preference inside an otherwise-wanted merge) hide there. They are covered by a **mandatory
per-file changelog + review**, not the mechanical check.

## Pins (do not drift)

- **ours** = `18f373a` (v0.30.93, the reverted-to known-good).
- **upstream base** = `git merge-base reconcile/23blocks-merge origin/main` = `e489657`
  (asserted; self-correcting vs a moving `origin/main`). Contested count asserted == 250.
- **reconcile tip** = `b11deeb` (canonical remote tip, includes Decision-5 fold-in). The *local*
  `reconcile/23blocks-merge` branch is stale (`f952215`) — never classify against the branch name.
- `GIT_LITERAL_PATHSPECS=1` everywhere — 24 bracketed route paths (`app/api/.../[id]/...`) would
  otherwise be glob-interpreted and silently mis-compared.

## Usage

```bash
node scripts/reconcile/build-manifest.mjs              # regenerate the partition
node scripts/reconcile/verify-keep-ours.mjs            # the gate (exit 1 = worklist remains)
node scripts/reconcile/verify-agent-container-requires.mjs   # #H crash-on-require guard
yarn test tests/reconcile-gate.test.ts                # both, via vitest (the merge gate)
```

The gate is **RED until the `keepOurs` restore worklist + surgical fixes land** — that is correct;
it is the merge gate, not unit coverage. A failing run prints the exact remaining restore worklist.

## Known residual risk: `server.mjs` (adoptUpstream, canary-gated)

The gate kills the "unclassified file" failure class permanently. The residual class it
*cannot* catch is a **high-risk file MISclassified as adoptUpstream** — the gate asserts
`== upstream` but cannot judge whether adoptUpstream was the right *call*. `server.mjs` is
the one to watch: a 966+/92− wholesale swap of the most constraint-laden host file
(WS upgrade handler + session pooling). Both halves of the terminal contract were diffed:

- **Server-side (KAI):** upstream's single `history-complete` emit is *not* a dropped fix —
  it's unconditional after a 150 ms `setTimeout`, covering both paths ours covers with two
  emits. Upstream's terminal-history path differs architecturally: inline
  `capture-pane -e -p -S -5000` (ANSI, 5000 lines) + **delayed-broadcast-join** to discard the
  tmux-attach redraw, vs ours' `runtime.capturePane()` (2000-line, no-escape) + immediate join.
- **Client-side (Watson):** `TerminalView` @18f373a gates on `history-complete` (resets
  `historyLoaded` each connect), so upstream's emit opens the gate — **the eb3e705c hang-mode
  does not recur**. The client has no own content-dedup and writes ANSI natively via
  `xterm.write()`, so `-e` is richer, not a corruption source. The redraw dedup is therefore
  *entirely server-side*; the client cannot compensate if the server under-discards.

**Net:** the canary risk narrows to a single assertion — does the delayed-broadcast-join fully
discard the attach redraw? Acceptance (Watson's HOST local-tmux canary; cloud-Hale does not
exercise `server.mjs`): a host local-tmux agent **with scrollback** → reconnect shows history
**once, no duplicate visible area**, `Ctrl+L` redraws clean, no width/Unicode corruption, no
hang. If a duplicate visible area appears, the surgical fix is to port *only* the delayed-join
onto ours (keep the richer upstream capture) — not a full keepOurs.

## Clearing the worklist (execution)

1. **keepOurs restores** (deterministic, no judgment): for each file the gate lists as
   "NOT == ours", `git checkout 18f373a -- <file>`.
2. **handMerge surgical fixes**: hand-edit per the manifest rationale; produce a per-file changelog
   (RESTORED-from-ours vs KEPT-AS-MERGED) as the review artifact for these gate-blind files.
3. **review-flagged adoptUpstream** (`reviewFlaggedAdoptUpstream` in the manifest): ESCALATE feature
   calls left as upstream — reviewer ratifies consciously.
4. Re-run the gate until green; then boot-smoke the agent image (content-present ≠ runs) and run the
   real-history canary (existing agent with scrollback) before any host roll.
