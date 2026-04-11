# Strategic-Tier Agent Pattern with Mesh-Aware Wake Injection

**Status:** Shipped in v0.27.9 (2026-04-10), validated in production on 2026-04-11 with live agents Optic, Mason, and Rollie on Holmes and the Ziggy dev team (orchestrator, se, codex, fullstack) on milo.

**Audience:** Future agents or human operators who need to understand how multiple heterogeneous agents (Claude, Gemini, Codex) can cohabit a single working directory for strategic or executive work, how the mesh-awareness wake injection enables that without bloating per-agent config files, and how to add a new agent to an existing strategic tier.

**Why this doc exists:** the mesh-primer work and the strategic-tier pattern were developed and deployed end-to-end during a single long session that also spun up Optic and Mason as the first real-world proof. CelestIA and dev-aimaestro-holmes (Watson) were the two reviewer agents in that session. Both have since been hibernated and their session context is gone. This doc is the authoritative record of what was shipped and why, independent of any agent's memory.

---

## 1. The problem

Three related problems that this work solves together:

### 1a. Multiple agents in the same working directory

Some projects need more than one AI agent working against the same repo. Two examples we run in production:

- **Ziggy dev team** (`~/Antigravity/ziggy` on milo): four agents share the same working directory — `dev-ziggy-orchestrator` (Claude), `dev-ziggy-se` (Claude), `dev-ziggy-codex` (Codex), and `dev-ziggy-fullstack` (Gemini). The orchestrator runs a plan, the three workers execute and cross-review each other's code.
- **N4 Safety strategic tier** (`~/code/n4safety/n4-armory` on Holmes): two executive agents share the n4-armory repo — `ops-exec-optic` (Gemini, Creative Director / Head of UI-UX) and `ops-exec-mason` (Gemini, CTO / Lead Architect). They don't write implementation code; they write strategic briefs that engineering agents execute against.

Without a convention, the natural thing is to duplicate every agent's instructions into its provider-specific walk-up file (`CLAUDE.md`, `AGENTS.md`, `GEMINI.md`) and accept the drift. That scales badly.

### 1b. Every provider wants a different walk-up file

Claude Code reads `CLAUDE.md` from the current working directory walking up to root. Gemini CLI reads `GEMINI.md` the same way. Codex reads `AGENTS.md`. When multiple agents of different providers share one working directory, each provider ends up with its own walk-up file. If each file re-documents AMP messaging basics (`amp-send` syntax, `amp-inbox` flow, the full command surface), you pay those tokens once per provider file AND once per agent wake.

Worse: the files drift. The `amp-send` example in `CLAUDE.md` slowly falls out of sync with the one in `AGENTS.md` and `GEMINI.md`, and a reader can't tell which one is authoritative.

### 1c. Multi-provider mesh awareness is a real architectural problem, not just cost

Claude Code supports a first-class skill system. A Claude agent with the `agent-messaging` skill installed gets AMP command knowledge on demand (the skill's description matches the user's intent, Claude loads it lazily, it costs nothing until actually used). Gemini CLI and Codex do not have an equivalent skill system that works the same way. They read markdown files on wake and follow instructions, but they don't lazily load capabilities based on intent.

Which means: Claude agents can solve "how do I send a message" by invoking a skill; Gemini and Codex agents need the instructions pre-loaded into their wake context or they'll waste time researching it from scratch.

Just telling Gemini "there's an `amp-send` command somewhere" is not enough — the first time an operator tells Mason "send Optic an AMP message asking about the wireframe," a Gemini agent without pre-loaded AMP knowledge will spend 5 minutes trying to figure out what AMP is, where the docs live, and how to invoke the CLI. That's the observable pain point Shane flagged that kicked off this work.

---

## 2. The mesh-awareness wake injection

The central mechanism that makes everything else possible.

### 2a. What it does

At wake time, ai-maestro injects a short (~5 line) **mesh primer** into the agent's on-wake prompt hook. The primer tells the agent:

- It is running inside an AI Maestro agent mesh
- Other agents can send it messages and it can send messages to them
- The command to send is `amp-send <recipient> "<subject>" "<body>" [--priority ...] [--type ...]`
- Valid priorities and types are enumerated inline
- If more detail is needed, the agent can run `amp-primer` from its shell for the full protocol reference, or `amp-primer --commands` for just the cheatsheet, or `amp-primer --peers` to list reachable agents
- For meeting replies, `meeting-send.sh` is the tool

