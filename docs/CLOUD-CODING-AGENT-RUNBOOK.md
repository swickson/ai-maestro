# Runbook: Standing Up a Cloud Coding Agent (Separate Homedir + Coding Repo)

> **Status:** Co-authored by Watson (Maestro-side provisioning: §1 pattern, §2–6, §8–9) + Bishop (§1 rationale, §7 orchestration). Reviewed end-to-end; all mechanics verified against the 2026-06-08/09 gateways dev-team standup (Crease/Whistler/Mother) + the worktree-collision incident.
>
> **Pattern scope:** how to stand up a sandboxed cloud (local-container) coding agent whose **home directory and the code repo it works on are separate mounts** — the agent has a stable scratch/identity home, and edits code in a distinct repo mount. This generalizes the gateways dev-team standup; it intentionally does NOT prescribe a specific bind-mount topology (e.g. worktree-over-shared-.git) — that's a project choice layered on top.

---

## 1. The "separate homedir + coding repo" pattern

A cloud coding agent gets **two distinct rw mounts** (plus whatever the project adds):

1. **Home dir** — a small per-agent dir for the agent's own scratch/context (e.g. a provider context file). Mounted at an **identical host=container path**, NOT over the container's system home.
2. **Coding repo** — the code the agent edits, a separate mount at an **identical host=container path** so absolute paths and git resolve in-container.

Why separate (vs. agent-home == workspace):
- **Scratch/identity isolation.** The home holds the agent's provider creds, context file, and working scratch (review clones, `/tmp` artifacts, build logs). Keeping that out of the code repo means agent churn never pollutes the working tree or `git status` — the repo stays a clean, reviewable surface, and the home stays disposable/rebuildable.
- **Multi-agent collision avoidance.** N agents can share **one** code-repo mount (or per-agent worktrees of it) while each keeps a **private** home, so their scratch and identity never collide even when they edit the same codebase. Agent-home == workspace makes every agent's scratch a change in everyone's tree.
- **Fresh-reviewer story.** Review runs out of the reviewer's **own** home (an isolated clone or read-only inspection), so a reviewer can hibernate→wake with flushed context and judge the builder's work without their own working state bleeding in (see §7's no-self-verification rule).
- **Identity survives image/toolchain swaps.** The home (and the per-agent AMP/cred mounts under it) persists across `update-runtime` recreate, so the agent's mesh identity + auth survive a node/image migration while the code repo is independently swappable.

**Hard rule — never mount over `/home/claude`.** The container's home (`CONTAINER_HOME=/home/claude`) is system-owned: Maestro bind-mounts 8 reserved subpaths there for AMP identity + provider credentials (`.agent-messaging`, `.aimaestro`, `.local`, `.claude`, `.claude.json`, `.gemini`, `.codex`, `.config/gh`). Operator mounts that collide are rejected by `validateMounts`; mounting over the whole home shadows baked state. Use an **identical-path dir of your own** (e.g. `/home/gosub/agents/<name>`), matching the proven baseline (Hale: `/mnt/agents/hale -> /mnt/agents/hale`).

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
  "hostId": "holmes",                     // MUST be the canonical self host id (lowercase)
  "programArgs": "--dangerously-skip-permissions",  // PER-PROVIDER autonomy flag — see §4
  "workingDirectory": "/home/gosub/projects/myrepo",  // bound to /workspace; agent's cwd
  "mounts": [                             // operator SandboxMount[] — identical paths
    { "hostPath": "/home/gosub/agents/myagent", "containerPath": "/home/gosub/agents/myagent", "readOnly": false },
    { "hostPath": "/home/gosub/projects/myrepo", "containerPath": "/home/gosub/projects/myrepo", "readOnly": false }
  ]
}
```

Returns `{ agentId, containerId, port, containerName }`. AMP identity is **auto-bootstrapped** at create (`ampRegistered=true`, per-agent Ed25519 keypair + `.agent-messaging` mount); `hostId` makes it cross-mesh resolvable. No manual AMP wiring.

### 3b. Set the on-wake hook (post-create PATCH)
`hooks` is NOT a create field — set it after:

```bash
curl -X PATCH http://localhost:23000/api/agents/<agentId> -H 'Content-Type: application/json' \
  --data '{"hooks":{"on-wake":"You are dev-team-myagent, display name MyAgent. cd /home/gosub/projects/myrepo and read ai-team/MyAgent_INSTRUCTIONS.md, then follow it."}}'
