# Spec: Always-On PR-Review Agent (Multi-Repo Reviewer)

> **Status:** DRAFT / SPEC — *not yet built or verified*. Authored by Watson 2026-06-09 from a design consult with Shane. Items below are **PROPOSED** unless they cite an already-verified mechanism in the [Cloud Coding Agent Runbook](./CLOUD-CODING-AGENT-RUNBOOK.md) (referenced as "Runbook §N").
>
> **Placement decision (open):** this can live as a standalone runbook OR fold into the Cloud Coding Agent Runbook as a "review-only variant" section. The mount/lifecycle/auth machinery is shared; only the *role* differs. Written standalone for now; fold-in points are noted inline.
>
> **Decisions locked 2026-06-09 (Shane):** program = **Codex** (currently excellent at PR review in Codex desktop); GitHub identity = **dedicated bot account** (yes); **external-contributor PRs are NEVER in scope** — only N4 Safety Alliance OS + internal repos (Ziggy, AI Maestro, gateways); trigger = **Discord doorbell** (reuses the existing no-open-port Discord watcher) with direct webhooks reserved for where an endpoint is unavoidable (Teams). Remaining open items in §10.

---

## 1. What this agent is — and why it's different

An **always-on, multi-repo reviewer**. Its entire job: a PR notification arrives → it fetches the right repo, checks out the PR → reviews → posts findings → returns to idle. It is **not pointed at one repo** and it **never builds, commits, or pushes** — it keeps a *library* of working copies it reads from.

This single fact (reviewer, not builder) flips the Runbook's core rationale:

| Dimension | Coding agent (Runbook) | Review agent (this spec) |
|---|---|---|
| Relationship to repos | Edits **one** repo; the working tree is the deliverable | Reads **many** repos; working copies are a disposable **cache** |
| "Clean reviewable tree" rationale | Load-bearing (someone reviews *its* tree) | **N/A** — nobody reviews its working copies |
| "N-agent collision" rationale | Load-bearing (many builders, one repo) | **N/A** — single agent |
| Git posture | fetch / branch / commit / push | fetch / checkout PR ref / **read-only** (never commit/push) |
| What's precious | identity **and** working tree | **identity only**; repos are regenerable |

**Consequence:** the repo copies are disposable scratch. That, not the builder's "clean tree" logic, drives the container spec below.

---

## 2. Container & mount topology (PROPOSED)

Single agent, **two persistent host mounts** at identical host=container paths (Runbook §1 pattern, adapted):

| Mount | Size | Lifecycle | Holds |
|---|---|---|---|
| **Home** — e.g. `/home/gosub/agents/<reviewer>` | small, **precious** | survives recreate/image-swap | AMP identity, `gh` token/cred, review log (dedup history), on-wake instructions file, scratch |
| **Repo library** — e.g. `/srv/review-repos` | large, **disposable** | wipe/prune freely | working copies of watched repos + their graphify graphs + build/test caches |

**Why two mounts, not one growing workspace** (the refinement on the "single workspace" instinct):
- **Disk reclaim / repo reset must not touch identity.** With one combined workspace, blowing away a corrupted repo or reclaiming disk risks his creds/keypair/history. Separate disposable repo mount → `rm -rf` a repo (or the whole library) and he re-clones next review; home untouched.
- **Identity survives image/toolchain swaps** (Runbook §1, §6) — load-bearing for an always-on agent that *will* get image updates. Pin AMP keypair + `gh` auth + review history in the mount `update-runtime` preserves.
- The substrate instinct is correct: **persistent host-side storage outside the container lifecycle**. The only change is cleaving precious-home from disposable-cache.

**Hard rules (from Runbook §1):**
- **Never mount over `/home/claude`** — 8 reserved subpaths (AMP identity + provider creds) are bind-mounted there; `validateMounts` rejects collisions. Use identical-path dirs of your own.
- **Pre-create host paths owned by the host user before create** (docker auto-creates missing `-v` targets as root → breaks the non-root `claude` user) (Runbook §2).
- **Pin `cpus`/`memory` explicitly** in the `.cloud.runtime` block — legacy agents silently downsize to defaults on recreate/update-runtime. Reviews + optional test runs + graphify rebuilds want real headroom.

