# Architecture Reference

Detailed architecture documentation for AI Maestro. For quick coding guidance, see [CLAUDE.md](../CLAUDE.md).

## Custom Server Architecture (server.mjs)

**Why it exists:** Next.js alone doesn't support WebSocket on the same port as HTTP. The custom server combines both.

```
HTTP Requests → Next.js handlers (API routes, pages)
WebSocket Upgrades → Custom WS server (terminal streaming)
Both on port 23000
```

**Key constraint:** The server must handle:
- HTTP/HTTPS for Next.js (pages, API routes)
- WebSocket upgrade requests for `/term?name=<sessionName>`
- Session discovery via `tmux ls` command execution

When modifying `server.mjs`:
- Preserve the upgrade handler that intercepts WebSocket requests
- Maintain the session pooling logic (multiple clients → one PTY)
- Never block the event loop during PTY operations

## Agent-First Architecture

**AGENTS ARE THE CORE ENTITY.** Sessions are optional properties of agents.

```
Agent (core entity)
├── id (UUID)
├── name (agent identity, used as session name)
├── label (optional display override)
├── workingDirectory (stored property, NOT derived from tmux)
├── sessions[] (array of AgentSession, typically 0 or 1)
│   ├── index (0 for primary session)
│   ├── status ('online' | 'offline')
│   └── workingDirectory (optional override)
└── preferences.defaultWorkingDirectory
```

**Key principles:**
1. **Agents can exist without sessions** - An agent for querying repos/documents doesn't need a tmux session
2. **workingDirectory is STORED on the agent** - Set when agent is created or session is linked
3. **NEVER query tmux to derive agent properties** - All agent data comes from the registry
4. **Sessions are discovered and LINKED to existing agents** - Not the other way around

**Two agent systems:**
- **`lib/agent-registry.ts`** - File-based registry (`~/.aimaestro/agents/registry.json`) with full agent metadata
- **`lib/agent.ts`** - In-memory Agent class for runtime (database, subconscious)

When you need agent metadata (workingDirectory, etc.), use the file-based registry:
```typescript
import { getAgent, getAgentBySession } from '@/lib/agent-registry'
const agent = getAgent(agentId) || getAgentBySession(sessionName)
const workingDir = agent?.workingDirectory || agent?.sessions?.[0]?.workingDirectory
```

**Subconscious runs LOCAL to the agent:**

The subconscious process runs on the **same machine where the agent lives**. This means it has direct access to:
- Local conversation files (`~/.claude/projects/`)
- The agent's CozoDB database (`~/.aimaestro/agents/<id>/`)
- The local file system (workingDirectory, repos, etc.)

The subconscious does NOT need remote API calls to access agent data - everything is local.

**Subconscious timers (v0.18.10+):**
- `maintainMemory()` - Indexes conversations for semantic search (runs periodically)
- `triggerConsolidation()` - Long-term memory consolidation (runs periodically)
- `checkMessages()` - **DISABLED by default** (push notifications replace polling)

## Session Discovery Pattern

Sessions are discovered from tmux and LINKED to agents:

```
/api/sessions → Execute `tmux ls` → Parse output → Link to registry agents → Return JSON
```

**Implementation details:**
- Agents are ephemeral - they exist only while tmux is running
- No persistent state between dashboard restarts
- Agent metadata comes from tmux directly (creation time, working directory)
- The dashboard does NOT create or manage agents (Phase 1 limitation)

When implementing agent-related features:
- Always assume agents can disappear between API calls
- Never cache agent data longer than 5-10 seconds
- Handle `tmux ls` returning empty results gracefully
- Session IDs must match tmux session names exactly (alphanumeric + hyphens/underscores only)

## WebSocket-PTY Bridge

**Critical data flow:**
```
Browser (xterm.js)
  ↕ WebSocket messages (text/binary)
Server (node-pty)
  ↕ PTY (tmux attach-session -t <name>)
tmux session
  ↕ Claude Code CLI
```

**Important constraints:**
- PTY instances are pooled: Multiple WebSocket clients can connect to the same tmux session
- PTY is created on first client connect, destroyed when last client disconnects
- Terminal resize events must be propagated: Browser → WebSocket → PTY → tmux
- Input/output is binary-safe (supports ANSI escape codes, Unicode, etc.)