```
For **Gemini/antigravity** agents, add reinforcement ("…then re-read and follow it exactly") — Gemini reads loosely without it.

### 3c. Tags (optional)
`PATCH … {"tags":["dev","myteam"]}` for grouping.

### 3d. Verify (see §8 checklist).

---

## 4. Per-provider reference (VERIFIED 2026-06-08)

| Provider | `program` | In-container binary | Autonomy flag (put in `programArgs`) | Auth |
|----------|-----------|--------------------|--------------------------------------|------|
| Claude   | `claude`  | `claude`           | `--dangerously-skip-permissions`     | interactive `claude` OAuth in-container |
| Codex    | `codex`   | `codex`            | `--dangerously-bypass-approvals-and-sandbox` | interactive `codex login` in-container |
| Gemini (legacy) | `gemini` | `gemini`     | `--yolo`                             | Google OAuth |
| **Antigravity** (current Gemini standard) | `antigravity` | `agy` | `--dangerously-skip-permissions` | Google OAuth (`~/.gemini/oauth_creds.json`, auto-seeded from host at create) |

**Platform standard:** "a Gemini agent" now means **antigravity** (program=`antigravity`, binary `agy`), not the legacy `gemini-cli`. Use antigravity unless you specifically need legacy gemini-cli.

**Autonomy is per-provider** — `--dangerously-skip-permissions` is CLAUDE-ONLY; baking it into codex/gemini breaks launch (unrecognized flag). Use the table.

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
- **recreate to change image or programArgs** — a wake won't do it. Use `POST …/update-runtime` with `{}` (rebuilds the container on `ai-maestro-agent:latest`, **preserves** UUID + AMP keypair + mounts + on-wake hook + programArgs). `/recreate` ROTATES the UUID (breaks AMP/mesh refs) — avoid unless you intend identity churn.
- **`AI_TOOL` composition** honors `body.yolo` and `body.programArgs`, **NOT** `body.permissionMode` (permissionMode is the host-tmux wake path only). So put autonomy in `programArgs` (it survives recreate; `yolo` does not).
- **on-wake hook fires on wake**, NOT on `update-runtime`. So after a recreate the session is fresh + unprimed → **hibernate then wake** to fire the hook and prime it. Migration pattern: **recreate → hibernate → dispatch-then-wake**.

---

## 7. Orchestration & multi-agent coordination

The §1–§6 mechanics stand up **one** agent. This section is the layer on top: running a **team** of them to build + review software. Pattern proven on the 2026-06-08/09 gateways dev-team standup (one orchestrator + Crease/Whistler/Mother).

### 7.1 Team shape
- **One orchestrator** (typically a host agent with full repo access + the only push/PR credentials) + **N workers** (containerized, one `program` each). Picking workers across providers (e.g. Claude / Codex / Antigravity) makes cross-provider review **automatic** — see 7.5. Roles (e.g. "security", "architecture") are lenses, not walls.
- Each worker = own **home** (free identical path) + the **code-repo** mount (identical path). Stand up **one worker as a canary first** — smoke-test hibernate→wake, the AMP round-trip, and that the on-wake hook actually reads its instructions file — before creating the rest.

### 7.2 Coordination-dir pattern
- A shared **coordination dir** (e.g. `ai-team/`) is mounted into — or nested inside — **every** agent's repo path, so the orchestrator's living plan, per-agent `*_INSTRUCTIONS.md`, and protocol docs are visible to all agents on the **same path, instantly**.
- It is **gitignored** (keeps team operational state out of the shipped branch) **but shared** (same physical mount). Gitignored ≠ private within the team.
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

_Watson sections (§1 pattern, §2–6, §8–9) reflect mechanics verified during the 2026-06-08 gateways dev-team standup (Crease/Whistler/Mother). Bishop's §1 rationale + §7 orchestration reflect the same standup's orchestration + the worktree-collision incident and its fix (2026-06-08/09)._
