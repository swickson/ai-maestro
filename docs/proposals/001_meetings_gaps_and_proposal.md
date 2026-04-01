# Proposal 001: Meeting Chat — Gaps and Proposed Architecture

**Date:** 2026-04-01
**Authors:** dev-aimaestro-admin (Kai), dev-aimaestro-bananajr (CelestIA), dev-aimaestro-holmes (Watson)
**Status:** Approved — ready for implementation
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
2. **We already have the infrastructure.** WebSocket in `server.mjs`, tmux `send-keys`, agent registry, meeting JSONL storage (`meeting-chat.ts`), WebSocket broadcast (`meeting-websocket.ts`), idle-aware injection with retry queues (`meeting-agent-injector.ts`). We are not building from scratch — the bones of Option 3 already exist in the codebase.
3. **AMP is wrong for group chat.** It's excellent for async point-to-point messaging across the mesh. Forcing group semantics onto it creates the telephone problem. Use each tool for what it's good at.
4. **The gap analysis is already done.** `docs/meeting-chat-gap-analysis.md` maps every gap. The implementation plan exists at `docs/meeting-chat-implementation-prompt.md`.

---

## Implementation Plan

> **Design principle:** All phases should be designed host-agnostic from the start. Injection paths, chat API URLs, and storage references should use the agent's `hostUrl` rather than assuming `localhost`, even if cross-host execution is deferred to Phase 5. This avoids ripping out assumptions later.

### Phase 1: Agent-to-Agent Chaining + @Mention Routing

Ship these together. Enabling agent-to-agent chaining without @mention routing would trigger ALL agents on every reply — a token bomb. These two changes are tightly coupled.

**Changes:**
- `app/api/meetings/[id]/chat/route.ts` — Remove `if (fromType === 'human')` gate, wire in router
- `lib/meeting-router.ts` — [NEW] Router class with @mention parsing, hop counting, loop guard
- `lib/meeting-agent-injector.ts` — Exclude sender from injection targets, accept target list from router
- `lib/meeting-chat.ts` — Add hop tracking metadata
- Chat UI — Add `/continue` command support, @mention autocomplete

**Acceptance criteria:**
- Agent replies trigger other agents in the meeting when @mentioned
- Messages without @mentions are visible in chat but don't trigger injections
- `@all` triggers all meeting participants except the sender
- Loop guard caps agent-to-agent exchanges (default 6 hops, configurable per meeting)
- Human messages always pass through and reset the hop counter
- Sender is excluded from injection targets
- `/continue` command resumes a paused conversation

### Phase 2: Human Operator Identity

Give the human operator a proper, distinct identity in the chat system. This is the operator's most visible pain point — messages showing as "Maestro@Milo" with no sent folder.

**Changes:**
- Meeting chat API — Accept operator identity (name, display name, role: "operator")
- Chat storage — Store human messages with proper attribution and a distinct `fromType`
- Chat UI — Display human messages with distinct styling from agent messages
- Sent messages visible to the sender in the chat window immediately

### Phase 3: Contextual Agent Injection

Replace raw curl templates with contextual prompts that include conversation history. Cap injection context to prevent token waste.

**Changes:**
- `lib/meeting-agent-injector.ts` — Include last N messages as context (default 10, max 20)
- Cap context to 2000 characters to control token spend
- Consider MCP tools (`meeting_read`, `meeting_send`) for cleaner agent interaction
- Agents respond with awareness of what others have said

### Phase 4: Cross-Host Support

Route injections through host proxy for remote agents. The meeting host (whoever starts the meeting) is the authoritative chat server. No storage replication needed — remote agents connect to the meeting host's chat API via the existing mesh proxy.

**Changes:**
- Use agent's `hostUrl` instead of `localhost` in injection commands
- Remote agents post to meeting host's chat API through mesh proxy
- WebSocket relay for real-time cross-host chat updates
- JSONL log lives on the meeting host only

### Phase 5: Presence and UX Polish

- Agent join/leave notifications in chat
- Idle/active/working status per agent
- Typing indicators

### Phase 6: Always-On Team Channels

Graduate from meeting-scoped to persistent team channels. This changes the data model (persistence, cleanup, membership management) and should only be attempted after the meeting-scoped pattern is validated.

---

## Decisions (from review feedback)

1. **Meeting-scoped first.** Always-on channels deferred to Phase 6 after pattern is validated. (CelestIA, Watson agreed)
2. **Replace, not coexist.** The current AMP-based meeting chat transport is fundamentally broken for group conversations. Swap it out entirely once Phase 1-2 land. (CelestIA, Watson agreed)
3. **Phase 1 ships chaining + @mentions together.** Chaining without @mentions is a token bomb. (CelestIA raised, Watson agreed)
4. **Human identity before @mentions in priority, but after chaining in implementation.** Swap original Phase 2/3 order — operator identity is simpler and higher impact. (Watson raised, CelestIA agreed)
5. **Loop guard default: 6 hops, configurable per meeting.** 4 is too low for 5+ agent teams. (Watson raised)
6. **Cross-host: meeting host is authoritative.** No replication. Remote agents proxy through mesh. (CelestIA raised)
7. **Token/cost awareness from Phase 3.** Cap injection context size. (CelestIA raised)

## Decisions (continued — from final review)

8. **MCP timing: after routing + injection context.** @mention routing defines the message flow, injection context defines what agents see. MCP tools become clean wrappers around a working pipeline. Building MCP first would mean designing the agent interface before the server orchestration exists. (CelestIA, Watson agreed)
9. **Default @all for visibility, @mention for triggering.** All messages are visible to all participants in the shared timeline (no addressing required). However, only @mentioned agents get tmux injection and are prompted to respond. Unaddressed messages from the operator are seen by everyone but don't trigger agent responses. This avoids token waste while making the chat feel like a real group conversation. `@all` explicitly triggers all agents. (Watson proposed the visibility/trigger split, CelestIA agreed)
10. **MCP is a priority but phase-flexible.** This team (Kai, CelestIA, Watson) will be the only testers until rollout. MCP will be in before other agents see it regardless of which phase it ships in. (Shane's directive)

---

## Related Documents

- `docs/meeting-chat-gap-analysis.md` — Detailed technical gap analysis
- `docs/meeting-chat-implementation-prompt.md` — Phase 1-2 implementation task
- [agentchattr](https://github.com/bcurts/agentchattr) — Reference implementation
- [AMP Protocol](https://agentmessaging.org) — Current messaging protocol spec
