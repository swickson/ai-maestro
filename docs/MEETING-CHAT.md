# Meeting Chat System

**Version:** v0.27.1
**Date:** 2026-04-01
**Authors:** Kai (dev-aimaestro-admin), CelestIA (dev-aimaestro-bananajr), Watson (dev-aimaestro-holmes)

---

## Overview

AI Maestro's meeting chat is a real-time group collaboration system for multi-agent meetings. It replaces the earlier AMP-based point-to-point messaging with a **shared timeline** — all participants (human operator + agents) read and write to the same message log.

The system supports cross-host meetings across the AI Maestro mesh network. Agents on different machines (e.g., milo, bananajr, holmes) participate in the same meeting via HTTP proxying and tmux injection.

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Meeting Host (whoever starts the meeting)              │
│                                                         │
│  ┌─────────────────┐  ┌──────────────────────────────┐  │
│  │ Shared JSONL Log │  │ WebSocket Broadcast Server   │  │
│  │ (~/.aimaestro/   │  │ /meeting-chat WS endpoint    │  │
│  │  teams/meetings/ │  │ in server.mjs                │  │
│  │  {id}/chat.jsonl)│  └──────────────────────────────┘  │
│  └─────────────────┘                                     │
│                                                         │
│  ┌──────────────────┐  ┌──────────────────────────────┐  │
│  │ Meeting Router   │  │ Agent Injection              │  │
│  │ @mention parsing │  │ tmux send-keys (local)       │  │
│  │ Loop guard       │  │ HTTP POST /api/agents/notify  │  │
│  │ Default @all     │  │ (remote via mesh)            │  │
│  └──────────────────┘  └──────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
         │                        │
    REST API                 WS Broadcast
         │                        │
┌────────┴────────┐    ┌──────────┴──────────┐
│  Browser UI      │    │  Remote Hosts       │
│  MeetingChatPanel│    │  /api/agents/notify  │
│  useMeetingMsgs  │    │  (injection proxy)   │
└──────────────────┘    └─────────────────────┘
```

---

## Message Flow

### Human → Agents

1. Human types in the `MeetingChatPanel` input field
2. Frontend POSTs to `POST /api/meetings/{id}/chat` with `fromType: "human"`
3. Message appended to shared JSONL log via `postChatMessage()`
4. WebSocket broadcasts the message to all connected browser clients
5. Meeting router runs:
   - Human messages with no `@mentions` → default to `@all` (all agents triggered)
   - Human messages with `@agent-name` → only mentioned agents triggered
   - Loop guard is reset (human messages always pass through)
6. For each target agent:
   - **Local agent:** `sendKeys` directly into tmux session (text + 500ms delay + Enter)
   - **Remote agent:** HTTP POST to `{hostUrl}/api/agents/notify` with `injection` payload
7. Agent receives the injection prompt with conversation context (last 8 messages)
8. Agent replies via `meeting-send.sh` or `curl` to the chat API

### Agent → Meeting

1. Agent runs `meeting-send.sh {meetingId} "reply" --from {agentId} --alias {name} --host {meetingHostUrl}`
2. POST arrives at the meeting host's `/api/meetings/{id}/chat`
3. Message appended to shared log, broadcast via WebSocket
4. Router runs with `fromType: "agent"`:
   - Agent messages with `@mentions` → trigger mentioned agents (hop counter incremented)
   - Agent messages without `@mentions` → visible to all, triggers nobody
   - If loop guard is tripped (N hops) → message is blocked, human must `/continue`

### Cross-Host Flow

Remote agents post to the meeting host's chat API via the mesh:
```
Remote agent → local AI Maestro → mesh proxy → meeting host → chat API
```

Remote injection goes the reverse path:
```
Meeting host → HTTP POST to remote host's /api/agents/notify → tmux send-keys
```

---

## Key Components

### `lib/meeting-router.ts` — Routing + Loop Guard

- `parseMentions(text)` — Extracts `@agent-name`, `@all`, `/continue` from message text
- `routeMessage(ctx)` — Determines which agents to trigger based on mentions, fromType, and loop guard state
- `resetLoopGuard(meetingId)` — Resets hop counter (called on human messages and `/continue`)
- `getLoopGuardStatus(meetingId)` — Returns current hop count, max, and paused state

**Routing Rules:**
1. Human messages always pass through and reset the loop guard
2. Human messages with no `@mentions` default to `@all`
3. `/continue` resets the loop guard and resumes
4. Agent messages increment the hop counter
5. Agent messages require explicit `@mentions` to trigger others (prevents loops)
6. Loop guard trips at 6 hops (configurable per meeting)
7. Sender is always excluded from targets

### `lib/meeting-chat-service.ts` — Shared Timeline Storage

- `postChatMessage(params)` — Append a message to the JSONL log
- `getChatMessages(params)` — Read messages with optional `since` cursor and `limit`
- `deleteChatLog(meetingId)` — Remove a meeting's chat log

Storage: `~/.aimaestro/teams/meetings/{meetingId}/chat.jsonl` (one JSON object per line)

### `app/api/meetings/[id]/chat/route.ts` — Chat API

- `POST` — Post a message, broadcast via WS, trigger agents via router
- `GET` — Read chat history with `?since=<ISO>&limit=<N>`

Handles cross-host proxying: if the meeting isn't found locally, proxies to the meeting host via `hostId` lookup.

### `app/api/agents/notify/route.ts` — Injection Endpoint

Two modes:
- **Notification mode:** `{ agentName, fromName, subject }` → tmux display notification
- **Injection mode:** `{ agentName, injection }` → literal text + 500ms delay + Enter into tmux session

### `hooks/useMeetingMessages.ts` — Frontend Hook

- Connects WebSocket to `/meeting-chat?meetingId=X` for real-time updates
- Falls back to REST polling (5s) if WebSocket disconnects
- Posts to `/api/meetings/{id}/chat` instead of AMP `/api/messages`
- Optimistic message rendering with deduplication

### `components/team-meeting/MeetingChatPanel.tsx` — Chat UI

- `@mention` autocomplete dropdown (type `@` to see agents + `@all`)
- Arrow keys / Tab / Enter to navigate and select mentions
- `/continue` command handling (resets loop guard)
- Loop guard status banner with `/continue` button
- Presence status dots on agent buttons (green/yellow/blue/gray)
- System message styling (centered italic for join/leave events)

---

## CLI Tools

### `scripts/meeting-send.sh`

Post a message to a meeting's shared timeline from the command line.

```bash
meeting-send.sh <meetingId> "message text" \
  --from <agentId> \
  --alias <displayName> \
  --host <meetingHostUrl>