That's it. Roughly 600-700 characters, shell-safe (quotes around placeholders so shell word-splitting doesn't corrupt multi-word subjects/bodies), provider-agnostic (the phrasing "use your agent-messaging skill if available, otherwise invoke amp-send from shell" handles Claude-with-skill, Claude-without-skill, Gemini, and Codex uniformly).

### 2b. Where the code lives

**`services/agents-core-service.ts`:**

- `MESH_PRIMER` constant (the text, exported for testing)
- `loadMeshPrimer(agent: Agent): string` (returns `MESH_PRIMER` unless `agent.meshAware === false`)
- `executeHook()` (accepts an optional `meshPrimer` parameter, prepends it to prompt-type hooks)
- Wake handler around line 1454 calls `loadMeshPrimer(agent)` and passes the result to `executeHook()`

**`types/agent.ts`:**

- `Agent.meshAware?: boolean` — optional field, default true, opt-out only (set to `false` to skip primer injection for a specific agent)

### 2c. The opt-out path

Some agents should not have mesh awareness — sandboxed test agents, agents running disconnected experiments, or agents whose workflow would be confused by the AMP context. Setting `meshAware: false` on their Agent registry entry bypasses the primer entirely. The default (field unset or set to `true`) is to inject.

### 2d. The "escape hatch" design: amp-primer CLI

The primer is deliberately short. It doesn't enumerate every amp-* command, every flag, every nuance. It points at `amp-primer` as the full-docs escape hatch.

`amp-primer` is a bash script that ships with the `ai-maestro-plugins` git submodule at `plugin/plugins/ai-maestro/scripts/amp-primer.sh` (mirrored to `src/scripts/amp-primer.sh` for the build). It is installed to `~/.local/bin/amp-primer.sh` and symlinked as `amp-primer` by `install-plugin.sh`'s existing `amp-*.sh` glob — no manifest changes needed to pick it up.

Modes:

- `amp-primer` — full mesh protocol reference (overview, addressing, commands, message flow, meetings, troubleshooting)
- `amp-primer --short` — the same one-paragraph primer that gets wake-injected, useful if an agent wants to re-read its wake context
- `amp-primer --commands` — command cheatsheet only (send, inbox, read, reply, delete, identity, status, meeting-send)
- `amp-primer --peers` — tab-separated list of peer agents from `~/.aimaestro/agent-directory.json` with NAME / LABEL / ADDRESS / HOST columns; unregistered peers show `(unregistered)` in the address column
- `amp-primer --help` — usage

The script has zero external dependencies beyond `jq` (used only in `--peers` mode). It does not source `amp-helper.sh`, doesn't need an initialized AMP config, and doesn't need an agent identity — it just outputs the static protocol reference.

### 2e. The important gap (tracked as swickson/ai-maestro#7)

The primer is only injected when the agent has a prompt-type on-wake hook. Specifically, `wakeAgent()` only calls `executeHook()` if `agent.hooks?.['on-wake']` is truthy, and `executeHook()` only prepends the primer to hook values that start with `prompt:`. Shell-command hooks (`agent.hooks['on-wake']` set to a bash command rather than a `prompt:...`) are correctly left alone since prepending markdown to a shell command would break it.

**Consequence:** agents with `meshAware: true` but no `on-wake` hook — or with a shell-command on-wake hook — silently get no primer. The Rollie case surfaced this: Rollie originally had `hooks: null`, woke up without mesh awareness, and the bug was only visible when Shane tried to test him alongside the newly mesh-aware Optic and Mason.

