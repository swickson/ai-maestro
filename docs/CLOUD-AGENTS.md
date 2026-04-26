# Cloud (Sandboxed) Agents

**Status:** Design + operator guide
**Authors:** Watson (dev-aimaestro-holmes), CelestIA (dev-aimaestro-bananajr), KAI (dev-aimaestro-admin)
**Related:** [#6](https://github.com/swickson/ai-maestro/issues/6) (wakeAgent fallthrough bug, prerequisite), [#52](https://github.com/swickson/ai-maestro/issues/52) (mount spec + operator flow)

---

## Overview

Cloud agents (`deployment.type = 'cloud'`) run inside a docker container per-agent for blast-radius containment. The container starts on every wake, the agent's process runs inside it, and the agent sees only the host filesystem paths explicitly bind-mounted into the container.

Cloud agents are the right default for any agent running with `--yolo`, `--dangerously-skip-permissions`, or any other non-interactive flag that disables the per-action permission prompts. Host-level (`deployment.type = 'local'`) agents remain appropriate for trusted operator-controlled workflows — e.g., dev-aimaestro-holmes, the docker/ziggy build agent on Holmes, and the gateway agent on Holmes — but those should be a small, named set, not the default.

> **Prerequisite:** Issue [#6](https://github.com/swickson/ai-maestro/issues/6) must be fixed first. Until it is, cloud agents only spawn inside their container on the *first* wake; subsequent wakes silently fall through to a host-native code path. Until #6 is closed, the sandboxing intent of `deployment.type = 'cloud'` is not enforced after the first session.

---

## Two patterns, one schema

All cloud agents share the same registry shape under `deployment.sandbox.mounts[]`. Two operational patterns emerge from how much external surface an agent needs.

### Pattern A — Bare-container agents

For agents whose work lives entirely inside their working directory (or a parent directory if they reference siblings), one to three bind mounts is enough.

| Agent | Mounts |
| --- | --- |
| Distill, Hale | `/home/gosub/agents/<agent>` (rw) |
| Mason, Optic | `n4-armory` (rw) + `n4safety-app` (ro) + `n4safety-website` (ro) |

Read-only on sibling references prevents an agent scoped to one project from accidentally writing into a peer project.

### Pattern B — Specialized-tooling agents

For agents that depend on an actively-developed peer project (Rollie + future Vance need ziggy), bind-mount the live project read-write so edits cross the host↔container boundary immediately.

| Agent | Mounts |
| --- | --- |
| Rollie | home (rw) + `/home/gosub/code/ziggy` (rw) + ziggy-ingest binary (ro) + MCP server surface |
| Vance (planned) | same shape as Rollie |

Pattern B intentionally avoids `git clone + build` inside the container on first wake — for an actively-developed dep, the container should always see the working tree the operator is editing on the host. No "stale ziggy inside the container" failure mode.

### Common mounts (both patterns)

These four are auto-included by `POST /api/agents/docker/create` for every cloud agent — operators don't need to declare them. They are recomputed deterministically from the agent UUID at any future redeploy.

- `~/.agent-messaging/agents/<agent-id>/` (rw) — AMP identity: signing keys, registrations, inbox/sent. Without this, amp-helper's name-based fallback auto-creates a phantom empty identity inside the container.
- `~/.aimaestro/agents/<agent-id>/` (rw) — dashboard / runtime: `agent.db`, `brain/`, `status.json`, hook-debug log.
- `~/.local/bin/` (ro) → `/home/claude/.local/bin/` — `amp-*` CLI scripts on PATH inside the container. Read-only because the container shouldn't mutate operator tooling.
- `~/.claude/` (rw) — agent CLI config including `mcp-config.json`. (For non-claude programs, the analogous `~/.codex/` or `~/.gemini/` should be substituted via operator-supplied `mounts[]`.)

### Common envs (both patterns)

Auto-injected by `POST /api/agents/docker/create` so amp-helper resolves the agent identity at priority 1 (explicit `AMP_DIR`) and reaches the host AI Maestro server through the `host.docker.internal` gateway alias.

- `CLAUDE_AGENT_ID=<agent-uuid>`
- `AMP_DIR=/home/claude/.agent-messaging/agents/<agent-uuid>`
- `AMP_MAESTRO_URL=http://host.docker.internal:23000`

Operator-supplied `extraEnv` in the create request merges on top — same key wins for the operator, so any of these can be overridden when needed.

### Explicitly **not** mounted

- `/var/run/docker.sock` — would let the agent escape the sandbox by spawning peer containers
- `/tmp` — host-shared tmp would defeat process isolation
- The host root filesystem at large

---

## Adding an MCP server or tool: the 3-tier flow

The whole point of the bind-mount design is that **most operator changes never require an image rebuild**. Three tiers, in order of preference:

### Tier 1 — Edit `.claude/mcp-config.json` on the host

The agent's `.claude/` directory is bind-mounted, so the file is the same file in both worlds. Edit it on the host with whatever editor; agent picks it up on next session.

Use this for:

- **Remote MCP servers (HTTP/SSE).** Just add the URL to the config. The container needs network access to reach the host (default for docker bridge networking).
- **Stdio MCP servers via `npx`.** Add an entry like `"mcp-foo": { "command": "npx", "args": ["-y", "@vendor/mcp-foo"] }`. The base image ships Node and npx; npx pulls the package on demand into a per-user cache that lives under the bind-mounted home directory, so subsequent restarts are warm.

This covers the vast majority of MCP servers in active use.

### Tier 2 — Add a `sandbox.mounts[]` entry

For MCP servers or CLI tools that aren't on npm, or that you want to keep out of the npm cache for performance/auditability reasons:

```json
{
  "deployment": {
    "type": "cloud",
    "cloud": {
      "image": "ai-maestro-agent:latest",
      "mounts": [
        { "host": "/home/gosub/agents/rollie", "container": "/home/gosub/agents/rollie", "mode": "rw" },
        { "host": "/opt/mcp-foo", "container": "/opt/mcp-foo", "mode": "ro" }
      ]
    }
  }
}
```

Then point `mcp-config.json` at the mounted path: `"command": "/opt/mcp-foo/bin/mcp-foo"`.

For non-MCP tools that install to user space (`pip install --user`, `npm install -g` with prefix in `$HOME`, `cargo install --root=$HOME/.local`), no schema change is needed — the install lands inside the bind-mounted home directory and survives container restart.

### Tier 3 — Rebuild the image

Reserve for genuine OS-level dependencies: a new system package via `apt`, a new language runtime version, a new system library. Update the base image's `Dockerfile`, rebuild, push to the registry, and bump the agent's `deployment.cloud.image` reference.

This is the slow path. If a change can be made via tier 1 or 2 instead, prefer that.

---

## Where MCP servers run: in-container by default

Across all three tiers, MCP servers run **inside the agent's container** by default (per-container spawn). This keeps blast radius small, makes per-agent identity automatic, and matches how tier-1 `npx` stdio servers already behave.

Promote an MCP server to a host-side daemon (and bind-mount its unix socket via `sandbox.mounts[]`) only when one of these is true:

- It needs host-only resources (host hardware, a host-bound DB socket, a host-scoped credential store).
- It is the source of truth for state genuinely shared across agents — and that state lives in the MCP server itself, not in a backend the MCP just talks to.
- Its per-process footprint is heavy enough that one instance per agent doesn't scale.

When promoting, document the daemon's host-side lifecycle (systemd unit or equivalent, log path, restart policy) alongside the `sandbox.mounts[]` entry. See [CLOUD-AGENT-MCP-DECISION.md](CLOUD-AGENT-MCP-DECISION.md) for the rationale.

---

## Operator workflow examples

### "I want to try the Linear MCP server on Mason."

1. Edit `/home/gosub/agents/mason/.claude/mcp-config.json` on the host.
2. Add `"linear": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-linear"] }`.
3. Restart Mason. New session sees the new server.

(Tier 1 — no image rebuild, no schema change.)

### "Rollie needs `ziggy-cli` on his PATH inside the container."

1. Build `ziggy-cli` on the host into `/home/gosub/code/ziggy/target/release/`.
2. Already covered — `/home/gosub/code/ziggy` is in Rollie's mount list.
3. In Rollie's `.claude/settings.json`, add the mounted path to `PATH` via the launcher script, or invoke binaries by full path.

(Tier 2 by virtue of the existing mount. No schema change beyond what Pattern B already requires.)

### "I want to add a custom Python MCP server I'm hacking on."

1. Develop on the host at `/home/gosub/code/my-mcp/`.
2. Add `{ "host": "/home/gosub/code/my-mcp", "container": "/opt/my-mcp", "mode": "rw" }` to the agent's `deployment.cloud.mounts[]`.
3. Edit `mcp-config.json`: `"my-mcp": { "command": "python", "args": ["/opt/my-mcp/server.py"] }`.
4. Restart agent. Iterate freely on the host — every restart sees the latest code.

(Tier 2 — schema change once, then tier-1 iteration thereafter.)

### "I need PostgreSQL client tools (`psql`) inside the container."

1. Add `RUN apt-get install -y postgresql-client` to the base image's Dockerfile.
2. Rebuild and tag the image.
3. Bump every cloud agent's `deployment.cloud.image` to the new tag (or just update `:latest` and restart).

(Tier 3 — system package, image rebuild required.)

### "I need to migrate an existing agent to Pattern A (local → cloud, or pre-schema cloud → cloud)."

`createDockerAgent` only creates new records — it throws on duplicate names by design. There is no in-place "redeploy this agent's container" flow yet (tracked as `2db1aa3b`). Until that lands, the migration path is **snapshot → clobber → recreate → restore**, with deliberate UUID churn:

1. **Snapshot the existing record.** Read `GET /api/agents/<oldId>` (or the registry directly) and save the JSON. The load-bearing field is `hooks["on-wake"]`. Anything stored under `~/.aimaestro/agents/<oldId>/` (`agent.db`, `brain/`, `keys/`, `registrations/`) needs separate snapshotting if the agent has accumulated state — see the brain-restore note below.
2. **Hard-delete the old record.** `DELETE /api/agents/<oldId>?hard=true` automatically backs everything up under `~/.aimaestro/backups/agents/<oldId>-<timestamp>/` (registry entry, agent data dir, message dirs, AMP dir). Soft-delete is not enough — the name uniqueness check in `createAgent` would still trip.
3. **Free the container name** (only needed if migrating an existing cloud agent whose container name will collide): `docker stop <containerName> && docker rm <containerName>`.
4. **Create fresh via the canonical flow.** `POST /api/agents/docker/create` with `{name, label, avatar, program, [model], [yolo], workingDirectory, [mounts]}`. This both starts a new container with the right `deployment.sandbox.mounts[]` and registers a fresh agent record. Returns a **new UUID**.
5. **Restore the on-wake hook.** `PATCH /api/agents/<newId>` with `{hooks: {"on-wake": "<captured prompt verbatim>"}}`. Without this the agent has no on-wake behavior and waking is a no-op.
6. **(Optional) Restore agent.db and brain.** If the agent had non-trivial accumulated state — conversations, consolidations, `doc_chunks` with vector embeddings, code graph — the snapshot under `~/.aimaestro/backups/agents/<oldId>-<timestamp>/agent-data/` contains the original `agent.db` and `brain/`. To restore: `pm2 stop ai-maestro` (the server holds an open SQLite handle on the new dir's `agent.db`), copy the backup files over `~/.aimaestro/agents/<newId>/agent.db` and `~/.aimaestro/agents/<newId>/brain/cortex-inbox.jsonl`, remove any stale `agent.db-journal` / `agent.db-wal` / `agent.db-shm` siblings, `pm2 start ai-maestro`. Save the freshly-bootstrapped agent.db as a `.pre-restore-<epoch>` first if you want a rollback.
7. **Wake to verify.** `POST /api/agents/<newId>/wake` with body `{}` should return `success: true` and emit `[Wake] Agent <name> (<newId>) — running in CONTAINER aim-<name> (already running)` in `pm2 logs ai-maestro`. No new host tmux session should be created (`tmux ls | grep <name>` returns nothing).

(Two non-tier observations from the first batch of migrations on 2026-04-25 — Hale, Mason, Optic on Holmes:)

- **The UUID changes.** Every reference that pinned the old UUID — cross-host directory caches, scripts, kanban tasks — needs refresh. AMP routing survives because addresses are email-style (`<name>@<tenant>.aimaestro.local`), not UUID-based.
- **Agents with empty databases (40 KB / 56 rows of pure schema scaffolding) lose nothing in step 6.** Agents with real accumulated state (Hale's was 3 MB / 14,225 rows: conversations, consolidations, vector embeddings, code graph) need step 6 explicitly or the historical brain is orphaned in the backup tree. When `2db1aa3b` lands, in-place redeploy will obviate steps 1, 2, 5, and 6 — the recipe collapses to "update mounts + recreate container."

---

## Identity and persistence

The agent's identity files (`~/.aimaestro/agents/<id>`, `~/.agent-messaging/agents/<id>`) are bind-mounted from the host, so:

- The agent's UUID and AMP keypair persist across container restart.
- Mesh address (`<name>@<tenant>.aimaestro.local`) is stable.
- Hook debug logs accumulate in the host-visible location for forensic inspection.

The agent's working directory (`/home/gosub/agents/<name>` by convention) is also bind-mounted, so any state the agent writes there — checkpoint files, scratch notes, project work — survives container recycling.

---

## Host-level agents

A small set of agents intentionally stays at `deployment.type = 'local'` (host-level, no container):

- **dev-aimaestro-holmes (Watson)** — production server agent on Holmes, runs the dashboard process and meeting routing.
- **dev-aimaestro-hutch** — handles docker and ziggy build orchestration on Holmes; needs host-level docker access to manage other agents' containers.
- Possibly **dev-aimaestro-dataia** — gateway agent on Holmes; pending Shane's call.

These agents have full host filesystem access by design. They are operationally trusted and run interactive, prompt-confirmed flows. Any new host-level agent should be a deliberate, named exception — not a default for "this is too hard to containerize right now."

---

## Implementation status

| Piece | Status |
| --- | --- |
| `services/agents-docker-service.ts` scaffolding | Done |
| `app/api/agents/docker/create/route.ts` | Done |
| AgentCreationWizard docker tab | Done |
| `wakeAgent()` honors `deployment.type=cloud` on every wake | Done — PR [#56](https://github.com/swickson/ai-maestro/pull/56) (closes [#6](https://github.com/swickson/ai-maestro/issues/6)) |
| `deployment.sandbox.mounts[]` schema + docker-create plumbing | Done — PR [#58](https://github.com/swickson/ai-maestro/pull/58) |
| Cloud-agent MCP-server policy (Option C hybrid; Rollie is B) | Decided — PR [#59](https://github.com/swickson/ai-maestro/pull/59) / `docs/CLOUD-AGENT-MCP-DECISION.md` |
| Pattern A migrations: Hale, Mason, Optic on Holmes | Done (2026-04-25) |
| Pattern B migration (Rollie) | Pending Hutch's pickup; MCP-strategy resolved |
| Cloud agents visible in dashboard list (#60 Half A) | Server-side merged in PR [#62](https://github.com/swickson/ai-maestro/pull/62) (v0.30.12); Holmes container rebuild pending |
| Cloud-agent terminal pipe (#60 Half B) | Pending — kanban `0c3b6339` (server.mjs:925 cloud branch + handleRemoteWorker reuse) |
| In-place container redeploy for an existing agent record | Pending — kanban `2db1aa3b` (sibling: `43753261` `agent.update()` mutation guard) |
