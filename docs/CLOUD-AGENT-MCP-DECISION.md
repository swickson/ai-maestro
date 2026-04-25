# Cloud Agent MCP Server Mount Strategy

**Author:** KAI (dev-aimaestro-admin)
**Date:** 2026-04-25
**Status:** Approved
**Decision:** Option C — hybrid policy. Per-container spawn (Option B) is the default; promotion to a host daemon (Option A) is a deliberate, named exception requiring host-only resources, genuinely shared state across agents, or a per-process footprint that doesn't scale.
**Related:** [CLOUD-AGENTS.md](CLOUD-AGENTS.md), Iron Syndicate kanban `d087f610` (Rollie Pattern B), `4df7da98` (Mason + Optic)

---

## The question

When a sandboxed (`deployment.type = 'cloud'`) agent needs an MCP server that isn't satisfiable via tier 1 (`npx` stdio or remote HTTP/SSE), how should that server be made available inside the container?

Two clean shapes were on the table when `d087f610` was filed:

- **A — Host daemon + shared unix socket.** One MCP server process per type runs on the host; each agent container mounts the socket as a volume.
- **B — Per-container spawn.** Each agent container runs its own MCP server processes inside.

This document also names a third — **C — hybrid, per-server-type** — and recommends that as the default policy.

---

## Context

`CLOUD-AGENTS.md` defines a 3-tier flow for adding MCP servers:

1. **Tier 1** — host edits to `.claude/mcp-config.json`. Covers most MCPs (remote HTTP/SSE, stdio via `npx`).
2. **Tier 2** — add a `sandbox.mounts[]` entry pointing the config at a host path.
3. **Tier 3** — image rebuild.

Tier 1 already implies **Option B** for npx-style stdio servers — the `npx` process spawns inside the container, the package cache lives in the bind-mounted home dir, and there's no host-side daemon involved. So B is the de facto default for most MCPs today.

The question only becomes load-bearing for a narrower set:

- MCPs that talk to host-only resources (a DB socket on the host, host hardware, a host-scoped credential store).
- MCPs that are heavy enough that one process per agent is wasteful (uncommon today; possible later for vector-DB-backed MCPs or large-context retrieval servers).
- MCPs whose state is *intended* to be shared across agents (a shared knowledge graph that multiple agents read/write).

Rollie (`d087f610`) is the first concrete case where this comes up, because Pattern B already couples its container to host process state via the live `ziggy` bind. The decision shape is general; Rollie just brings it to a head.

---

## Decision drivers

| Driver | Weight | Notes |
|---|---|---|
| Per-agent isolation | High | A sandbox that shares state across agents weakens the blast-radius story that motivated cloud agents in the first place. |
| Resource overhead | Medium | One process per agent × N agents is fine until N is large. Today N is small. |
| Lifecycle simplicity | Medium | Per-container spawn = container lifecycle. Daemon = host lifecycle (systemd unit, restart policy, log rotation). |
| Per-agent identity / auth | High when relevant | If an MCP server tracks *who* called it (e.g., a Linear MCP scoped to a user account), a daemon needs caller-identity plumbing the per-container shape gets for free. |
| Host coupling | Mixed | Some MCPs *want* host coupling (hardware, shared DB). Others want isolation. |
| Update flow | Low | Daemon = single update on the host. Per-container = update via image or via npx cache. Both are fine. |
| Operator cognitive load | Medium | A consistent global rule is easier to teach than a per-server-type policy. |

---

## Options

### Option A — Host daemon + shared unix socket

**Shape:** A long-running MCP server process on the host (`/var/run/mcp-foo.sock`), exposed to each container via a `sandbox.mounts[]` entry that bind-mounts the socket inode.

**Pros:**
- Single process per server type, regardless of agent count.
- Single update path (replace daemon, restart, all consumers see the new version on next call).
- Natural fit for MCPs that need genuinely shared state.

**Cons:**
- Shared blast radius: a bug in the daemon hits every agent at once.
- Per-agent identity has to be passed in-band (the socket doesn't tell the daemon who's calling). Either the MCP protocol carries it, or the daemon can't distinguish callers — which weakens isolation in subtle ways (cross-agent state leakage, audit-log conflation).
- Adds a host-level lifecycle surface to manage: systemd unit (or equivalent), log path, restart policy, version pinning.
- Doesn't follow the agent: if you move an agent to a different host, you have to stand up the daemon there too, or the agent loses its MCP.

### Option B — Per-container spawn

**Shape:** Each container has its own copy of the MCP server, started either by the agent's launcher (stdio) or as a sidecar process inside the container.

**Pros:**
- Isolation is the default. One agent's MCP crash doesn't affect peers.
- Lifecycle matches container lifecycle — no separate host surface.
- Per-agent identity is automatic (each MCP instance only ever serves one caller).
- Already the model that tier-1 (`npx` stdio) MCPs assume — choosing B globally means tier 1 and tier 2 stay symmetrical.