When working with terminal components:
- xterm.js handles rendering only - it doesn't know about tmux
- WebSocket is the only communication channel (no polling)
- PTY errors (session not found, tmux crashed) must close WebSocket gracefully
- Terminal dimensions (cols/rows) must sync on window resize

## Tab-Based Multi-Terminal Architecture

**Critical architectural pattern (v0.3.0+):** All agents are mounted simultaneously as "virtual tabs" with CSS visibility toggling.

**Why this architecture:**
- Eliminates complex agent-switching logic (was 85+ lines of race condition handling)
- Terminals initialize once on mount, never re-initialize on agent switch
- Instant agent switching (no unmount/remount cycle)
- Preserves terminal state, scrollback, and WebSocket connections
- Agent notes stay in memory (no localStorage reload on switch)

**Implementation:**
```tsx
// app/page.tsx - All sessions rendered, toggle visibility
{sessions.map(session => {
  const isActive = session.id === activeSessionId
  return (
    <div
      key={session.id}
      className="absolute inset-0 flex flex-col"
      style={{
        visibility: isActive ? 'visible' : 'hidden',
        pointerEvents: isActive ? 'auto' : 'none',
        zIndex: isActive ? 10 : 0
      }}
    >
      <TerminalView session={session} />
    </div>
  )
})}
```

**Why visibility:hidden instead of display:none:**
- `display: none` removes element from layout → getBoundingClientRect() returns 0 dimensions → terminal initializes with incorrect width
- `visibility: hidden` keeps element in layout → correct dimensions → proper terminal sizing
- `pointerEvents: none` prevents hidden tabs from capturing mouse events
- Text selection works immediately without agent switching

**Terminal initialization pattern:**
```typescript
// components/TerminalView.tsx
useEffect(() => {
  // Initialize ONCE on mount, never cleanup until unmount
  const init = async () => {
    cleanup = await initializeTerminal(containerElement)
    setIsReady(true)
  }
  init()

  return () => {
    if (cleanup) cleanup()
  }
}, []) // Empty deps = mount once, no session.id dependency
```

## React State Management Pattern

**Deliberately minimal:** No Redux, Zustand, or complex state libraries.

```
App State:
- Active agent ID (localStorage persistence, drives visibility toggle)
- Agent list (fetched from /api/sessions every 10s)
- WebSocket connection state (per agent, persistent)

Component State:
- Terminal instance (xterm.js, created once per agent)
- Connection errors (transient, cleared on retry)
- Agent notes (loaded once, persist in component state)
```

**Key hooks:**
- `useSessions()` - Fetches session list, auto-refreshes
- `useTerminal()` - Manages xterm.js lifecycle (init once, resize, dispose)
- `useWebSocket()` - Handles WebSocket connection, reconnection, message routing
- `useActiveSession()` - Tracks selected agent with localStorage

When adding new state:
- Keep it in the nearest component that needs it
- Use Context only if 3+ components need the same state
- Never store terminal content in React state (xterm.js manages this)
- Consider if state needs to persist across agent switches (keep in component) vs. reload (use effect with session.id dependency)

## UI Enhancement Patterns

**Hierarchical Agent Organization:**

Agents are organized in a 3-level hierarchy based on their names:
```
fluidmind/agents/backend-architect  →  Level 1: "fluidmind"
                                        Level 2: "agents"
                                        Agent: "backend-architect"
```

**Dynamic Color System:**
- Colors assigned via hash function (same category = same color)
- 8-color palette in `SessionList.tsx` (easily customizable)
- No hardcoded category names - works with ANY category

**UI Best Practices:**
- Avoid nested buttons (causes React hydration errors)
- Use `<div>` with `cursor-pointer` for clickable containers
- Always use `e.stopPropagation()` for nested interactive elements
- Keep hover states smooth with `transition-all duration-200`

## Team Meeting Architecture (v0.20.19+)

**State machine pattern:** Team meetings use a `useReducer` with a `TeamMeetingState` that tracks meeting phase (`idle` → `selecting` → `ringing` → `active`), selected agents, and UI state (sidebar mode, right panel, kanban open).

**Meeting Chat (v0.27.0+ — Shared Timeline):**

Meeting chat uses a **shared JSONL log per meeting** instead of AMP fan-out. All participants (human + agents) read and write to the same log. See `docs/MEETING-CHAT.md` for full documentation.

