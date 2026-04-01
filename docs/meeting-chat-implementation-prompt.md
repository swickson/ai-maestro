# Meeting Chat: Implementation Plan Task

## Context

We have a gap analysis at `docs/meeting-chat-gap-analysis.md` that compares our Meeting feature with [agentchattr](https://github.com/bcurts/agentchattr), a working reference implementation where AI coding agents chat in real-time using @mentions, tmux injection, and loop guards.

Our meeting feature already has: JSONL chat storage, WebSocket broadcast to UI, idle-aware tmux injection with retry queues, and token-based agent auth. The core architecture is solid.

## Your Task

Create an implementation plan to close the gaps identified in `docs/meeting-chat-gap-analysis.md`. Start with Phase 1 and Phase 2 as they are the highest priority.

### Phase 1: Agent-to-Agent Chaining
**The critical one-line fix plus safety:** Currently `app/api/meetings/[id]/chat/route.ts` only triggers agent injection for human messages (`if (fromType === 'human')`). Agent replies need to trigger injection to other meeting participants too, with a hop counter to prevent runaway loops.

Files to modify:
- `app/api/meetings/[id]/chat/route.ts` — Remove human-only gate, add loop guard
- `lib/meeting-agent-injector.ts` — Exclude sender from injection targets
- `lib/meeting-chat.ts` — May need hop tracking metadata

### Phase 2: @Mention Routing
Add targeted routing so agents are only triggered when @mentioned, not on every message.

Files to create/modify:
- `lib/meeting-router.ts` — [NEW] Router class with @mention parsing, hop counting, loop guard (reference `router.py` from agentchattr)
- `app/api/meetings/[id]/chat/route.ts` — Wire router into message flow
- `lib/meeting-agent-injector.ts` — Accept target list instead of injecting to all

### Key References
- **agentchattr source:** https://github.com/bcurts/agentchattr
  - `router.py` — @mention parsing + loop guard (max 4 hops, per-channel, human resets)
  - `wrapper_unix.py` — tmux send-keys injection pattern
  - `mcp_bridge.py` — MCP tools (chat_send, chat_read, etc.)
- **Our gap analysis:** `docs/meeting-chat-gap-analysis.md`
- **Our injection system:** `lib/meeting-agent-injector.ts` (already has idle detection + retry)
- **Our chat API:** `app/api/meetings/[id]/chat/route.ts`

### Acceptance Criteria
1. Agent replies trigger other agents in the meeting (not just human messages)
2. Loop guard caps agent-to-agent exchanges (suggest max 4 hops, configurable)
3. Human messages always pass through and reset the hop counter
4. `/continue` or equivalent lets the human resume after a loop guard pause
5. @mention parsing routes to specific agents (not all agents on every message)
6. Sender is excluded from injection targets (no self-triggering)

### Out of Scope for Now
- Cross-host agent support (tracked in gap analysis as Phase 4)
- MCP tools for meeting chat (Phase 3)
- Agent presence/heartbeats (Phase 5)

Write your implementation plan and get it reviewed before making code changes.