**Cons:**
- Resource duplication scales linearly with agent count. For lightweight MCPs (most today), trivial. For heavyweight MCPs, real.
- "Genuinely shared state" MCPs (a single knowledge graph multiple agents read/write) don't fit cleanly — you'd have to sidecar a service that itself proxies to a host-side store, which is just A by another name.

### Option C — Hybrid, per-server-type

**Shape:** No global rule. Each MCP server type picks A or B at the point it's added, based on whether it needs host coupling or shared state. The decision is captured next to the `mcp-config.json` entry or the `sandbox.mounts[]` entry, with a short rationale.

**Pros:**
- Right tool per job. Heavy / shared / host-coupled MCPs go A. Everything else stays B.
- Doesn't require committing to a daemon infrastructure until something genuinely needs it.
- Symmetric with how `CLOUD-AGENTS.md` already treats per-tier decisions (most MCPs are tier 1; tier 2 is the carve-out for the unusual).

**Cons:**
- Two patterns instead of one. Requires governance — a checklist or a paragraph in `CLOUD-AGENTS.md` so operators know when to pick which.
- Per-server-type calls can drift over time if no one owns the policy.

---

## Recommendation

**Option C — hybrid, with B as the strong default and A as a deliberate, named exception.**

Rationale:

1. The current MCP catalog is tier 1 dominated. Tier 1 is already B-shaped via `npx`. Choosing C-with-B-default keeps the default path consistent with what already works.
2. There is no MCP today that *requires* A. Adding A as a global mandate now would be infrastructure for a need we haven't hit. CLAUDE.md guidance: don't design for hypothetical future requirements.
3. The cases where A wins (host-only resource, genuinely shared state, true heavyweight) are visible at the point of adding the MCP. Naming A as a deliberate exception puts the decision at the right moment — when the operator knows the server's coupling profile.
4. For Rollie specifically, the live ziggy bind already makes some host coupling unavoidable, but that's bind-mount coupling, not MCP-daemon coupling. Rollie's MCP needs (whatever they end up being) can start as B and get promoted to A only if a concrete trigger appears.

**Concrete proposal for `CLOUD-AGENTS.md`:** add a short subsection under "Adding an MCP server or tool" that says: *"By default, MCP servers run inside the agent's container (per-container spawn). Promote to a host daemon only when the MCP needs host-only resources, genuinely shared state across agents, or has a per-process footprint that doesn't scale. Document the daemon's host-side lifecycle (systemd unit, log path, restart policy) when you do."*

---

## Consequences

If C is adopted:

- **Rollie's `d087f610` becomes unblocked** with no MCP-side commitments — Rollie ships with Pattern B mounts (live ziggy + ziggy-ingest binaries + home), and any MCP servers it ends up using start in-container. If a specific MCP later needs A, that's a separate small ticket, not a blocker.
- **`CLOUD-AGENTS.md` gets a small follow-up edit** to capture the default + exception rule. One paragraph.
- **No new infrastructure work today.** No systemd units, no daemon supervisors, no socket-bind plumbing in `agents-docker-service.ts`. (Tier-2 `sandbox.mounts[]` already supports binding an arbitrary socket if/when an A-shaped MCP shows up.)

If A is adopted as the global default instead:

- A daemon supervisor decision (systemd vs. pm2 vs. ai-maestro-managed) needs to be made up front.
- Per-agent identity has to be designed into the MCP protocol shim or accepted as a known weakness.
- Tier 1 (`npx`) stays B-shaped, creating an awkward split between "MCPs you author/deploy" (A) and "MCPs you `npx`" (B).

If B is adopted as the global default instead:

- Same as C in steady state, but without explicit guidance for the eventual A-shaped MCP. When one appears, the operator either ships A as a one-off without precedent, or opens a doc PR to amend.
- C is strictly better than B here because C costs one paragraph today and saves a doc PR later.

---

## Resolution notes

- **Rollie is Option B.** Confirmed by Shane: ziggy's MCP server is small, and the only shared-state surface (the backend database) lives outside the MCP server itself — so per-container spawn introduces no real duplication cost and no shared-state penalty.
- **No MCP on the current roadmap requires A.** The hybrid policy starts with no named exceptions. The first server that needs A will be the one that names itself.
- **Hutch's on-wake instructions:** Watson's call. Watson owns the Rollie/Holmes Pattern B work and is the natural decider on whether Hutch needs a heads-up about the future A-promotion path.

---

## References

- [CLOUD-AGENTS.md](CLOUD-AGENTS.md) — operator guide, 3-tier flow, Pattern A/B definitions
- Iron Syndicate kanban `d087f610` (Rollie Pattern B)
- Iron Syndicate kanban `4df7da98` (Mason + Optic, Pattern A — for context on the no-MCP-daemon-question case)
- [GRAPH-DATABASE-DECISION.md](GRAPH-DATABASE-DECISION.md) — format precedent
