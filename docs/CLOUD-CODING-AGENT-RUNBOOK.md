# Runbook: Standing Up a Cloud Coding Agent (Separate Homedir + Coding Repo)

> **Status:** Authored by the ai-maestro dev team (provisioning mechanics: §1 pattern, §2–6, §8–10; orchestration: §1 rationale, §7; wave architecture: §11). Reviewed end-to-end; all mechanics verified against a multi-provider dev-team standup + a worktree-collision incident.
>
> **§11 — Wave-based dev-team architecture** is the converged target model from a team design session: a **three-path / two-profile** container layout, per-agent code copies (the durable fix for the shared-cwd chat-state + git-tree collisions), `ai-team/` as its own orchestrator-owned repo, the **wave = one PR** human-gate model, a credential-less **bare-repo transport**, event-driven drift-merge, per-agent git identity (deploy-safe), the **port-reservation** allocator fix, and the corrected `recreate`-vs-`update-runtime` doctrine. §11 SUPERSEDES the shared-worktree topology in §7.6 for cloud dev-teams; §1/§6/§7.2/§7.6 carry forward-pointers to it.
>
> **Pattern scope:** how to stand up a sandboxed cloud (local-container) coding agent whose **home directory and the code repo it works on are separate mounts** — the agent has a stable scratch/identity home, and edits code in a distinct repo mount. It intentionally does NOT prescribe a specific bind-mount topology (e.g. worktree-over-shared-.git) — that's a project choice layered on top (the converged team topology is §11).
>
> **Conventions:** examples use placeholders — `<operator>` for the host user, `/home/<operator>/…` for host paths, `<host-id>` for a host, `<mesh-domain>` for the mesh address suffix, `<agent-id>` for a UUID, and `<owner>/<repo>` for a GitHub repo. Substitute your own values.

---

## 1. The "separate homedir + coding repo" pattern

A cloud coding agent gets **two distinct rw mounts** (plus whatever the project adds):

1. **Home dir** — a small per-agent dir for the agent's own scratch/context (e.g. a provider context file). Mounted at an **identical host=container path**, NOT over the container's system home.
2. **Coding repo** — the code the agent edits, a separate mount at an **identical host=container path** so absolute paths and git resolve in-container.

> **For a wave-based dev-team (§11)** this generalizes to **three** paths per container — `$HOME` (identity), `/workspace` (a **per-agent** code copy, not a shared mount), and `/ai-team` (a shared orchestrator-owned repo, read-only for workers) — in two profiles (worker vs orchestrator). Per-agent code copies are what dissolve the shared-cwd chat-state and git-tree collisions; see §11.1.