**Workaround:** give every meshAware agent a minimal prompt-type on-wake hook. Rollie's was updated to a short Dungeon Master ritual (`prompt:You are Rollie, Shane's assistant Dungeon Master. ...`) which is enough to trigger primer injection while preserving his voice.

**Proper fix:** issue #7 tracks extending the wake flow to send the primer as a standalone stdin write for meshAware agents without a prompt-type hook. Not blocking the current deployment.

---

## 3. The strategic-tier pattern

The other half of the story: a convention for how multiple agents share a single working directory, with per-agent identity files and a shared roster/policy file, all driven by explicit on-wake hooks for providers that don't honor walk-up files reliably.

### 3a. File layout

For a project where multiple strategic agents cohabit one working directory (e.g., `n4-armory` for N4 Safety or `ziggy` for the Ziggy dev team), the convention is:

```
<project-root>/
├── GEMINI.md                    # generic team context, loaded by walk-up for Gemini agents
├── CLAUDE.md                    # generic team context, loaded by walk-up for Claude agents
├── AGENTS.md                    # generic team context, loaded by walk-up for Codex agents
├── OPTIC_INSTRUCTIONS.md        # per-agent, committed, read via onWake hook
├── MASON_INSTRUCTIONS.md        # per-agent, committed, read via onWake hook
└── <other project files>
```

Not every agent needs every file. The rules:

- **Walk-up files** (`CLAUDE.md` / `AGENTS.md` / `GEMINI.md`) contain project-wide context shared across all agents using that provider: project overview, architecture, commands, team roster, workflow rules, cross-review protocol. They are auto-loaded by the provider CLI when the agent starts in this working directory.
- **`<AGENT>_INSTRUCTIONS.md` files** contain per-agent identity: voice, role, output format conventions, domain knowledge specific to that agent. They are NOT auto-loaded — the agent's on-wake hook explicitly tells it to read them.
- **The on-wake hook** is the compliance anchor for Gemini and Codex, which don't honor walk-up markdown as tightly as Claude does. The hook explicitly names the agent's identity, names the specific file(s) to read, and uses the phrase "explicitly follow its instructions in full" to force compliance.

### 3b. Why GEMINI.md is shared and not per-agent

When Optic and Mason both live in `n4-armory` and both are Gemini agents, they share the same `GEMINI.md` via walk-up. That file contains the strategic tier's roster ("Optic = Creative Director, Mason = CTO, Rollie = ..."), their collaboration protocol (Optic produces design briefs → Mason translates to technical specs → engineering agents execute), the lane-separation rule (strategic agents write briefs, never implementation code), and other context that's common to all members of the tier.

Shared roster + shared protocol in one file. Single source of truth. Adding a new strategic agent means adding one row to `GEMINI.md`, not editing N per-agent files.

Per-agent voice and domain knowledge goes in `<AGENT>_INSTRUCTIONS.md`. Those files are independent of each other — editing `OPTIC_INSTRUCTIONS.md` doesn't affect Mason, and vice versa.

### 3c. Why on-wake hooks force the per-agent read

Claude Code honors walk-up `CLAUDE.md` reliably. If a Claude agent starts in a directory, it reads `CLAUDE.md`, and it pays attention to what's in it.

Gemini CLI and Codex do not. They will technically load `GEMINI.md` or `AGENTS.md` via their respective walk-up mechanisms, but they often don't internalize the instructions or act on them without explicit prompting. Empirically, the reliable pattern is:

1. The on-wake hook explicitly names the file(s) the agent should read
2. The hook uses the phrase "explicitly follow its instructions in full" as a compliance nudge
3. The hook tells the agent to acknowledge its identity before accepting any task

That's why the hooks look like this:

```
prompt:You are ops-exec-optic, Creative Director and Head of UI/UX
for N4 Safety. Read GEMINI.md (the strategic-tier roster and shared
policy) and OPTIC_INSTRUCTIONS.md (your specific role) in your
working directory and explicitly follow their directions in full.
After reading both, briefly acknowledge your identity and state
that you are ready for your first brief.
```

The hook fires once on wake, forces the read, forces the acknowledgment, and then the mesh primer (injected above the hook text by the wake flow) ensures the agent also has mesh awareness for the rest of the session. Every element is load-bearing:

- **Identity statement** — prevents cross-contamination when two agents of the same provider share a CLAUDE.md that has role-specific sections
- **Explicit file read** — forces Gemini/Codex compliance with walk-up content
- **"In full"** — prevents the agent from skim-reading
- **Acknowledgment** — gives Shane or the orchestrator a visible signal that the boot worked

### 3d. Strategic-tier vs worker-tier

The strategic tier (Optic, Mason, future CMO/CFO/etc.) is distinct from the worker tier (Ziggy dev agents, triage agents, implementation-focused work).

**Strategic-tier agents:**

- Write design briefs, strategic docs, Antigravity Prompts for engineering agents to execute
- Do NOT write implementation code
- Read the codebase to inform their briefs, but the "lane separation" rule says they hand off the actual coding decisions to implementing agents with deeper project context
- Typically run on an always-on host (Holmes) so they persist across operator sessions
- Share a working directory (e.g., `n4-armory`) that holds their committed outputs, reference documents, and team context

**Worker-tier agents (e.g., Ziggy team):**

- Write implementation code in response to orchestrator task assignments
- Use AMP messages for coordination, not prose handoff
- Run on a development host (milo, bananajr) and may be hibernated between tasks
- Share a project working directory (e.g., `~/Antigravity/ziggy`) that IS the code being worked on

Both tiers use the mesh primer and the provider-file-with-onWake-compliance-hook pattern. The difference is what the agents DO — strategic agents produce strategy artifacts, worker agents produce code.

---

## 4. How the two mechanisms combine — end-to-end wake flow

The wake sequence for a strategic-tier agent like Optic looks like this:

```
1. Operator (Shane or another agent via the ai-maestro-agents-management skill)
   runs: aimaestro-agent.sh wake ops-exec-optic

