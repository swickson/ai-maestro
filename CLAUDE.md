# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Claude Code Dashboard** - A browser-based terminal dashboard for managing multiple Claude Code agents running in tmux on macOS. The application auto-discovers agents from tmux sessions and provides a unified web interface with real-time terminal streaming.

**Current Phase:** Phase 1 - Local-only, auto-discovery, no authentication
**Tech Stack:** Next.js 14 (App Router), React 18, xterm.js, WebSocket, node-pty, Tailwind CSS, lucide-react
**Platform:** macOS 12.0+, Node.js 18.17+/20.x, tmux 3.0+
**Branding:** Space Grotesk font, titled "AI Maestro"
**Port:** Application runs on port 23000 (http://localhost:23000)

## Development Commands

```bash
yarn install             # Install all dependencies
yarn dev                 # Start dev server (http://localhost:23000)
yarn build               # Build optimized production bundle
yarn start               # Start production server
pm2 restart ai-maestro   # Restart production server via PM2
yarn test                # Run unit tests (vitest)
yarn test:watch          # Run tests in watch mode
```

**Health Check:** Use `/api/sessions` (not `/api/health`, which doesn't exist).

## Version Management

**IMPORTANT:** Always use the centralized script to bump versions:

```bash
./scripts/bump-version.sh patch    # 0.17.12 -> 0.17.13
./scripts/bump-version.sh minor    # 0.17.12 -> 0.18.0
./scripts/bump-version.sh major    # 0.17.12 -> 1.0.0
./scripts/bump-version.sh 1.0.0    # Set specific version
```

**DO NOT manually edit version numbers in individual files.** The script updates `version.json`, `package.json`, `scripts/remote-install.sh`, `README.md`, `docs/index.html`, `docs/ai-index.html`, and `docs/BACKLOG.md`.

**CLI Script Versioning:** `aimaestro-agent.sh` uses an independent semver (`v1.x.x`) separate from the app version.

## Pre-PR Checklist (MANDATORY)

**Every PR to main MUST:**
1. Pass tests: `yarn test`
2. Bump version: `./scripts/bump-version.sh patch`
3. Pass build: `yarn build`
4. Commit the version bump with your changes

Also draft an X (Twitter) post announcing the release. All marketing content goes in the gitignored `marketing/` folder.

---

## Architecture (Critical Constraints)

For detailed architecture documentation, see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md). Below are only the constraints that prevent bugs.

### Agent-First Architecture (CRITICAL)

**AGENTS ARE THE CORE ENTITY.** Sessions are optional properties of agents.

- `lib/agent-registry.ts` — File-based registry (`~/.aimaestro/agents/registry.json`), THE source of truth
- `lib/agent.ts` — In-memory Agent class for runtime (database, subconscious)
- **workingDirectory is STORED on the agent**, not derived from tmux
- **Sessions are discovered and LINKED to agents**, not the other way around
- Use `getAgent(id)` or `getAgentBySession(name)` from `@/lib/agent-registry`

### server.mjs Constraints

Custom server combining HTTP + WebSocket on the same port. When modifying:
- Preserve the upgrade handler that intercepts WebSocket requests
- Maintain session pooling logic (multiple clients → one PTY)
- Never block the event loop during PTY operations

### Server Modes

Two modes via `MAESTRO_MODE` env var: **Full** (default, Next.js UI + API) and **Headless** (`yarn headless`, API-only via `services/headless-router.ts`, ~1s startup). See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for details.

### Terminal Constraints

- **`convertEol: false`** — MUST be false for PTY connections. `true` causes character duplication.
- **visibility:hidden, NOT display:none** for inactive terminal tabs — `display:none` breaks `getBoundingClientRect()`, causing 0-width terminals
- **Empty dependency array** on terminal initialization `useEffect` — terminals init once, never re-init on agent switch
- **Addon loading order:** load addons → `terminal.open(container)` → `fitAddon.fit()`
- **Always call `fitAddon.fit()`** after open and on window resize
- WebSocket connections persist across visibility changes (created once on mount)

### Meeting Chat Constraints

See [docs/MEETING-CHAT.md](docs/MEETING-CHAT.md) for full documentation.

- **Injection must use split text+delay+Enter pattern** — single `sendKeys` causes tmux stacking
- **Human messages default to @all; agent messages require explicit @mentions** (prevents loops)
- **Loop guard trips at 6 hops**, human `/continue` resets it

### Localhost-Only Security Model (Phase 1)

- Binds to `localhost` only. No auth, no CORS, no TLS.
- **DO NOT implement** authentication, agent-level permissions, or HTTPS.

## Common Gotchas

1. **tmux session names:** `^[a-zA-Z0-9_-]+$` only. Invalid chars cause silent `tmux attach` failure.
2. **Nested buttons:** Cause React hydration errors. Use `<div>` with `cursor-pointer` + `onClick`.
3. **WebSocket reconnection:** Max 5 attempts with exponential backoff. Don't retry indefinitely.
4. **tmux list-sessions parsing:** Use regex `/^([a-zA-Z0-9_-]+):/` — handles hyphens, underscores, multi-digit window counts.
5. **Dynamic colors:** Hash-based assignment in `SessionList.tsx`. Never hardcode category colors.

## Environment Variables

Set via `.env.local` (gitignored). All optional with sensible defaults:

```bash
PORT=3000                            # Server port
NODE_ENV=development|production
WS_RECONNECT_DELAY=3000             # WebSocket reconnect delay (ms)
WS_MAX_RECONNECT_ATTEMPTS=5
TERMINAL_FONT_SIZE=14
TERMINAL_SCROLLBACK=10000
NOTIFICATIONS_ENABLED=true           # AMP push notifications
```

## What NOT to Do

- **Don't query tmux to get agent properties** — use the registry
- **Don't assume agents need sessions** — agents are the core entity
- **Don't implement authentication** — Phase 1 is localhost-only
- **Don't store terminal history in React state** — xterm.js manages scrollback
- **Don't use display:none for hidden terminals** — use visibility:hidden
- **Don't add session.id to terminal useEffect deps** — empty array, mount once
- **Don't nest interactive elements** — causes hydration errors
- **Don't hardcode category colors** — use hash-based dynamic system

## Key Files

1. `lib/agent-registry.ts` — Agent registry (source of truth)
2. `lib/agent.ts` — In-memory Agent class (runtime)
3. `server.mjs` — Custom HTTP + WebSocket server
4. `app/page.tsx` — Main dashboard UI
5. `components/SessionList.tsx` — Hierarchical sidebar
6. `components/TerminalView.tsx` — Terminal display
7. `hooks/useWebSocket.ts` / `useTerminal.ts` — Connection + terminal lifecycle

## Roadmap

**Phase 1 (Current):** Auto-discovery, localhost-only, read-only agent interaction
**Phase 2 (Planned):** Agent creation from UI, grouping, search
**Phase 3 (Future):** Remote SSH sessions, authentication, collaboration

Don't over-engineer for future phases.

## Documentation References

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — Full architecture details, patterns, AMP protocol
- [docs/MEETING-CHAT.md](docs/MEETING-CHAT.md) — Meeting chat system
- [docs/REQUIREMENTS.md](docs/REQUIREMENTS.md) — Installation prerequisites
- [docs/OPERATIONS-GUIDE.md](docs/OPERATIONS-GUIDE.md) — Agent management, troubleshooting
- [docs/CEREBELLUM.md](docs/CEREBELLUM.md) — Cerebellum subsystem, voice pipeline