Key components:
- `lib/meeting-chat-service.ts` — JSONL append/read/delete service
- `lib/meeting-router.ts` — @mention parsing, agent targeting, loop guard
- `lib/meeting-presence.ts` — Agent presence tracking (join/leave, status dots)
- `app/api/meetings/[id]/chat/route.ts` — REST API (POST to send, GET to read with cursor)
- `server.mjs` — WebSocket broadcast server at `/meeting-chat`
- `hooks/useMeetingMessages.ts` — WebSocket + REST polling frontend hook
- `scripts/meeting-send.sh` / `meeting-read.sh` — CLI tools for agents

**Message flow:**
1. Human types in chat → POST to `/api/meetings/{id}/chat` with `fromType: "human"`
2. Message appended to `~/.aimaestro/teams/meetings/{id}/chat.jsonl`
3. WebSocket broadcasts to all browser clients
4. Router triggers agents: human messages default to @all, agents need explicit @mentions
5. Injection: local agents get `sendKeys` (text + 500ms + Enter), remote agents get HTTP POST to `/api/agents/notify`
6. Agents receive last 8 messages as context (capped 2000 chars) + reply command via `meeting-send.sh`

**Critical: Injection must use split text+delay+Enter pattern.** A single `sendKeys` with literal+enter causes tmux [Pasted text] stacking. Send text first, wait 500ms, then send Enter separately.

**Routing rules:**
1. Human messages always pass through and reset the loop guard
2. Human messages with no @mentions default to @all
3. Agent messages require explicit @mentions to trigger others (prevents loops)
4. Loop guard trips at 6 hops (configurable), human `/continue` resets it

**Task system:**
- Tasks stored per-team in `~/.aimaestro/teams/tasks-{teamId}.json`
- 5 statuses: `backlog` → `pending` → `in_progress` → `review` → `completed`
- Dependency chains: tasks can block other tasks, auto-unblock on completion
- `useTasks` hook polls every 5s for multi-tab sync

**Kanban board:**
- Full-screen overlay (`fixed inset-0 z-40`) matching agent picker overlay pattern
- Native HTML5 drag-and-drop (same pattern as AgentList.tsx)
- `KanbanCard`: `draggable={!task.isBlocked}`, stores taskId in `dataTransfer`
- `KanbanColumn`: `onDragOver`/`onDrop` handlers update task status
- Escape key closes modals in priority order: detail view → quick-add → board
- Blocked tasks show lock icon, not draggable

## TypeScript Type System Organization

**Strict separation by domain:**

```
types/session.ts    - Session metadata, status enums
types/terminal.ts   - xterm.js configuration, dimensions
types/websocket.ts  - Message protocol, connection states
```

**WebSocket message protocol:**
```typescript
{ type: 'input', data: string }           // User typed in terminal
{ type: 'output', data: string }          // Terminal output from tmux
{ type: 'resize', cols: number, rows: number }  // Terminal resized
{ type: 'ping' / 'pong' }                 // Heartbeat
{ type: 'error', error: string }          // Protocol error
```

All WebSocket messages are JSON. Raw terminal output (ANSI codes) is wrapped in `{ type: 'output', data: ... }`.

## Terminal Rendering Performance

xterm.js uses **Canvas or WebGL** for rendering. The WebGL addon significantly improves performance for high-output scenarios.

**Never** read terminal content via React state. Always use xterm.js APIs (`terminal.write()`, `terminal.onData()`).

## Critical Terminal Configuration for PTY/tmux

1. **`convertEol: false`** - PTY and tmux handle line endings correctly. Setting this to `true` causes character duplication and incorrect line breaks.

2. **Alternate Screen Buffer Support** - Claude Code uses tmux's alternate screen buffer. The `windowOptions: { setWinLines: true }` setting enables proper alternate buffer support.

3. **Scrollback Capture Strategy** - On initial connection, capture both normal and alternate screen content:
   ```bash
   # Try to capture full history (50000 lines)
   tmux capture-pane -t <session> -p -S -50000 -e -1
   # Fallback to visible content only
   tmux capture-pane -t <session> -p
   ```

**Common Issues and Fixes:**
- **Every character creates a new line**: `convertEol` was set to `true` - must be `false` for PTY connections
- **Can't scroll back during Claude session**: Use Shift+PageUp/Down or tmux copy mode (Ctrl-b [)
- **Lost history after switching agents**: History capture timeout too short - use 150ms minimum