---

## 3. The repo library (PROPOSED)

- **Persistent + warm** (Shane's instinct, endorsed): the value of always-on is warm state — incremental `git fetch` over full clone, warm graphify graphs, warm build caches.
- **Explicit repo allowlist.** The agent may only clone/review repos on a configured allowlist (in home or env). Prevents a malformed/forged trigger from cloning arbitrary URLs. **(SECURITY — load-bearing.)**
- **Prune policy.** Cap library size; `git gc` periodically; drop repos untouched in N days (re-clone is cheap). Mount on a volume with real headroom.
- **One working copy per repo.** Reviews are serialized (§7), so a single copy per repo is enough; fetch + checkout the PR ref per review. For per-PR test isolation, use a **throwaway `git worktree`** off the copy (Runbook §7.6 topology, reused tactically) and remove it after.

---

## 4. Identity & auth (DECISIONS REQUIRED)

Two identities:
1. **Mesh / AMP identity** — standard, lives in home (Runbook §5). Used to receive triggers and (optionally) report status.
2. **GitHub identity — DECIDED: dedicated bot account.** Two ways to implement it; pick by §10:
   - **(a) Machine user + fine-grained PAT.** ⚠️ **SUPERSEDED — see §10 decision: GitHub App was chosen.** A fine-grained PAT *cannot* enforce least-privilege on these repos: they're owned by the `swickson` personal account where the bot is only a collaborator, and (verified) fine-grained PATs can't scope another personal account's repos + personal-repo collaborators get only the write role. Kept below for the rationale trail only. Create a new GitHub account (e.g. `n4-review-bot`), add it as a **collaborator** (read/triage) on the N4/internal repos (or to the org). Generate a **fine-grained PAT** scoped to exactly those repos with permissions: **Pull requests: Read & Write** (post review comments), **Contents: Read** (clone/fetch), **Metadata: Read**. Nothing else — no admin, no merge, no contents:write. Drop the token in the agent's home: `gh auth login` with the token, or `GH_TOKEN` via extraEnv. Private-repo collaborators are unlimited on current GitHub plans, so a machine user is free.
   - **(b) GitHub App (the "do it right / scale it" path).** Register an org App with `pull_requests: write` + `contents: read`; install on the repos. Comments post as `n4-review-bot[bot]`; auth is **short-lived installation tokens** (no long-lived PAT to leak). Heavier setup (app reg + private key + token minting). **Bonus convergence:** a GitHub App *also* delivers the `pull_request` webhook — so if you ever go the direct-webhook route (§5 option C), the App is one construct for *both* the review identity and the event source.
   - Token/identity lives in home so it survives recreate/image-swap (§2).
3. **Approve rights — comment-only (recommended).** As a *separate* identity he technically *could* `--approve` these PRs (GitHub only blocks self-approval). Keep him **`gh pr comment` / `--request-changes` only** — he advises, humans/Shane merge. Matches the mesh "never merge without Shane OK" posture (Runbook §6 spirit). Enforced naturally if the PAT is PR:write-but-not-an-approver-policy, or just by convention in his instructions.

---

## 5. The trigger path (PROPOSED — options)

**DECIDED: Discord doorbell** — chosen for a concrete security property, not convenience.

**Why Discord (verified 2026-06-09):** the discord-gateway uses `discord.js` `client.login()` — an **outbound** WebSocket to Discord's Gateway — so it receives messages with **NO internet-facing inbound port** (its `httpApp.listen` is only the local management/health API). It already ships **`WatchWebhookEntry` / `matchWatchWebhook`** plumbing: configure it to *watch a channel* for webhook-posted messages — exactly what GitHub's native Discord webhook produces. So:

```
GitHub repo → (GitHub's native Discord webhook) → Discord channel
   → discord-gateway WatchWebhook match → AMP to the reviewer (no open port anywhere)
```

**The "unstructured text" concern is moot here:** Discord is only a **doorbell**. The GitHub embed carries the PR URL; the agent parses `owner/repo/PR#` from it, then `gh pr view --json …` provides fully structured data. Discord delivers the *event*, `gh` delivers the *payload*.

**Multiplexing bonus:** many sources already post to Discord, so one no-port watcher fans in GitHub PRs alongside everything else.

**Direct webhooks — reserved for where unavoidable (Teams), and feasible when needed.** The gateways framework *already* exposes inbound webhooks: the Teams gateway (Phase-2) serves per-bot `/api/<slug>/messages` POST routes for the Bot Framework. A GitHub webhook gateway (chat-sdk lists GitHub as a platform; or a GitHub App's `pull_request` delivery) would mirror that shape and yield **structured** events. When such an endpoint is stood up, harden it the way Shane specced: **Nginx Proxy Manager in front, US-IP allowlist (scoped further if possible), a shared secret / signature check, and Nodie watching the logs**. For *this* agent, the Discord doorbell means GitHub needs none of that.

- **Fallback option — poll** `gh pr list` across allowlisted repos on an interval. No event infra at all; ~minutes latency. Keep as the degraded-mode backstop if the Discord path is ever down.

Whatever the channel, the trigger only needs **repo + PR#**; the agent derives base/head with `gh`.

**Dedup / idempotency (load-bearing, mirrors Teams gateway `activity.id` dedupe):** GitHub fires `opened`, then `synchronize` on **every push**, plus `reopened` / `ready_for_review`. Key the review log on **(repo, PR#, head SHA)**. Review on `opened` + `synchronize`-with-new-SHA; skip drafts; never re-review the same head SHA.

---

## 6. The review loop (PROPOSED)

Mirrors the playbook run live against Bishop's gateways PRs #2/#3 (2026-06-09):
1. Resolve repo + PR# from the AMP trigger.
2. `cd` to the library copy → `git fetch` → `gh pr checkout <n>` (or fetch the PR ref). **Never `git pull` a dirty tree** — fetch + checkout the PR branch cleanly.
3. Review: `gh pr view`, `gh pr diff`, read changed files, cross-reference. Verify claims against live code, not just the diff.
4. Optional: typecheck / run tests **in a throwaway worktree** (see §7 security caveat first). Remove the worktree after.
5. Post via `gh pr comment` (or `gh pr review --request-changes` for blocking). Cross-host/identity note: cannot `--approve` own-org PRs under a shared identity.
6. Append `(repo, PR#, head SHA, verdict)` to the home review log; return to idle.

**Always-on posture:** idle between reviews; the mesh's tmux push-notification on AMP arrival re-invokes him. Long reviews are fine — new triggers queue in the AMP inbox and drain after.

---

## 7. Security (scope-relaxed — internal repos only)

- **External-contributor PRs are NEVER in scope (DECIDED).** Targets are N4 Safety Alliance OS + internal repos (Ziggy, AI Maestro, gateways) only. All PR authors are trusted teammates/agents, so **checking out PR branches and running their tests is acceptable** — the untrusted-code-execution / RCE concern that would otherwise gate test-running does not apply. (Container isolation remains as defense-in-depth, not as the thing standing between us and a hostile PR.)
- **Repo allowlist** (§3) still bounds what he can clone — it guards against a malformed/forged *trigger*, not against the repo authors.
- **Comment-only GitHub scope + least-privilege PAT** (§4) bound blast radius if the agent is ever confused/compromised.
- **Trigger authenticity:** the Discord doorbell inherits the gateway's existing content-security + the channel's own access control; the agent should still sanity-check that the parsed `owner/repo` is on the allowlist before cloning. If the direct-webhook path is ever used, the secret/signature check (§5) is the authenticity gate.

---

## 8. Graphify integration (STRONG SYNERGY — graphify is now installed host-wide, 2026-06-09)

A reviewer's most common operation — "what does this change touch / who calls this" — is exactly `graphify query` / `graphify affected`. The persistent repo library makes this free:
- Seed `graphify update .` per repo (AST-only, **no LLM backend needed**); the post-commit/post-checkout hooks keep each graph warm as the repo updates.
- He reviews impact via one graph query instead of grepping the tree.
- Caveat: graphify is currently **host-installed only**; cloud-container parity is a pending Hutch follow-up. A containerized review agent needs graphify baked into its image (same recipe sent to Hutch).

---

## 9. Concurrency (PROPOSED)

- **Serialize for v1** — one review at a time; drain the AMP inbox afterward. Simplest and safe.
- Fan-out (parallel reviews, or per-repo workers) only if volume demands — a v2 concern, not initial spec.

---

## 10. Decisions

**Locked (2026-06-09):**
- ✅ **Program:** Codex.
- ✅ **GitHub identity:** dedicated bot account.
- ✅ **Approve rights:** comment-only.
- ✅ **Trigger:** Discord doorbell (no open port); direct webhooks reserved for Teams-style unavoidable cases.
- ✅ **External PRs:** never — internal repos only; PR-test-execution is therefore safe.

**Locked (2026-06-10, Shane):**
- ✅ **Bot identity implementation:** **GitHub App** (reversed from PAT after a verified blocker). Permissions: `pull_requests: write` + `issues: write` (classify/label/comment-route) + `contents: read` (NO contents:write) + `metadata: read`. **Agent name: Columbo** (mesh display) / GitHub App slug **`n4x-columbo`** → comments sign as `n4x-columbo[bot]`. Columbo is the single GitHub front-door: PR review + issue triage/routing in one agent (see §1/§5 decisions). **Token-minter credential set:** JWT `iss` = **Client ID** (`Iv23…` — GitHub-recommended over the numeric App ID; verified docs 2026-06-10), signed with the `.pem` private key, then `POST /app/installations/<install-id>/access_tokens` for a short-lived scoped token. Store `.pem` + Client ID + install IDs in agent home (currently staged at `/home/gosub/n4x-columbo.*` on Holmes — **must move into Columbo's home mount** at build, not stay in the host homedir). **VERIFIED 2026-06-11 (Watson, Holmes):** JWT→installation-token→scoped-repo chain works; Client ID `Iv23li40UW1VO1FpVPAz`; swickson installation_id `139685565` scopes to exactly the 5 swickson repos with the 4 perms above (no push). `SEACWORX/allianceos` org install **VERIFIED 2026-06-11** as installation_id `139704047` (selection=selected, scoped to `allianceos` only). All 6 allowlist repos now reachable via scoped tokens, no push. Known-good minter: JWT signed RS256 with `iss`=Client ID, `iat`=now-60, `exp`=now+540; `POST /app/installations/<id>/access_tokens`; use returned `ghs_…` token (≤1h TTL) as `Authorization: token`. Rationale: the watched repos are owned by the **`swickson` personal account**; the reviewer is only a *collaborator*, and **(a)** personal-repo collaborators get only the **write** role (triage is org-only) and **(b)** fine-grained PATs **cannot scope repos owned by another personal account** (verified — GitHub docs: "Each token is limited to access resources owned by a single user or organization"; resource-owner picker shows only your own account + your orgs). So on these repos *no PAT can enforce least-privilege* — only a classic PAT works and it's broad `repo` scope = push-capable. A **GitHub App's installation token is scoped to exactly the App's permissions regardless of collaborator role → the bot physically cannot push/merge.** The App also: works uniformly on personal + org repos (covers `SEACWORX/allianceos`), uses short-lived tokens, is the construct that scales to a per-orchestrator bot fleet, and can later supply the `pull_request` webhook. **Consequence: collaborator invites are obsolete** (an App is *installed* by the repo admin, not invited as a user); the `n4x-review-bot` user account is no longer load-bearing.
- ✅ **Placement:** fold into the Cloud Coding Agent Runbook as a "§N Review-only variant" section — inherits §1–6 shared machinery, overrides the reviewer-role parts.
- ✅ **Initial repo allowlist (6 repos, slugs resolved + verified 2026-06-11):** `swickson/ai-maestro`, `swickson/ai-maestro-plugins`, `swickson/aimaestro-gateways`, `swickson/ziggy`, `swickson/n4safety-app`, `SEACWORX/allianceos`.
- ✅ **v1 trigger:** Discord doorbell from day one (not poll-first). Poll (`gh pr list`) demoted to degraded-mode backstop only.
- ✅ **Disk budget:** cap `/srv/review-repos`, periodic `git gc`, drop repos untouched 30d (re-clone cheap). Exact ceiling settled with Hutch at build.

**Resolved 2026-06-11 (build complete):**
1. ✅ **Discord wiring** — single shared GitHub-alerts channel; one `WATCH_WEBHOOKS` triple appended in `discord-gateway/.env` → AMP to `dev-columbo-holmes@n4x-corp.aimaestro.local`; gateway restarted + verified (both watch entries live, Discord connected).
2. ✅ **Repo slugs** — finalized as the 6-repo allowlist above; library seeded.

**Only remaining go-live gate:** interactive `codex login` in Columbo's container tmux (OAuth — operator's lane; determines spend attribution). *(Completed 2026-06-11; end-to-end Discord→triage verified live on a real `allianceos` issue.)*

**Routing + autonomy roadmap (2026-06-11):**
- ✅ **Repo → orchestrator routing live for issue triage.** Columbo holds a verified repo→lead AMP map (COLUMBO_INSTRUCTIONS.md §3A): ai-maestro/-plugins→KAI, gateways→Bishop, ziggy→dev-ziggy-orchestrator, n4safety-app→Zach (`dev-n4safety-operator`), allianceos→Luke (`dev-allianceos-luke`). On triage he AMPs the repo's lead.
- 🔜 **PR-review auto-handoff (NOT yet — gated on Shane):** detect PRs from the internal team → after posting the review, AMP the repo lead the review/handle → that team folds it in and continues autonomously, no human in the loop. Foundation (routing map + provenance check) is the next phase; review-routing stays OFF until explicitly enabled (COLUMBO_INSTRUCTIONS.md §5B).

---

## 11. Provisioning checklist (handoff-ready for Hutch — docker lane)

> Build only after §10 decisions land. Container build/image work is Hutch's lane (per mesh convention).

- [ ] Pre-create host dirs owned by host user: home (`/home/gosub/agents/<reviewer>`) + repo library (`/srv/review-repos`).
- [ ] Create the agent (Runbook §3a) with **two rw mounts** at identical host=container paths; pin `cpus`/`memory`.
- [ ] Program = **Codex** (DECIDED). Codex specifics: autonomy/skip-permissions flags differ from Claude (Runbook §4 per-provider reference — audit the right `--*` flags); graphify skill installs to `~/.codex/skills` via `graphify install --platform codex`, the invocation is **`$graphify` not `/graphify`**, and parallel extraction wants `multi_agent = true` under `[features]` in `~/.codex/config.toml`. On-wake hook → instructions file (Runbook §3b, §5) describing the review loop + allowlist; reinforce Codex to re-read it (per the Gemini/Codex reinforcement pattern).
- [ ] Install `gh`; drop the **scoped GitHub token** (bot identity — machine-user PAT or App, §4) in home; `gh auth status` green; confirm PR:write + contents:read on allowlisted repos only.
- [ ] Bake graphify into the image (Hutch follow-up recipe) + `graphify update .` seed per allowlisted repo (`$graphify`/codex skill path noted above).
- [ ] Seed the repo library: clone each allowlisted repo once.
- [ ] Wire the trigger: **Discord doorbell** (GitHub native webhook → channel → discord-gateway `WatchWebhookEntry` match → AMP to reviewer). Poll cron only as degraded-mode backstop.
- [ ] Verify (Runbook §8): trigger → fetch → review → comment posted → idle, on one test PR; confirm dedup on a second `synchronize`.

---

## Appendix: relationship to the Cloud Coding Agent Runbook

Shared (reuse verbatim): mount pattern & hard rules (§1), prerequisites (§2), create/hook/lifecycle mechanics (§3, §6), auth-per-provider (§5). Divergent (this spec): the **reviewer role** — disposable multi-repo library, GitHub-identity/comment-only, the trigger→review→post→idle loop, dedup-on-head-SHA, and the untrusted-code-execution caveat. If folded in, this becomes a "§N. Review-only variant" that inherits §1–6 and overrides the role-specific parts.
