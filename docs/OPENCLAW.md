# OpenClaw Integration

AI Maestro is **agent-agnostic** — it works with any terminal-based AI agent, including
[OpenClaw](https://github.com/) (the `clawdbot` runtime). OpenClaw agents are not created or
managed through the AI Maestro UI. Instead, you spin them up yourself and AI Maestro
**discovers and connects** to them automatically.

> **TL;DR** — Start OpenClaw so its tmux sessions live under a socket directory, point AI Maestro
> at that directory with `OPENCLAW_TMUX_SOCKET_DIR`, and the agents appear in the sidebar on the
> next poll — fully wired for terminal streaming, AMP messaging, kanban, and team meetings.

---

## The integration model: discover & connect, not create & manage

There are two ways an agent enters AI Maestro:

| Model | Examples | Lifecycle |
|-------|----------|-----------|
| **Create & manage** | Claude Code, Codex, Gemini, Antigravity, Cursor, Aider | You create them in the UI (Wake dialog, `CLI_OPTIONS`); AI Maestro starts/stops the CLI for you. |
| **Discover & connect** | **OpenClaw** | You start the agent yourself in its own tmux socket; AI Maestro finds it, registers it, and connects. |

Because OpenClaw is discover-and-connect, you will **not** find it in the Wake dialog's program
picker — there is no "create OpenClaw agent" path, by design. AI Maestro attaches to a session
you already brought up.

---

## Quick start

1. **Tell AI Maestro where OpenClaw's sockets live** (optional — there is a default):

   ```bash
   export OPENCLAW_TMUX_SOCKET_DIR=/tmp/clawdbot-tmux-sockets
   ```

   If unset, AI Maestro looks in `<os-tmpdir>/clawdbot-tmux-sockets` (i.e. `/tmp/clawdbot-tmux-sockets`
   on Linux/macOS).

2. **Spin up your OpenClaw / clawdbot agent** so it creates a tmux session on a socket inside that
   directory. (Session names must match `^[a-zA-Z0-9_-]+$` — alphanumeric, hyphens, underscores —
   or AI Maestro will skip them for path-traversal safety.)

3. **Open the AI Maestro dashboard.** On the next session poll the OpenClaw agent appears in the
   sidebar, auto-registered with `program: 'openclaw'`. Click it to stream the terminal.

That's it. No restart of AI Maestro is required — discovery runs on every `/api/sessions` poll.

---

## What happens on discovery

The discovery logic lives in `services/sessions-service.ts`. For each socket file in
`OPENCLAW_TMUX_SOCKET_DIR`:

1. Runs `tmux -S <socketPath> list-sessions` and parses each `name: N windows` line.
2. Skips any session already discovered through standard tmux, and skips names that fail the
   `^[a-zA-Z0-9_-]+$` validation.
3. **Auto-registers** the agent if it isn't already in the registry:
   - Queries the working directory via `tmux -S <socketPath> display-message -p '#{pane_current_path}'`.
   - Derives display tags from the session name.
   - Creates the agent with `program: 'openclaw'`, `owner` = the OS user, and the resolved
     working directory.
4. **Initializes AMP** for the agent (first registration only) and exports identity env vars into
   the tmux session so the agent can message the mesh:
   - `AMP_DIR` — the agent's AMP home
   - `AIM_AGENT_NAME` — the session name
   - `AIM_AGENT_ID` — the agent UUID
5. Surfaces the session to the dashboard, carrying its custom `socketPath` so terminal streaming
   attaches to the right socket.

Once registered, an OpenClaw agent is a **first-class citizen**: it participates in AMP messaging,
can be assigned kanban tasks, and can join team meetings — the same as any managed agent.

---

## Terminal streaming over a custom socket

Standard agents run on the default tmux socket; OpenClaw agents run on their own. AI Maestro
threads the socket path through the terminal WebSocket so the PTY attaches correctly:

```
Browser (xterm.js) → WS /term?name=<session>&socket=<socketPath>
                   → server.mjs → tmux -S "<socketPath>" attach-session -t <session>
```

You don't configure this — the dashboard fills in `socket=` from the discovered session.

---

## Running OpenClaw on a separate host or VM

**Discovery is local to the filesystem.** AI Maestro reads the socket directory with
`fs.readdirSync` and runs `tmux -S <socketPath>` against local sockets. It can only see OpenClaw
sessions on the **same machine** it is running on.

So if you run OpenClaw on a different VM (say, `scooter`):

1. **Install and run AI Maestro on that VM directly.** It's the instance on `scooter` that
   discovers `scooter`'s local OpenClaw sockets and serves their terminals.
   - Full mode (`yarn start`) gives you the dashboard + terminal locally on that VM.
   - Headless mode (`yarn headless:prod`) runs API-only if you want `scooter` purely as a worker
     node (lighter; ~100MB). See the server-modes section of the main README.

2. **Add the VM to the mesh** so it federates with your other hosts. Configure `hosts.json`
   (see [`docs/hosts.example.json`](./hosts.example.json)) so the OpenClaw agent on `scooter`
   becomes reachable for AMP messaging, kanban, and team meetings across the mesh — even though
   its terminal is streamed locally by `scooter`'s instance.

For the broader multi-host picture, see:
- [`docs/DISTRIBUTED-AGENT-ARCHITECTURE.md`](./DISTRIBUTED-AGENT-ARCHITECTURE.md)
- [`docs/REMOTE-SESSIONS-ARCHITECTURE.md`](./REMOTE-SESSIONS-ARCHITECTURE.md)
- [`docs/multi-computer.html`](./multi-computer.html)

> **Rule of thumb:** terminal streaming is always served by the AI Maestro instance local to the
> tmux socket; the mesh (AMP + `hosts.json`) is what makes that agent visible and addressable from
> your other hosts.

---

## Configuration reference

| Variable | Default | Purpose |
|----------|---------|---------|
| `OPENCLAW_TMUX_SOCKET_DIR` | `<os-tmpdir>/clawdbot-tmux-sockets` | Directory AI Maestro scans for OpenClaw tmux sockets. |

---

## Notes & limitations

- **No UI lifecycle.** AI Maestro discovers and connects to OpenClaw agents; it does not start,
  stop, or recreate them. Manage the OpenClaw process yourself.
- **Session-name rules.** Names outside `^[a-zA-Z0-9_-]+$` are skipped (path-traversal guard).
- **AMP init is one-time.** Identity env vars are written on first registration, not every poll.
- **Waking through AI Maestro.** Discovery and the session-launch path map `openclaw` → the
  `openclaw` command, so a discovered agent connects and (re)launches correctly. Because OpenClaw
  is a discover-and-connect agent you normally manage the process yourself rather than waking it
  through AI Maestro.

---

## Version history

- **0.24.9** — OpenClaw agents promoted to first-class citizens: auto-register on discovery
  (AMP, kanban, team meetings); auto-query working directory; auto-init AMP env; session-name
  validation.
- **0.24.8** — OpenClaw tmux session discovery via custom sockets at
  `/tmp/clawdbot-tmux-sockets/`; terminal streaming over WebSocket.