## WebSocket Reconnection Strategy

```typescript
const reconnect = {
  maxAttempts: 5,
  backoff: [100, 500, 1000, 2000, 5000],
  strategy: 'exponential'
}
```

After 5 failed attempts, show error to user. Do NOT retry indefinitely.

## Server Modes

AI Maestro supports two server modes controlled by the `MAESTRO_MODE` environment variable:

### Full Mode (default)
```bash
yarn dev        # Development with hot reload
yarn start      # Production
```
- Uses Next.js for both UI pages and API routes
- All features available: dashboard, terminal WebSockets, API endpoints
- Startup: ~5s, Memory: ~300MB

### Headless Mode
```bash
yarn headless        # Development
yarn headless:prod   # Production
```
- API-only mode — no Next.js, no UI pages
- All ~100 API endpoints served via standalone HTTP router (`services/headless-router.ts`)
- WebSocket connections work identically
- Uses `tsx` for TypeScript support
- Startup: ~1s, Memory: ~100MB
- Ideal for worker nodes that only need the API surface

**Architecture:**
- `server.mjs` branches on `MAESTRO_MODE` at startup
- Full mode: `node server.mjs` → Next.js `app.prepare()` → `handle(req, res)`
- Headless mode: `tsx server.mjs` → `createHeadlessRouter()` → `router.handle(req, res)`
- All WebSocket servers, PTY handling, startup tasks, and graceful shutdown are shared between modes
- The `/api/internal/pty-sessions` endpoint is served directly from `server.mjs` in both modes

## Agent Messaging Protocol (AMP)

AI Maestro uses AMP for inter-agent communication. AMP is like email for AI agents - local-first with optional federation.

**Key Features:**
- Local-first with Ed25519 cryptographic signing
- Federation via external providers (CrabMail, etc.)
- Provider-agnostic CLI

**Two Components:**
1. **AMP Plugin (Client)** - Installed on each agent machine (`plugin/plugins/ai-maestro/`)
2. **AI Maestro (Provider)** - Server that routes messages

**Installation:** `./install-plugin.sh` (or `./install-plugin.sh -y` for non-interactive)

**CLI Commands:** `amp-init.sh`, `amp-send.sh`, `amp-inbox.sh`, `amp-read.sh`, `amp-reply.sh`, `amp-delete.sh`, `amp-register.sh`, `amp-fetch.sh`, `amp-status.sh`

**Provider API Endpoints:**
- `GET /api/v1/health` - Health status
- `GET /api/v1/info` - Provider capabilities
- `POST /api/v1/register` - Register agent, get API key
- `POST /api/v1/route` - Route a signed message
- `GET /api/v1/messages/pending` - Poll for offline messages
- `DELETE /api/v1/messages/pending?id=X` - Acknowledge message

**Message Storage:** `~/.agent-messaging/agents/<agentName>/messages/{inbox,sent}/`

**Push Notifications:** When a message is routed to a local agent, AI Maestro sends a tmux notification. Control via `NOTIFICATIONS_ENABLED` and `NOTIFICATION_FORMAT` env vars.

**Development Notes:**
- Plugin submodule at `plugin/` - update with `git submodule update --remote`
- Protocol spec: https://agentmessaging.org
- Messages signed with Ed25519; AI Maestro verifies signatures

## File Structure

```
app/                    - Next.js pages and API routes
components/             - React components (keep small, single responsibility)
  team-meeting/         - Meeting UI components (kanban, chat, tasks)
hooks/                  - Custom React hooks (WebSocket, terminal, sessions, tasks, chat)
lib/                    - Server-side services (registry, chat, routing, presence)
types/                  - TypeScript types separated by domain
docs/                   - Documentation and static site
plugin/                 - Plugin submodule (AMP scripts, skills, hooks)
scripts/                - Utility scripts (version bump, agent init, meeting CLI)
server.mjs              - Custom Next.js server (HTTP + WebSocket)
```

## Testing

```bash
yarn test                           # Unit tests (vitest)
yarn test:watch                     # Watch mode
./scripts/test-amp-routing.sh       # AMP local routing tests
./scripts/test-amp-cross-host.sh    # AMP cross-host mesh tests
```

**Manual testing:** Start `yarn dev`, create tmux sessions, verify auto-discovery and terminal streaming.