2. ai-maestro's wakeAgent() handler in services/agents-core-service.ts:
   - Loads the Agent record from the registry (reads meshAware, hooks, etc.)
   - Creates/attaches the tmux session
   - Spawns gemini-cli (or the configured program) in the session's
     working directory (n4-armory in Optic's case)
   - Waits for the CLI prompt to be ready (waitForPrompt)

3. Once the CLI is ready, loadMeshPrimer(agent) resolves:
   - agent.meshAware is undefined or true → returns MESH_PRIMER
   - agent.meshAware is false → returns "" (primer skipped)

4. executeHook() is called with:
   - The agent's on-wake hook value (e.g., "prompt:You are ops-exec-optic...")
   - The mesh primer string (or empty)
   - Runtime variables for interpolation (${projectDirectory}, ${agentName})

5. executeHook() interpolates the hook variables, then:
   - If hook starts with "prompt:" and meshPrimer is non-empty:
       finalPrompt = meshPrimer + "\n\n" + userPrompt
   - Types finalPrompt into the agent's stdin via runtime.sendKeys()

6. The agent (Optic, now running gemini-cli in the tmux session) receives
   its first-turn context, which is:
      [mesh primer, ~5 lines]
      [blank line]
      [user prompt from the on-wake hook, naming Optic's identity and
       telling her to read GEMINI.md and OPTIC_INSTRUCTIONS.md]

7. gemini-cli also loads GEMINI.md via walk-up from n4-armory. So Optic's
   FIRST TURN has, in order:
   - Mesh primer (injected by ai-maestro)
   - Team roster + lane rules (from GEMINI.md walk-up)
   - On-wake prompt asking her to read both files and OPTIC_INSTRUCTIONS.md

8. Optic reads OPTIC_INSTRUCTIONS.md (forced by the on-wake prompt),
   internalizes her voice/role, acknowledges her identity, and waits for
   the first real brief.
```

The mesh primer is a prefix, not a replacement for the hook. The hook is a prefix, not a replacement for the walk-up file. All three layers compose cleanly because they're doing different work:

- **Mesh primer** = "how to talk to other agents on this mesh" (provider-agnostic, short, self-dereferencing via amp-primer)
- **Walk-up file** (`GEMINI.md`) = "what team/project you are in and the shared rules"
- **On-wake hook** = "who you specifically are, and a compliance nudge to read your per-agent file"
- **Per-agent instructions** (`OPTIC_INSTRUCTIONS.md`) = "your voice, your role, your output format"

---

## 5. Recipe: adding a new strategic agent to an existing tier

Say you want to add a new Chief Financial Officer agent `ops-exec-cfo` to the N4 Safety strategic tier on Holmes.

1. **Write the per-agent instructions** at `n4-armory/CFO_INSTRUCTIONS.md`. Include role, voice, output format (e.g., what a CFO's brief looks like), domain knowledge (which strategic docs in n4-armory are load-bearing for this role), and any lane-separation caveats specific to finance work.

2. **Add a row to `n4-armory/GEMINI.md`** in the strategic-tier roster section. Short — name, role, one-line description. Commit to git so the other strategic agents see a new peer next time they wake.

3. **If the new agent needs to coordinate with existing tier members** (e.g., CFO produces financial reviews of Optic's campaign proposals), update `GEMINI.md`'s collaboration protocol section to describe the handoff. Keep it terse.

4. **Register the agent in ai-maestro** via the UI or directly in `~/.aimaestro/agents/registry.json`:

   ```json
   {
     "id": "<uuid>",
     "name": "ops-exec-cfo",
     "label": "CFO",
     "program": "gemini",
     "programArgs": "--yolo",
     "workingDirectory": "/home/gosub/code/n4safety/n4-armory",
     "hostId": "holmes",
     "hooks": {
       "on-wake": "prompt:You are ops-exec-cfo, Chief Financial Officer for N4 Safety. Read GEMINI.md (the strategic-tier roster and shared policy) and CFO_INSTRUCTIONS.md (your specific role) in your working directory and explicitly follow their directions in full. After reading both, briefly acknowledge your identity and state that you are ready for your first brief."
     }
   }
   ```

   (`meshAware` does not need to be set — it defaults to true.)

5. **Deploy any ai-maestro changes to Holmes** if this is the first time Holmes is picking up the strategic-tier pattern (should be a no-op at this point since v0.27.9 is already there):

   ```bash
   cd ~/projects/ai-maestro
   git pull origin main
   git submodule update --init
   NODE_ENV=development yarn install
   NODE_ENV=development yarn build
   pm2 restart ai-maestro
   ```

6. **Wake the agent** via `aimaestro-agent.sh wake ops-exec-cfo` or via the ai-maestro UI. Confirm the first-turn response includes:
   - The CFO identity acknowledgment
   - Evidence that both `GEMINI.md` and `CFO_INSTRUCTIONS.md` were read (Optic and Mason do this by quoting a phrase from their instructions — do the same validation here)
   - Readiness statement

7. **Test mesh-aware behavior** by asking the CFO to send an AMP test message to Optic or Mason. If the CFO constructs a valid `amp-send` invocation on first try (with correctly quoted multi-word subject and body, correct `--priority` and `--type` flags), the mesh primer is doing its job. If the CFO pauses to research AMP syntax, something is wrong with the primer injection — check that `agent.meshAware !== false` and that the on-wake hook is a prompt-type hook (not a shell-command hook).

---

## 6. Deployment reality worth remembering

### 6a. ai-maestro is per-host

Each host runs its own ai-maestro server for the agents that live on that host. Merging changes to `swickson/ai-maestro` `main` does not automatically deploy them anywhere. To activate a new version on a specific host, you have to pull and restart on that host.

Holmes runs ai-maestro for Optic, Mason, Rollie, and the other agents registered under `hostId: "holmes"`. Milo runs ai-maestro for the Ziggy team, KAI (`dev-aimaestro-admin`), and any other agents registered under milo's hostId. Dashboard UI on one host calls into the appropriate remote host via its API when waking agents there.

Which means: **when you deploy a new ai-maestro version (e.g., to activate a new wake-time injection or primer text), you must deploy it on every host where meshAware agents live**, not just the one running the dashboard. This is load-bearing because the wake flow runs on the agent's host, not the dashboard's host.

### 6b. NODE_ENV=production gotcha

On agent hosts, `NODE_ENV=production` is typically set globally so agent runtimes get production mode. That setting is poisonous for deploys: `yarn install` silently skips devDependencies (tailwindcss, typescript, next-build tooling) when NODE_ENV=production, and `yarn install --frozen-lockfile` reports "up-to-date" on partial installs because it only verifies lockfile integrity, not install completeness. The next `yarn build` then fails with `Cannot find module 'tailwindcss'` and a cascade of import errors.

**Always run install and build with NODE_ENV=development explicitly on agent hosts:**

```bash
NODE_ENV=development yarn install
NODE_ENV=development yarn build
```

This is captured in the Holmes deploy incident from the Iron Syndicate meeting on 2026-04-10. Worth adding to a dedicated deploy script when someone gets around to it (consider `scripts/deploy-to-host.sh`).

### 6c. The amp-primer install is automatic

`install-plugin.sh` at the ai-maestro repo root has an `amp-*.sh` glob that copies every script matching that pattern from `plugin/plugins/ai-maestro/scripts/` into `~/.local/bin/` and creates the extension-less symlinks. `amp-primer.sh` is picked up by this glob automatically — no install manifest changes, no separate scripts, no manual symlink work. Just run `install-plugin.sh` with option 1 (AMP scripts only) or option 3 (both scripts and skills) and the new `amp-primer` command lands on PATH.

Verification:

```bash
which amp-primer
amp-primer --short   # should output the ~5-line mesh primer
```

### 6d. The hosts-config-server.mjs latent bug

Fixed in `1b54f3c` on 2026-04-11 (PR #10, closes #9). The bug: `lib/hosts-config-server.mjs` called a function `saveHostsToFile()` that was never defined. The call path was dormant until a hostname change triggered the auto-migration branch, at which point builds would fail with `ReferenceError`. The fix ports the equivalent helper from `lib/hosts-config.ts`.

If you're deploying to a host whose hostname has changed (laptop rename, VM rebuild, docker image rebuild with different hostname), be aware of this and confirm you're on `1b54f3c` or later before running `yarn build`.

---

## 7. Known gaps

Tracked as issues on `swickson/ai-maestro`:

- **#6** — Container sandboxing bypassed on subsequent agent wakes. AI Maestro's docker-backed agents appear to run containerized only on first wake; subsequent wakes spawn on-host. Breaks the sandboxing intent silently. Not blocking the strategic-tier pattern for now because Optic/Mason/Rollie all run on-host anyway, but relevant for any future container-first deployment.
- **#7** — Mesh primer injection for meshAware agents without a prompt-type on-wake hook. Currently the primer is gated on `agent.hooks?.['on-wake']` being a prompt-type value. Agents without an on-wake hook (or with a shell-command hook) silently miss the primer even when `meshAware: true`. Workaround: give every meshAware agent a minimal prompt-type hook. Proper fix: inject primer as a standalone stdin write after `waitForPrompt()` when there's no hook.
- **#8** — Memory consolidation hardcoded to Claude Code session format. `services/agents-memory-service.ts` only reads conversation history from `~/.claude/projects/*/*.jsonl`. Gemini and Codex agents are silently skipped by the consolidator. Affects Optic, Mason, Rollie on Holmes. Fix is provider-aware source-path resolution and per-provider parsers, but requires empirical investigation of what Gemini and Codex actually persist (may be nothing).

All three are independent of the current strategic-tier pattern and do not block adding new agents. They are quality-of-life improvements to pick up later.

---

## 8. References

### Code locations

- `services/agents-core-service.ts` — `MESH_PRIMER` constant, `loadMeshPrimer()`, `executeHook()`, wake handler
- `types/agent.ts` — `Agent.meshAware` field definition
- `plugin/plugins/ai-maestro/scripts/amp-primer.sh` — amp-primer CLI implementation
- `plugin/plugins/ai-maestro/scripts/src/scripts/amp-primer.sh` — canonical source mirror
- `install-plugin.sh` — install script with `amp-*.sh` glob
- `tests/services/agents-core-service.test.ts` — mesh primer unit tests (10 cases including regression guards against command-syntax drift and hardcoded-path regressions)

### Key commits

- `d6adbe1` — original mesh-primer wake injection
- `e38a46c` — v2 review feedback (amp-send flag syntax, tests, nits)
- `0835b34` — v3 shell-quote regression guard
- `6719afb` — submodule bump for amp-primer --peers jq fix
- `1b54f3c` — hosts-config-server.mjs saveHostsToFile fix

### Related docs

- `docs/AGENT-COMMUNICATION-GUIDELINES.md` — general AMP protocol and agent communication guidance
- `docs/MEETING-CHAT.md` — multi-agent meeting protocol (complementary to AMP messaging)
- `docs/ARCHITECTURE.md` — overall ai-maestro architecture

### Origin

This pattern was designed, implemented, reviewed, deployed, and validated during a single extended session on 2026-04-10 and 2026-04-11 involving KAI, CelestIA, and dev-aimaestro-holmes (Watson) with Shane driving. The Iron Syndicate meeting thread contains the design discussion and review history. Optic and Mason were the first real-world agents migrated using the pattern; Rollie was retrofitted shortly after as the first case of issue #7 (primer for hookless agents). The Ziggy dev team was refactored onto the same pattern on 2026-04-11.