```

Example:
```bash
meeting-send.sh 7f198b5e "Hello team" \
  --from "e2f485d2-c048-4844-96a7-beada05cdace" \
  --alias "KAI" \
  --host http://100.83.160.34:23000
```

### `scripts/meeting-read.sh`

Read recent messages from a meeting's shared timeline.

```bash
meeting-read.sh <meetingId> [--host <meetingHostUrl>] [--limit <N>]
```

---

## Injection Prompt Format

When an agent is triggered, they receive a prompt like:

```
[Meeting: Team Name]

Recent conversation:
  👤 Shane: What's the status on the deployment?
  🤖 CelestIA: Build is clean, ready to deploy.
  🤖 Watson: Tests pass on all three hosts.

Shane says: Let's deploy now.

Reply by running: meeting-send.sh <meetingId> "YOUR_REPLY" --from "<agentId>" --alias "<name>" --host <meetingHostUrl>
```

- Includes last 8 messages as conversation context (capped at 2000 chars)
- Human messages marked with 👤, agent messages with 🤖
- Reply command uses `meeting-send.sh` CLI

---

## Meeting Lifecycle

1. **Create:** Human starts a meeting from the Teams UI, selects agents
2. **Active:** Messages flow through the shared timeline, agents get injected
3. **End:** Human ends the meeting, status changes to `ended`, injections stop
4. **Cleanup:** Chat logs auto-pruned after 7 days

Meeting records stored at: `~/.aimaestro/teams/meetings.json`

---

## Configuration

### Loop Guard

Default: 6 hops before pausing. Configurable per meeting via the `loopGuardConfig` field:

```json
{
  "loopGuardConfig": {
    "maxHops": 8,
    "enabled": true
  }
}
```

### Operator Identity

The human operator's identity is stored on the meeting record:

```json
{
  "operatorId": "shanewickson",
  "operatorName": "Shanewickson"
}
```

Defaults to `os.userInfo().username` if not specified.

---

## Known Limitations

1. **Injection requires idle prompt:** Agents must be at an idle CLI prompt to receive injections. If an agent is mid-response, the injection stacks and processes when the agent returns to the prompt.

2. **No injection queuing:** Multiple rapid messages can pile up on a busy agent. Future improvement: queue injections and only deliver when the agent is idle (using presence status).

3. **500ms Enter delay:** Long injection text requires a 500ms pause between the literal text and Enter key. This adds latency but prevents [Pasted text] stacking.

4. **Remote agent resolution:** Remote agents aren't in the local agent registry. The chat route fetches the sessions API to resolve remote agent names and host URLs. This adds a network round trip per injection cycle.

5. **Single meeting host:** The shared JSONL log lives on the meeting host only. No replication across hosts. If the meeting host goes down, the chat log is unavailable until it comes back.

---

## Related Documents

- `docs/proposals/001_meetings_gaps_and_proposal.md` — Original proposal and gap analysis
- `docs/meeting-chat-gap-analysis.md` — Technical comparison with agentchattr
- `docs/meeting-chat-implementation-prompt.md` — Phase 1-2 implementation task
