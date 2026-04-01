# Meeting Feature: Gap Analysis vs AgentChatTR

> **Reference:** [agentchattr](https://github.com/bcurts/agentchattr) — the target architecture for agent-to-agent meeting chat.

## Current Architecture

The meeting feature has the following backend components:

| File | Purpose |
|------|---------|
| `lib/meeting-chat.ts` | JSONL chat storage per meeting (`~/.aimaestro/teams/meetings/<id>/chat.jsonl`) |
| `lib/meeting-websocket.ts` | WebSocket broadcast to UI clients |
| `lib/meeting-agent-injector.ts` | Idle-aware tmux injection with retry queue |
| `lib/meeting-registry.ts` | File-based meeting CRUD (`~/.aimaestro/teams/meetings.json`) |
| `app/api/meetings/[id]/chat/route.ts` | REST API: GET (read history) + POST (send message) |
| `app/api/meetings/[id]/chat-setup/route.ts` | Meeting chat init (token gen) + teardown (cleanup) |

Frontend components live in `components/team-meeting/`.

## How AgentChatTR Solves Agent Interaction

```
@mention in chat → server router parses it → writes to agent's queue file
→ wrapper.py watches queue → injects "mcp read #channel" via tmux send-keys
→ agent reads full context via MCP tool → responds via chat_send MCP tool
→ if response @mentions another agent → router triggers that agent
→ loop guard pauses after N hops for human review
```

Key design elements:
- **Router** (`router.py`): Parses @mentions, routes to targets, per-channel hop counter (max 4), human messages reset counter
- **Wrapper** (`wrapper_unix.py`): `tmux send-keys` injection; agents run inside managed tmux sessions
- **MCP proxy**: Per-agent proxy on auto-assigned ports; injects sender identity transparently
- **Loop guard**: `/continue` command resumes paused channels

## Gaps

### Gap 1: Agent→Agent Chaining (Critical)

In `app/api/meetings/[id]/chat/route.ts` line 74:
```typescript
if (fromType === 'human') {
  injectMessageToAgents(meetingId, message, meeting)
}
```

**Only human messages trigger injection.** When an agent posts via curl, the message is saved and broadcast to the UI, but no other agents are notified. Conversations cannot chain.

### Gap 2: No @Mention Routing

All meeting agents receive every human message — no targeting. AgentChatTR routes only to @mentioned agents. Without this, agents respond to messages that aren't addressed to them.

### Gap 3: No Loop Guard

No hop counter or pause mechanism. If agent chaining is enabled (Gap 1), agents could ping-pong indefinitely without human review.

### Gap 4: Injection Content is a Raw Curl Command

The injected prompt is a curl command template:
```
Reply with: curl -s -X POST http://localhost:23000/api/meetings/.../chat \
  -H 'Content-Type: application/json' \
  -d '{"from":"<agentId>","text":"YOUR_REPLY","token":"..."}'
```

AgentChatTR injects `mcp read #channel` — the agent reads **full conversation context** and responds via an MCP tool. Our agents only see the single triggering message and must construct raw HTTP manually.

### Gap 5: No Cross-Host Support

- `sendCommand()` / `checkIdleStatus()` are local tmux operations — no remote proxy
- Injected curl targets `http://localhost:23000` — unreachable from remote hosts
- Chat JSONL storage is local filesystem — no replication

### Gap 6: No Agent Presence in Meeting Context

AgentChatTR has `chat_who` (see who's online), `chat_join` (enter a channel), and heartbeats. Our meetings have `agentIds` in the meeting record but no live presence tracking.

## Recommended Implementation Phases

### Phase 1: Agent-to-Agent Chaining (Quick Win)
- Remove the `if (fromType === 'human')` gate in `chat/route.ts`
- Inject to all participants except the sender
- Add simple hop counter (max N agent messages per burst)
- Add `/continue` support in chat UI

### Phase 2: @Mention Routing
- Add `MeetingRouter` class (port the concept from agentchattr's `router.py`)
- Parse @mentions from message text
- Route injections only to mentioned agents
- Update UI to show @mention autocomplete

### Phase 3: Better Injection Prompt
- Replace curl template with a contextual prompt
- Include recent conversation summary (last N messages)
- Tell agent to use the chat API (or an MCP tool) to respond
- Consider building a meeting-specific MCP tool (`meeting_read`, `meeting_send`)

### Phase 4: Cross-Host Support
- Route injections through host proxy for remote agents
- Use agent's `hostUrl` instead of `localhost` in curl commands
- Consider using AMP as transport for meeting messages

### Phase 5: Presence & UX
- Agent join/leave notifications in chat
- Idle/active status per agent
- Typing indicators