Why separate (vs. agent-home == workspace):
- **Scratch/identity isolation.** The home holds the agent's provider creds, context file, and working scratch (review clones, `/tmp` artifacts, build logs). Keeping that out of the code repo means agent churn never pollutes the working tree or `git status` — the repo stays a clean, reviewable surface, and the home stays disposable/rebuildable.
- **Multi-agent collision avoidance.** N agents can share **one** code-repo mount (or per-agent worktrees of it) while each keeps a **private** home, so their scratch and identity never collide even when they edit the same codebase. Agent-home == workspace makes every agent's scratch a change in everyone's tree.
- **Fresh-reviewer story.** Review runs out of the reviewer's **own** home (an isolated clone or read-only inspection), so a reviewer can hibernate→wake with flushed context and judge the builder's work without their own working state bleeding in (see §7's no-self-verification rule).
- **Identity survives image/toolchain swaps.** The home (and the per-agent AMP/cred mounts under it) persists across `update-runtime` recreate, so the agent's mesh identity + auth survive a node/image migration while the code repo is independently swappable.

**Hard rule — never mount over `/home/claude`.** The container's home (`CONTAINER_HOME=/home/claude`) is system-owned: Maestro bind-mounts 8 reserved subpaths there for AMP identity + provider credentials (`.agent-messaging`, `.aimaestro`, `.local`, `.claude`, `.claude.json`, `.gemini`, `.codex`, `.config/gh`). Operator mounts that collide are rejected by `validateMounts`; mounting over the whole home shadows baked state. Use an **identical-path dir of your own** (e.g. `/home/<operator>/agents/<name>`), matching the proven baseline (`/mnt/agents/<name> -> /mnt/agents/<name>`).

---

## 2. Prerequisites

- Host paths exist BEFORE create (docker auto-creates missing `-v` targets as **root**, which breaks the non-root `claude` user). Pre-create the home dir + repo dir owned by the host user.
- A provider context file in the home dir if desired (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`). NOTE: it won't auto-load as provider memory unless it's the cwd or system home — the real instruction channel is the on-wake hook → an instructions file (see §5).
- Image: the standard `ai-maestro-agent:latest` (node22 + user-owned npm prefix, so the in-container `claude` user can self-update the CLIs without sudo).

---

## 3. Step-by-step

### 3a. Create the agent
`POST /api/agents/docker/create` (body = `DockerCreateRequest`). Key fields:

```jsonc
{
  "name": "dev-team-myagent",            // becomes session name; mesh identity slug
  "label": "MyAgent",
  "program": "claude",                    // claude | codex | gemini | antigravity
  "hostId": "<host-id>",                  // MUST be the canonical self host id (lowercase)
  "programArgs": "--dangerously-skip-permissions",  // PER-PROVIDER autonomy flag — see §4
  "workingDirectory": "/home/<operator>/projects/myrepo",  // bound to /workspace; agent's cwd
  "mounts": [                             // operator SandboxMount[] — identical paths
    { "hostPath": "/home/<operator>/agents/myagent", "containerPath": "/home/<operator>/agents/myagent", "readOnly": false },
    { "hostPath": "/home/<operator>/projects/myrepo", "containerPath": "/home/<operator>/projects/myrepo", "readOnly": false }
  ]
}
```

Returns `{ agentId, containerId, port, containerName }`. AMP identity is **auto-bootstrapped** at create (`ampRegistered=true`, per-agent Ed25519 keypair + `.agent-messaging` mount); `hostId` makes it cross-mesh resolvable. No manual AMP wiring.

### 3b. Set the on-wake hook (post-create PATCH)
`hooks` is NOT a create field — set it after:

```bash
curl -X PATCH http://localhost:23000/api/agents/<agentId> -H 'Content-Type: application/json' \
  --data '{"hooks":{"on-wake":"You are dev-team-myagent, display name MyAgent. cd /home/<operator>/projects/myrepo and read ai-team/MyAgent_INSTRUCTIONS.md, then follow it."}}'
```
For **Gemini/antigravity** agents, add reinforcement ("…then re-read and follow it exactly") — Gemini reads loosely without it.

### 3c. Tags (optional)
`PATCH … {"tags":["dev","myteam"]}` for grouping.

### 3d. Verify (see §8 checklist).

---

## 4. Per-provider reference

| Provider | `program` | In-container binary | Autonomy flag (put in `programArgs`) | Auth |
|----------|-----------|--------------------|--------------------------------------|------|
| Claude   | `claude`  | `claude`           | `--dangerously-skip-permissions`     | interactive `claude` OAuth in-container |
| Codex    | `codex`   | `codex`            | `--dangerously-bypass-approvals-and-sandbox` | interactive `codex login` in-container |
| Gemini (legacy) | `gemini` | `gemini`     | `--yolo`                             | Google OAuth |
| **Antigravity** (current Gemini standard) | `antigravity` | `agy` | `--dangerously-skip-permissions` | Google OAuth (`~/.gemini/oauth_creds.json`, auto-seeded from host at create) |

**Platform standard:** "a Gemini agent" now means **antigravity** (program=`antigravity`, binary `agy`), not the legacy `gemini-cli`. Use antigravity unless you specifically need legacy gemini-cli.

**Autonomy is per-provider** — `--dangerously-skip-permissions` is CLAUDE-ONLY; baking it into codex/gemini breaks launch (unrecognized flag). Use the table.

**AMP-scripts PATH gotcha (non-Claude agents).** The AMP CLI lives at `/home/claude/.local/bin/` and **is** on the container shell PATH (default `sh` and login shell both resolve `amp-send`) — so a human in tmux or a `docker exec` probe finds it fine. But **Codex's command-execution environment doesn't surface that PATH** (observed standing up a Codex review agent: it couldn't invoke `amp-send` by bare name until steered). Claude agents inherit it and don't hit this. **Fix: in any non-Claude agent's instructions, reference AMP by absolute path** (`/home/claude/.local/bin/amp-send`) or have it `export PATH=/home/claude/.local/bin:$PATH` first — and verify by what the *harness* sees, not what `docker exec`/tmux shows (they mislead here).

---

## 5. Auth setup (per provider)
- **Claude:** interactive OAuth — run `claude` once in the container's tmux session; the credential persists via the bind-mounted `~/.claude`.
- **Codex:** `codex login` in-container (writes `~/.codex/auth.json`, persists via the per-agent `~/.aimaestro/agents/<id>/codex-auth.json` bind mount). At create it's an empty `{}` stub until you log in.
- **Antigravity/Gemini:** Google OAuth at `~/.gemini/oauth_creds.json`, auto-seeded from the host's `~/.gemini/oauth_creds.json` at create — often already authed if the host has valid creds; otherwise interactive Google auth once.
- All auth files are bind-mounted per-agent, so they **persist across hibernate/wake and recreate**.

---

## 6. Lifecycle (CRITICAL mechanics)

- **wake** (`POST …/wake`) = `docker start` of the **existing** container → relaunches the **baked** `AI_TOOL` env. It does **NOT** pick up a new image or re-read the registry.
- **hibernate** (`POST …/hibernate`) = `docker stop` (clean SIGTERM, exit 0). Cloud containers are `docker run -d` + `--restart unless-stopped`; a host `pm2 restart` does **not** stop them (only an explicit hibernate does).
- **recreate to change image or programArgs** — a wake won't do it. Use `POST …/update-runtime` with `{}` (rebuilds the container on the pinned-tag image, normally `ai-maestro-agent:latest`). **`update-runtime` is the identity-preserving primitive** (the default for almost everything — see §11.8): it **preserves** UUID + AMP keypair + per-agent state dir + message history + mounts + on-wake hook + programArgs, **AND re-runs the update-runtime provisioning path** (config + auth + mounts — verified: a prior change made it re-provision codex config/auth; confirmed in a production identity-preserving migration). Because it rebuilds from the **current** image tag, an offline container that was frozen on an older created-from image **catches up** on image-level fixes too. It does **NOT** pull a fix that only runs in a create-only or recreate-only path. `/recreate` ROTATES the UUID **by design** → forces a new AMP keypair, a fresh state dir, and breaks long-lived refs (peer caches, kanban assignments, dashboards, message history) — **avoid for any agent with history; use it only when you deliberately want a fresh identity** (see `agents-docker-service.ts`).
- **`AI_TOOL` composition** honors `body.yolo` and `body.programArgs`, **NOT** `body.permissionMode` (permissionMode is the host-tmux wake path only). So put autonomy in `programArgs` (it survives recreate; `yolo` does not).
- **on-wake hook fires on wake**, NOT on `update-runtime`. So after a recreate the session is fresh + unprimed → **hibernate then wake** to fire the hook and prime it. Migration pattern: **recreate → hibernate → dispatch-then-wake**.

---

## 7. Orchestration & multi-agent coordination

The §1–§6 mechanics stand up **one** agent. This section is the layer on top: running a **team** of them to build + review software. Pattern proven on a multi-provider dev-team standup (one orchestrator + several workers).

### 7.1 Team shape
- **One orchestrator** (typically a host agent with full repo access + the only push/PR credentials) + **N workers** (containerized, one `program` each). Picking workers across providers (e.g. Claude / Codex / Antigravity) makes cross-provider review **automatic** — see 7.5. Roles (e.g. "security", "architecture") are lenses, not walls.
- Each worker = own **home** (free identical path) + the **code-repo** mount (identical path). Stand up **one worker as a canary first** — smoke-test hibernate→wake, the AMP round-trip, and that the on-wake hook actually reads its instructions file — before creating the rest.

### 7.2 Coordination-dir pattern
- A shared **coordination dir** (e.g. `ai-team/`) is mounted into — or nested inside — **every** agent's repo path, so the orchestrator's living plan, per-agent `*_INSTRUCTIONS.md`, and protocol docs are visible to all agents on the **same path, instantly**.
- It is **gitignored** (keeps team operational state out of the shipped branch) **but shared** (same physical mount). Gitignored ≠ private within the team.

> **§11 refinement:** for the wave-based team, `ai-team/` becomes **its own orchestrator-owned git repo** (versioned + orchestrator-managed), mounted **read-only for workers** and read-write for the orchestrator — NOT a gitignored dir *inside* the coding repo. Keeping it a separate repo gets both goals at once: it is git-versioned/managed AND it never lands in the shared coding repo that non-maestro devs clone. The single-writer (orchestrator) / read-only-workers rule is what keeps the one remaining shared mount from re-introducing a collision. See §11.2.
- The per-agent `<Name>_INSTRUCTIONS.md` is the **real instruction channel** (the on-wake hook points at it — §3b). The orchestrator **owns** the living plan doc and refreshes it every dispatch/completion/hibernate so it never diverges from reality; workers read it.
- **Mirror caveat:** to surface a doc that lives **outside** the agents' mounts (e.g. another repo's `docs/`), **copy** it into the coordination dir — a symlink to an unmounted target dangles in-container.

### 7.3 Two gates on every task
- **Greenlight Gate** — *no code before an approved plan.* The worker first replies with a build plan (file list, approach, DoD, any contract impact); the orchestrator approves (or redirects); **then** the worker codes. Catches design divergence for the price of one message.
- **Acceptance Gate** — *no acceptance without a verifiable commit hash AND the orchestrator independently re-running the claim* (next rule).

### 7.4 The orchestrator verifies every claim host-side — with TRUE exit codes
- **The trap that bit us:** a worker's "all green" can be a **pipe-masked false-green**. `tsc … | head` returns the *pipe's* exit status, not `tsc`'s, so a failing typecheck reads as success. **Gate on `cmd > log 2>&1; echo EXIT=$?`, never on piped output.** The orchestrator re-runs typecheck/tests **on the host**, it does not trust the report.
- **Scope-check every commit** (`git show --stat <sha>`): confirm it touched only what it claimed (no drift into untouched modules, no test files in a build commit).
- Verification is cheap insurance: in this standup it caught a builder false-green **and** a reviewer false-positive that would otherwise have entered a gate as "done."

### 7.5 Cross-review with hibernate-wake (no self-verification)
- **The builder never verifies their own work.** The orchestrator **hibernates the builder** (to flush its context) and **wakes a different worker** — automatically a different provider — to review, and to **author tests from the spec, not the implementation**.
- The hibernate→wake flush is load-bearing: a reviewer that comes in with its own build context still loaded pattern-matches the code against what *it* would have written and skips the same cases. A fresh context reads the spec, reads the code, runs the tests, and judges behavior.
- Multi-provider lenses are **complementary in practice** — each provider repeatedly caught defects the others missed (e.g. a correctness gap vs. a crash-on-multibyte-input vs. a boundary issue).

### 7.6 Code-isolation topology (worktree-over-shared-`.git`) — a project choice, and its failure mode

> ⚠️ **SUPERSEDED for cloud dev-teams by §11.1 (per-agent code copies).** The shared-`.git` worktree topology below caused a live working-tree/HEAD collision (a worker's `git checkout` detached the orchestrator's host HEAD mid-task) — that is exactly the class the wave architecture removes by giving **each agent its own full `/workspace` checkout**. Keep §7.6 only for the narrow case where you deliberately want a shared object store and accept the read-only-discipline rule below; for a wave-based team, use §11.

One way to let N workers edit the same codebase without trampling each other: give each worker its **own git worktree** over a **shared canonical `.git`**, every worktree at an **identical host=container absolute path**. Workers see each other's commits (shared object store) with no working-tree edit collision. **Requires** the shared `.git` mounted at an identical path so each worktree's `gitdir:` pointer resolves in-container.

> ⚠️ **Failure mode — put this front and center.** A reviewer's container mounts only **its own** worktree, not the builder's. If a reviewer runs `git worktree add` / `git checkout <other-branch>` against the **shared bind-mounted `.git`** to reach the builder's branch, it **re-registers that worktree to the reviewer's container path** and **detaches the host's checkout/HEAD** — silently orphaning the builder's host worktree. (It bit us. Nothing was lost — branch + commits live in the shared object store — but the pipeline stalls until recovery: `git worktree prune` → restore the detached host HEAD → re-attach the orphaned worktree.)
>
> **Rule:** reviewers **never run mutating git on another worker's branch.** Inspect read-only via `git show <sha>:<path>` / `git diff <a> <b>`. To run or author tests, work in an **isolated clone in the agent's own home** (a separate `.git` — no shared-worktree collision), then `git format-patch` and hand the **orchestrator** the patch; the orchestrator `git am`s it onto the builder's branch on the host (preserving authorship). **Only the builder commits to its own worktree; only the orchestrator pushes.**

### 7.7 Dispatch / hibernate-wake cadence
- **dispatch-then-wake:** queue the task AMP while the worker is hibernated, **then** wake — the wake fires the on-wake hook (primes the worker) and it picks up the queued task. (A bare wake on a freshly *recreated* container is unprimed — see §6's recreate→hibernate→dispatch-wake.)
- **Build phase:** the worker is awake; the orchestrator monitors via AMP and stays awake across the whole build→review cycle (it can't hibernate itself). **Idle workers → hibernate** to flush context + free resources; wake them **fresh** when their next role opens (especially right before a review, per 7.5).
- A typical unit of work: **dispatch (greenlight) → build → orchestrator verifies host-side → hibernate builder → wake reviewer fresh → reviewer patches/verdicts → orchestrator applies + re-verifies → accept.** Then the orchestrator integrates and pushes.

---

## 8. Verification checklist
After create (+ PATCH hook, + auth):
- [ ] `GET /api/agents/<id>` → name/label/program/hostId correct, `ampRegistered=true`, on-wake hook set.
- [ ] `GET /api/agents/directory/lookup/<name>` → `found=true`, `source=local` (cross-mesh resolvable).
- [ ] `docker inspect aim-<name>` → `RestartCount=0`, status running, healthy.
- [ ] in-container: `docker exec aim-<name> printenv PATH` includes the npm-global bin; `docker exec aim-<name> sh -c 'command -v <binary>'` resolves the AI CLI (NOT via `bash -lc`, which uses a stripped login PATH).
- [ ] all operator mounts visible in-container; if a coding repo, `git -C <repo> rev-parse --abbrev-ref HEAD` works in-container.
- [ ] (self-update sanity) `docker exec aim-<name> sh -c 'npm i -g <cli>@latest'` succeeds as the claude user, zero permission error.

## 9. Cleanup / rollback
- Delete: `DELETE /api/agents/<id>` (soft-delete, reversible; `?hard=true` for permanent + backup).
- Image rollback: re-tag `:latest` to the prior image digest.

---

## 10. Review-only variant — multi-repo reviewer + issue triager

A cloud agent that **reads many repos** and **never builds/commits/pushes** — it reviews PRs and triages issues, then returns to idle. It inherits §1–§6 (mounts, prerequisites, create/hook/lifecycle) and overrides only the role-specific parts below. Full design record + decision ledger: [`docs/PR-REVIEW-AGENT-SPEC.md`](./PR-REVIEW-AGENT-SPEC.md).

**What flips vs. the coding agent (§1):** the repos are a **disposable cache**, not the deliverable — nobody reviews the reviewer's working tree, and it's a single agent, so the "clean reviewable tree" and "N-agent collision" rationales don't apply. What's precious is **identity only**.

**Mounts (override §1's "coding repo"):**
| Mount | Lifecycle | Holds |
|---|---|---|
| **Home** `/home/<operator>/agents/<name>` (identical path) | precious, survives recreate | GitHub App creds (`.pem` + Client ID), AMP identity, review log (dedup), on-wake instructions file |
| **Repo library** `/srv/review-repos` (identical path) | **disposable** — `rm -rf` + re-clone freely | warm working copies of allowlisted repos + graphify graphs + caches |

Cleaving precious-home from disposable-cache means disk reclaim / repo reset never risks identity (the §1 reason, sharpened for an always-on reviewer).

**Program:** `codex` (autonomy flag `--dangerously-bypass-approvals-and-sandbox`, per §4). Codex graphify skill installs to `~/.codex/skills`; invocation is `$graphify` (not `/graphify`); set `multi_agent = true` under `[features]` in `~/.codex/config.toml`.

**Auth (overrides §5's interactive OAuth) — GitHub App, not a PAT.** *Why not a PAT:* when the watched repos are owned by a **personal account** where the reviewer is only a collaborator, personal-repo collaborators get only the **write** role (triage is org-only) AND fine-grained PATs **cannot scope another personal account's repos** (verified — GitHub docs). So no PAT can enforce least-privilege there. A **GitHub App installation token is scoped to exactly the App's permissions regardless of collaborator role → the agent physically cannot push/merge.** Example App perms: `pull_requests:write` + `issues:write` + `contents:read` + `metadata:read`; comments sign `<app>[bot]`.
- **Token-minter** (in home, openssl+curl+jq — no image bake needed): JWT signed RS256 with `iss`=**Client ID** (`Iv23…`, GitHub-recommended over numeric App ID), `iat`=now-60, `exp`=now+540; `POST /app/installations/<install-id>/access_tokens` → short-lived (`≤1h`) `ghs_…` token used as `Authorization: token`. Full chain (JWT→install-token→scoped-repo) proven, no push.
- **Creds staging:** `.pem` + Client ID live in the home mount `/home/<operator>/agents/<name>/` (move them there at build, never leave in the host homedir). Container runs as `claude`; ensure the files are readable by it.

**Allowlist (load-bearing — bounds what a forged trigger can clone):** an explicit list of `<owner>/<repo>` entries the reviewer may clone.

**Trigger — Discord doorbell (no open port):** GitHub's native Discord webhook → a GitHub-alerts channel → a `discord-gateway` `WATCH_WEBHOOKS` match → AMP to the reviewer. Append a triple `channelId:webhookId:<reviewer>@<mesh-domain>` to the existing `WATCH_WEBHOOKS` env (format proven in prod) and restart `discord-gateway`. Discord is only the *doorbell* — the embed carries the PR/issue URL; `gh`/the API supplies structured data. Poll (`gh pr list`) is the degraded-mode backstop only.

**Review + triage loop:** resolve repo+# from the AMP trigger → check it's on the allowlist → `cd` the library copy → `git fetch` → `gh pr checkout` (PR) → review (read diff + cross-ref live code, optional tests in a throwaway worktree, removed after) → `gh pr comment`/`--request-changes` (never `--approve`); for issues → classify + label/comment/route via AMP. Append `(repo, #, head SHA, verdict)` to the home review log; idle.

**Dedup (load-bearing):** key the review log on **(repo, PR#, head SHA)**. Review on `opened` + `synchronize`-with-new-SHA; skip drafts; never re-review the same head SHA.

**Security (scope-relaxed):** internal repos only, all PR authors trusted → **PR-test-execution is acceptable** (the untrusted-RCE concern doesn't apply); container isolation is defense-in-depth, not the gate. Comment-only + App `contents:read` + the allowlist bound blast radius.

**Concurrency:** serialize for v1 (drain the AMP inbox after each review); fan-out is a v2 concern.

**Fleet direction:** this is the pilot for per-agent GitHub identities (attribution + least-privilege vs. every agent sharing the operator's `gh` auth). When templatizing for the orchestrators, a **GitHub App per role** (reviewer-App, builder-App) scales cleaner than N machine-user PATs — short-lived tokens, no per-account 2FA/PAT sprawl, and it sidesteps the personal-repo resource-owner limitation entirely.

---

## 11. Wave-based dev-team architecture (converged target model)

The §7 orchestration mechanics are proven, but two shared-state defects surfaced under load: agents co-located in **one on-disk working directory** share (a) one git working tree + HEAD (a worker checkout moves the orchestrator's HEAD mid-task — issue #184), and (b) chat-state keyed by `hashCwd(workingDirectory)` so two agents in the same cwd cross-render (issue #182). Both are symptoms of a **shared cwd**, and both dissolve when each agent gets its own container filesystem. This section is the converged design for migrating dev agents to that model. Status tags: **[LANDED]** in place today · **[TO-BUILD]** designed, not yet built · **[VERIFIED]** empirically confirmed.

### 11.1 Container layout — three paths, two profiles
Each agent container has **three** distinct paths (NOT homedir == workspace — that would drop the identity dotfiles into the code tree and re-pollute it):

| Path | Holds | Worker | Orchestrator |
|---|---|---|---|
| **`$HOME`** (`/home/claude`, the system home — do NOT repoint) | identity + behavior: `CLAUDE.md`, `~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`, `<Name>_INSTRUCTIONS.md`, AMP keypair, provider auth | per-agent, private | per-agent, private |
| **`/workspace`** | the code checkout (own branch) | **ephemeral** per-task checkout (branch off the wave tip, one task, push, hibernate) | **persistent** checkout holding the integration **wave branch** |
| **`/ai-team`** | shared orchestrator plan + per-agent `*_INSTRUCTIONS.md` + protocol docs | **READ-ONLY** | **READ-WRITE** (owns the plan) |

- **`$HOME` ≠ `/workspace`.** The Codex/Gemini global instruction files resolve off `$HOME` (`$CODEX_HOME/AGENTS.md` defaults to `~/.codex/AGENTS.md`; Gemini `~/.gemini/GEMINI.md` — **[VERIFIED]** from the installed binaries). Both providers **merge/stack** global + repo-tree instruction files (they do NOT override), so homedir instructions load alongside any repo-canonical `AGENTS.md`/`GEMINI.md` with **zero hijack** of the shared repo's files. Keeping `$HOME` distinct from `/workspace` is also the **zero-churn** path: it is already `/home/claude` where the per-agent AMP/auth mounts live (§1's hard rule), so nothing restructures.
- **Worker `/workspace` is ephemeral.** A fresh checkout every wake means a stale long-lived worker checkout can't happen — workers branch off the current wave tip, do one task, push, hibernate.
- **Placement is necessary but not sufficient for the wanderers.** Correct file location only gets the instructions *discovered*; Gemini (and likely Codex) still need the on-wake hook's explicit "re-read and follow exactly" reinforcement to *comply* (§3b). So instruction delivery is two parts: **homedir placement + on-wake injection**.

### 11.2 `/ai-team` as its own orchestrator-owned repo
`/ai-team` is the **one** deliberately-shared mount, so it needs guardrails or it re-introduces the collision the migration removes:
1. **Its own git repo**, separate from the coding repo — NOT a gitignored dir inside `/workspace`. Un-gitignoring it *inside* the coding repo would re-commit it into the repo non-maestro devs clone (the original clutter problem). A standalone repo is git-versioned + orchestrator-managed AND stays out of the coding repo.
2. **Single-writer.** The **orchestrator writes** `/ai-team`; workers mount it **read-only**. Otherwise two workers committing to the shared `ai-team` repo just move the #184 HEAD collision from the code repo to the `ai-team` repo. Read-only mount enforces it. (Chat-state keys on the per-agent `/workspace`, so a shared `/ai-team` does NOT bring #182 back.)

### 11.3 The wave = one PR model (human gate at wave granularity)
The per-task individual-PR flow does not fit long autonomous waves — the human can't gate 30–50 micro-PRs/day (and on shared repos, the no-self-approve rule forbids flooding co-devs). So:
- A **wave** = a coherent unit of 15–20 tasks (a bug class, a whole API, a feature) = **one branch** = **ONE human PR to main**, human-reviewed + e2e-tested + merged. One meaningful review satisfies both human-in-the-loop AND no-self-approve/no-flood.
- **Inside** the wave, the per-task quality gate is **cross-provider agent review** (author → a different-provider reviewer authors tests **from the spec, not the code** — §7.5), which replaces per-task human review.
- **Commit granularity** is set at **integration time**: the orchestrator squashes each task's noisy WIP commits into **one clean commit per task** as it merges into the wave branch, so the PR shows ~15–20 meaningful, bisectable commits — not 200 WIP commits, not one opaque giant commit. The **final main-merge method** is a separate per-repo policy toggle (squash-merge → one commit/wave on main; merge-commit → per-task history on main).

### 11.4 Bare-repo transport (credential-less workers)
Only the **orchestrator** holds a git token, so workers cannot (and must not) push to GitHub. Transport is a **per-wave bare git repo on a persistent host volume** that both worker and orchestrator containers mount:
- **Bare repo** (`git init --bare`) = the `.git` database only, **no working tree** — so the #184 working-tree/HEAD collision *cannot occur there* (that bug needs a working tree; a bare repo has none). It's a handoff hub, not a second codebase.
- **Persistent VOLUME, per-wave REPO:** the volume survives container recreation (it lives on the host, not inside any ephemeral container); the bare repo on it is created at wave start and discarded at close, so no stale wave state carries forward.
- **Flow:** orchestrator clones origin once, pushes the wave branch to the bare repo → workers fetch the wave tip + push their task branch to the bare repo over **local filesystem transport, zero GitHub creds** → orchestrator fetches task branches, merges into the wave branch, and is the **only** identity that pushes the wave branch to GitHub for the single PR.
- **Co-location assumption:** workers + orchestrator on one host (the norm). Cross-host waves swap the shared volume for a network git endpoint, same roles. **[TO-BUILD]** — host-side volume + bare repo + reachability, plus wiring the mount into the container profiles.

### 11.5 Drift management (event-driven, boundary-applied)
A long-lived wave branch drifts from `main` while other devs land commits — left unmanaged, the wave→main PR becomes an end-of-wave conflict pileup at review time. The orchestrator runs **two merge jobs**: (1) task-branch → wave on each reviewed task; (2) **`main` → wave periodically**. The trigger is **event-driven, not a timer:** a repo-watcher AMPs the orchestrator on PR-close for the repo → the orchestrator sets a **main-moved flag** and drains it at the **task-dispatch boundary** (right before waking the next worker), merges `main` → wave, **and re-runs the accumulated wave test suite** (a `main` change can silently break an already-completed task — the drift-merge needs its own regression check). In-flight workers are untouched; the next worker always branches off an up-to-date, still-green tip. Reuses the existing AMP wake/notification primitive — no new plumbing. **[TO-BUILD]**

### 11.6 Git identity & commit attribution (deploy-safe)
- **The rule:** `user.NAME` per-agent (carries the cross-provider attribution — which agent did task N, which provider wrote the spec-tests); `user.EMAIL` a **shared, deploy-sanctioned value**. Set **once at provision by the provisioner**, never by the agent at runtime, in the same `$HOME` the identity files live in.
- **Why email is shared:** some deploy platforms (e.g. Vercel) key deploy-auth on the **committer EMAIL**, not the name. **[VERIFIED]** on a throwaway Vercel project: a commit with author NAME = a non-owner per-agent value + author EMAIL = the deploy-sanctioned shared address deployed **clean**. So per-agent name is safe; a per-agent email would break the deploy (observed). **Caveat to write down:** the GitHub avatar follows the **email**, so it renders as the shared identity — the per-agent NAME is the attribution, the avatar is shared.
- Default cloud containers today commit as a **generic** shared identity (`AI Maestro Agent <agent@example.com>`, **[VERIFIED]**), so attribution is currently invisible — the per-agent `user.name` provisioning is what makes it real. If a repo's deploy tooling ever keys on name too, fall back to author = the shared identity + `Co-authored-by:` trailers (the safe superset). **[TO-BUILD]**

### 11.7 Port reservation — the allocator fix (gating prerequisite)
Migrating all dev agents to cloud multiplies containers, which makes the **port double-assignment** bug load-bearing. Root cause: the allocator builds its used-ports set from `docker ps` (**running** containers only) — a hibernated agent's container is `Exited` and **releases its host port**, so its port looks free and gets reissued (an active agent's port being handed to a newly-provisioned one). `docker ps -a` does NOT help — a stopped container shows empty `.Ports`. The registry (`deployment.cloud`) is the only reliable hibernated-port source; the agent-first doctrine already says the registry is the source of truth.

**The fix [TO-BUILD, GATING]:** per-host **flock** around the **existing registry** (NOT a new sqlite/reservations file — a second store re-creates the two-sources-disagree problem that *is* the status-lies defect). Critical section: take per-host lock → read registry → `reserved = {all agents' recorded ports} ∪ {bound host ports backstop}` → pick first free → **persist the reservation, THEN `docker run`** (a failed bind reuses the same reserved port on retry — idempotent, no leak) → release lock.
- **Decouple reservation from status:** a port is reserved by the agent **existing** in the registry (created, not hard-deleted), NOT by `status == active` — so the allocator is robust even while the status field lies, and the durable fix does NOT block on the (sibling) status-accuracy fix.
- **Scope per-host** (ports are host-local). **Fail loud** on both range exhaustion AND the error path (a `catch` block that silently defaults to a hardcoded port with no free-check is the exact silent-collision mode — the rewrite kills it). **Size the range configurable** for peak concurrent per-host agents with multi-team headroom. Subsumes the parallel-`/recreate` port race. **The fix prevents NEW reissues; it does NOT re-home a port already baked into an existing record** — pre-existing collisions need the manual sweep below.

### 11.8 `recreate` vs `update-runtime` — and the identity-preserving port move
**Doctrine (write it once so no agent churns an identity by reaching for the wrong verb):** **`update-runtime` is the identity-preserving default** for anything that should keep its identity (UUID + AMP keypair + state + history all survive, and it re-runs the update-runtime provisioning path — see §6); **`/recreate` rotates the UUID by design** (new keypair, fresh state dir, orphaned message history under the old per-UUID dir, broken kanban/dashboard/peer-cache refs) — use it **only** when you deliberately want a fresh identity.

**Identity-preserving port reassignment** (the right unblock for a colliding agent that has prior work — **[VERIFIED]** zero churn on a live agent with real history):
1. Patch `deployment.cloud.websocketUrl` + `healthCheckUrl` → a port verified-free in **both** `docker ps` AND the registry, **targeted by id** so co-assigned agents are untouched.
2. `update-runtime` rebuilds on the new port — it re-reads the patched port (`parsePortFromWebsocketUrl` → flows straight into `docker run -p`, not overridden), UUID + keypair + history intact; the stale `Created` container is replaced in the same step. Take a registry backup first.
3. Verify three ways: host-side `/health` 200 on the new port; **mesh-side** name-addressed AMP **delivers** (proves the directory resolved name→UUID and the keypair survived); user-side wake + task. AMP routes by **name**, never UUID, so senders are unaffected by the port move.
- **Watch-out:** the post-rebuild runtime auto-launch can RACE to a stale-crash screen — restart the runtime if it hangs.
- **Don't force-wake the hibernated.** `update-runtime` rebuilds **and starts** the container = it wakes the agent. For an **intentionally-hibernated** agent, prefer a **registry-only port patch (no forced wake)** if the natural wake path reads the patched port — it comes up clean on the owner's next wake, strictly better than waking it now. Heads-up its owner first (identity is preserved, but the port moves).

### 11.9 Workstreams & status
1. **Port-reservation** — flock + registry-as-reservation, fail-loud, configurable range, parallel-recreate race folded in. **GATING** (the migration multiplies cloud agents). **[TO-BUILD]**
2. **Cloud-migrate dev agents** — the §11.1 profiles + the §11.4 bare-repo transport + the §11.3 wave loop (host-side volume/transport + container-profile provisioning in `agents-docker-service`). **[TO-BUILD]**
3. **Instruction relocation + on-wake reinforcement** — `$HOME` global-path placement (`~/.codex/AGENTS.md`, `~/.gemini/GEMINI.md`) + per-agent `user.name` git identity + the reinforcement hook. **[TO-BUILD]**

**Operational (separate from the durable fixes):** existing fleet-wide port collisions are pre-existing baked dupes the allocator fix will NOT auto-fix — they need the §11.8 manual identity-preserving sweep (reassign each OFFLINE victim, never the live holder) before they wake-fail.

---

_§1–§10 reflect provisioning + orchestration mechanics verified during a multi-provider dev-team standup, a review-only-agent GitHub-App provisioning, and a worktree-collision incident + its fix. §11 is the converged wave-based architecture from a team design session; per-section status tags mark LANDED vs TO-BUILD vs VERIFIED._
