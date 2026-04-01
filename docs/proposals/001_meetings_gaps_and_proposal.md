# Proposal 001: Meeting Chat — Gaps and Proposed Architecture

**Date:** 2026-04-01
**Authors:** dev-aimaestro-admin (Kai), dev-aimaestro-bananajr (CelestIA), dev-aimaestro-holmes (Watson)
**Status:** Draft — pending review
**Reference:** [agentchattr](https://github.com/bcurts/agentchattr)

---

## Executive Summary

AI Maestro's team meeting chat currently uses AMP (Agent Messaging Protocol) as its transport layer. AMP is designed for point-to-point async messaging and works well for that purpose, but it creates a poor group collaboration experience. Messages feel like a game of telephone — the operator messages one agent, that agent relays to others, and nobody sees the full picture.

After reviewing [agentchattr](https://github.com/bcurts/agentchattr) (a purpose-built agent chat room application), all three AI Maestro management agents independently reached the same conclusion: **group chat needs a shared timeline, not message fan-out.** This proposal outlines the gaps and a concrete plan to fix them.

---

## Current Architecture

| Component | File | Purpose |
|-----------|------|---------|
| Chat storage | `lib/meeting-chat.ts` | JSONL per meeting (`~/.aimaestro/teams/meetings/<id>/chat.jsonl`) |
| WebSocket broadcast | `lib/meeting-websocket.ts` | Push updates to browser UI clients |
| Agent injection | `lib/meeting-agent-injector.ts` | Idle-aware tmux `send-keys` with retry queue |
| Meeting registry | `lib/meeting-registry.ts` | File-based meeting CRUD |
| Chat API | `app/api/meetings/[id]/chat/route.ts` | REST: GET (history) + POST (send) |
| Chat setup | `app/api/meetings/[id]/chat-setup/route.ts` | Token generation + teardown |
| Frontend | `components/team-meeting/` | Meeting UI components |

---

## Root Cause Analysis

### Problem 1: No Shared Timeline

AMP is point-to-point (`to: string`, single recipient). When the operator "broadcasts," the system loops through participants making N separate API calls. Each agent only sees messages in their own inbox. Agents cannot see what other agents said.

### Problem 2: No Human Operator Identity

Messages from the human operator are sent as `from: 'maestro'` — a pseudo-agent with no UUID, no sent folder, and no proper identity. The operator cannot see their own messages in the chat window, and agents don't clearly recognize messages as coming from a human.

### Problem 3: Agents Are Isolated

Agent A cannot see Agent B's messages because storage is per-recipient. The meeting UI aggregates all inboxes as a privileged view, but individual agents only access their own AMP folders.

### Problem 4: Broadcast Is Synthetic

The UI deduplicates N copies of the same broadcast message to make it look like one message. It's not real group messaging — it's N individual messages dressed up.

### Problem 5: Only Human Messages Trigger Agents

In `app/api/meetings/[id]/chat/route.ts`:
```typescript
if (fromType === 'human') {
  injectMessageToAgents(meetingId, message, meeting)
}
```
When an agent posts a reply, no other agents are notified. Conversations cannot chain. This is the single biggest blocker to real collaboration.

### Problem 6: No @Mention Routing

All meeting agents receive every human message — no targeting. Without @mention routing, agents respond to messages not addressed to them, wasting tokens and creating noise.

### Problem 7: No Loop Guard

No hop counter or pause mechanism. If agent-to-agent chaining is enabled (fixing Problem 5), agents could ping-pong indefinitely without human review.

### Problem 8: Injection Uses Raw Curl

Agents receive a raw curl command template as their injection prompt. They see only the triggering message with no conversation context. agentchattr solves this with MCP tools (`chat_read`) that give agents full channel history.

### Problem 9: No Cross-Host Support

`sendCommand()` and `checkIdleStatus()` are local tmux operations. Injected curl targets `localhost:23000`, unreachable from remote hosts. Chat JSONL storage is local filesystem with no replication.

---

## How agentchattr Solves This

agentchattr is a Python/FastAPI application purpose-built for multi-agent chat rooms. Key design elements:

**Shared Room Model:** All participants (humans + agents) see the same message timeline via WebSocket broadcast. Messages are stored in a shared log, not per-recipient.

**@Mention Routing:** Agents are triggered via `@agent_name` mentions. The server parses mentions and injects prompts into the targeted agent's tmux session. Agents not mentioned are not triggered.

**MCP Tools:** Agents interact via `chat_send` and `chat_read` MCP tools instead of raw curl. `chat_read` provides full conversation context. Per-agent MCP proxy injects sender identity transparently.

**Human Identity:** The human has a configurable username displayed distinctly from agents. Human messages are clearly attributed.

**Loop Guard:** After N agent-to-agent hops (default 4 per channel), the system pauses and requires human `/continue` to resume. Human messages always pass through and reset the counter.

**Message Flow:**
```
@mention in chat → server parses it → writes to agent queue
→ wrapper watches queue → injects "mcp read #channel" via tmux send-keys
→ agent reads full context via MCP → responds via chat_send
→ if response @mentions another agent → router triggers that agent
→ loop guard pauses after N hops for human review
```

---

## Options Considered

### Option 1: Add Group Chat Layer on Top of AMP

Keep AMP for 1:1 and mesh routing. Add a separate lightweight group chat service with a shared message log, WebSocket broadcast, and API for agents to read/write.

**Pros:** No AMP protocol changes. Clear separation of concerns.
**Cons:** Two messaging systems to maintain. Meeting messages don't benefit from AMP's cross-host routing.

### Option 2: Extend AMP with Group Primitives

Add multi-recipient support (`to` accepts arrays or group addresses), server-side fan-out, channel/room concepts, and operator identity type.

**Pros:** Single protocol for everything.
**Cons:** Significant protocol change. AMP spec is externally maintained. Per-recipient storage is still fundamentally wrong for group chat. Adds complexity to a protocol designed for simplicity.

### Option 3: Shared-Timeline Chat Service (agentchattr Pattern)

Build a shared-timeline chat service inside AI Maestro inspired by agentchattr. Shared JSONL or DB-backed message log per room. WebSocket broadcast. @mention-based agent triggering. Human operator gets real identity. AMP continues for async cross-host messaging.

**Pros:** Proven pattern. We already have the infrastructure (WebSocket, tmux send-keys, agent registry). Best UX. Clean separation — AMP for async, shared chat for real-time.
**Cons:** New service to build (but most infrastructure exists).

---

## Recommendation: Option 3

All three agents independently recommended Option 3. The reasoning:

1. **agentchattr proved the pattern works.** Shared timeline + @mention routing + loop guards = real collaboration.
2. **We already have the infrastructure.** WebSocket in `server.mjs`, tmux `send-keys`, agent registry, meeting JSONL storage, idle-aware injection with retry queues.
3. **AMP is wrong for group chat.** It's excellent for async point-to-point messaging across the mesh. Forcing group semantics onto it creates the telephone problem. Use each tool for what it's good at.
4. **The gap analysis is already done.** `docs/meeting-chat-gap-analysis.md` maps every gap. The implementation plan exists at `docs/meeting-chat-implementation-prompt.md`.

---

## Implementation Plan

### Phase 1: Agent-to-Agent Chaining + Loop Guard (Quick Win)

Remove the human-only gate so agent replies trigger other participants. Add hop counter to prevent runaway loops.

**Changes:**
- `app/api/meetings/[id]/chat/route.ts` — Remove `if (fromType === 'human')` gate, add hop counter
- `lib/meeting-agent-injector.ts` — Exclude sender from injection targets
- `lib/meeting-chat.ts` — Add hop tracking metadata
- Chat UI — Add `/continue` command support

**Acceptance criteria:**
- Agent replies trigger other agents in the meeting
- Loop guard caps agent-to-agent exchanges (max 4 hops, configurable)
- Human messages always pass through and reset the hop counter
- Sender is excluded from injection targets

### Phase 2: @Mention Routing

Add targeted routing so agents are only triggered when @mentioned.

**Changes:**
- `lib/meeting-router.ts` — [NEW] Router class with @mention parsing, hop counting
- `app/api/meetings/[id]/chat/route.ts` — Wire router into message flow
- `lib/meeting-agent-injector.ts` — Accept target list instead of injecting to all
- Chat UI — Add @mention autocomplete

### Phase 3: Human Operator Identity

Give the human operator a proper identity in the chat system.

**Changes:**
- Meeting chat API — Accept operator identity (name, display name)
- Chat storage — Store human messages with proper attribution
- Chat UI — Display human messages distinctly from agent messages
- Sent messages visible to the sender in the chat window

### Phase 4: Contextual Agent Injection

Replace raw curl templates with contextual prompts that include conversation history.

**Changes:**
- `lib/meeting-agent-injector.ts` — Include last N messages as context in injection
- Consider MCP tools (`meeting_read`, `meeting_send`) for cleaner agent interaction
- Agents respond with awareness of what others have said

### Phase 5: Cross-Host Support

Route injections through host proxy for remote agents.

**Changes:**
- Use agent's `hostUrl` instead of `localhost` in injection commands
- Consider WebSocket relay for real-time cross-host chat
- Shared storage replication or centralized chat server

### Phase 6: Presence and UX Polish

- Agent join/leave notifications in chat
- Idle/active/working status per agent
- Typing indicators
- Always-on team channels (not just meeting-scoped)

---

## Open Questions

1. **Meeting-scoped or always-on?** agentchattr has persistent channels. Our meetings are time-bound. Should we support both?
2. **MCP integration priority?** MCP tools give agents cleaner chat access but add implementation complexity. Is Phase 4 sufficient, or should we fast-track MCP?
3. **Replace or coexist?** Should the new chat system replace the current meeting chat entirely, or run alongside it during transition?
4. **Cross-host timeline:** Phase 5 requires architectural decisions about where the shared log lives. Centralized server? Replicated? This affects the mesh architecture.

---

## Related Documents

- `docs/meeting-chat-gap-analysis.md` — Detailed technical gap analysis
- `docs/meeting-chat-implementation-prompt.md` — Phase 1-2 implementation task
- [agentchattr](https://github.com/bcurts/agentchattr) — Reference implementation
- [AMP Protocol](https://agentmessaging.org) — Current messaging protocol spec
