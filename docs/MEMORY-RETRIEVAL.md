# Memory Retrieval — Design Specification

Automatic retrieval of relevant long-term memories and injection into agent context at message time.

## Problem

The memory pipeline stores consolidated memories in CozoDB (facts, patterns, insights) but agents have no automatic way to access them. The `memory-search` skill exists but requires manual invocation — agents don't know when they have relevant memories about a topic. Memories accumulate but go unused.

## Design Principles

- **Agent-side retrieval** — gateways enrich message context, agents (via Maestro runtime) decide relevance
- **Memories are hints, not facts** — agents must verify against current state before acting on recalled memories
- **Bounded cost** — don't search on every message; trigger selectively, cap results, cache aggressively
- **Clean separation of concerns** — gateways enrich metadata, Maestro middleware handles retrieval, agents consume context

---

## Architecture

```
Gateway (Watson/DataIA)         Maestro Runtime              Agent (Claude Code)
┌─────────────────────┐    ┌─────────────────────────┐    ┌──────────────────┐
│ Inbound message     │    │ Memory retrieval         │    │ Agent processes   │
│ + sender identity   │───>│ middleware               │───>│ message +         │
│ + platform context  │    │                          │    │ injected memories │
│ + thread metadata   │    │ 1. Check trigger rules   │    │                  │
└─────────────────────┘    │ 2. Extract entities      │    │ Memories appear  │
                           │ 3. Query CozoDB          │    │ as context block │
                           │ 4. Rank & cap results    │    │ (like CLAUDE.md) │
                           │ 5. Inject into envelope  │    └──────────────────┘
                           └─────────────────────────┘
```

### Layer Responsibilities

| Layer | Responsibility | Does NOT do |
|---|---|---|
| **Gateway** | Enrich AMP payload with sender identity, platform context, thread/reply-to chains | Query memory store, decide relevance |
| **Maestro middleware** | Trigger detection, entity extraction, memory search, result injection | Modify message content, make decisions for the agent |
| **Agent** | Consume injected memories as context, verify before acting, use memory-search skill for deeper queries | Blindly trust memory content as current truth |

---

## Trigger Heuristic (v1)

Keep it simple. Search triggers on:

| Condition | Trigger? | Rationale |
|---|---|---|
| First message in a new conversation | Yes | Fresh topic, pull relevant context |
| Topic/keyword shift mid-thread | Yes | New subject may have relevant memories |
| Sender changes mid-thread | Yes | Different person may have different memory associations |
| Follow-up in same thread, same topic | No | Already retrieved; use cache |
| System/status messages | No | No actionable content |

### Topic Shift Detection (v1)

Simple keyword overlap check between the current message and the last message that triggered a search. If fewer than 30% of extracted keywords overlap, treat it as a topic shift and re-trigger.

---

## Entity Extraction

Extract search terms from the inbound message + AMP envelope metadata:

1. **Named entities** — agent names, person names, project names (match against known aliases from user directory and agent registry)
2. **Keywords** — nouns and noun phrases from the message text (lightweight NLP, not a full pipeline)
3. **Sender context** — who sent the message (their ID, role, platform)
4. **Thread context** — if this is a reply, include the original topic

Combine into a search query: semantic embedding of the message text + keyword filters for named entities.

---

## Memory Search & Ranking

1. **Embed** the extracted query text using the existing `embedTexts()` pipeline (bge-small-en-v1.5, local CPU)
2. **HNSW vector search** against `memory_vec` index in CozoDB (already implemented in `searchMemoriesByEmbedding`)
3. **Filter** by agent ID (only return memories belonging to the receiving agent)
4. **Rank** by composite score:
   - Similarity score (from HNSW, primary)
   - Reinforcement count (memories reinforced multiple times are higher signal)
   - Recency (recently accessed memories may be more relevant)
5. **Cap** at top 3 results (configurable, start conservative)

---

## Context Injection

Inject retrieved memories into the agent's context as a clearly delineated block:

```
<memory-context>
The following memories may be relevant to this conversation.
These are recollections, not live data — verify against current state before acting.

1. [fact] Shane prefers single bundled PRs for refactors over many small ones.
   (confidence: 0.92, reinforced 4 times)

2. [pattern] Discord gateway DM routing requires mutual guild membership.
   (confidence: 0.88, reinforced 2 times)

3. [insight] CozoDB HNSW queries fail on empty indexes — always guard with count check.
   (confidence: 0.95, reinforced 3 times)
</memory-context>
```

**Injection point:** Before the agent processes the message, appended to the system context (similar to how CLAUDE.md is loaded). Not inline with the user message.

**If no relevant memories found:** Inject nothing. Don't add an empty block or "no memories found" noise.

---

## Caching

- **Cache key:** `{agentId}:{conversationThreadId}:{extractedKeywordsHash}`
- **TTL:** 5 minutes (conversations are ephemeral; memories don't change that fast)
- **Cache hit:** Skip search, re-inject cached memories
- **Invalidation:** New consolidation run for this agent clears the cache

---

## Gateway Enrichment (DataIA/Watson side)

Gateways should include the following in the AMP message envelope to support better retrieval:

```jsonc
{
  "message": "...",
  "context": {
    "sender": {
      "platformUserId": "123456789",   // For user directory resolution
      "platform": "discord",
      "handle": "gosub"
    },
    "thread": {
      "threadId": "abc-123",           // Conversation thread identifier
      "inReplyTo": "msg-456",          // Parent message ID if reply
      "isNewConversation": true        // Gateway signals if this starts a new thread
    },
    "topicHints": ["memory", "CozoDB"] // Optional: gateway-extracted keywords
  }
}
```

This is additive — gateways that don't support all fields just omit them. The middleware handles missing fields gracefully.

---

## Implementation Plan

### Phase 1 — Middleware skeleton
- Add `lib/memory/retrieval-middleware.ts`
- Hook into AMP message handler (before agent processing)
- Implement trigger heuristic (new conversation = always search)
- Wire up `searchMemoriesByEmbedding` with message text as query

### Phase 2 — Entity extraction + ranking
- Extract named entities (match against agent registry + user directory)
- Composite ranking (similarity + reinforcement + recency)
- Cap and format results into `<memory-context>` block

### Phase 3 — Caching + gateway enrichment
- Add in-memory cache with TTL
- Coordinate with Watson/DataIA on enriched AMP envelope fields
- Topic shift detection for mid-thread re-triggers

### Phase 4 — Tuning
- Adjust similarity threshold based on real-world signal-to-noise
- Tune top-K count (start at 3, may increase)
- Add metrics: how often memories are retrieved, how often agents act on them

---

## Open Questions

- Should agents be able to provide feedback on memory relevance (thumbs up/down) to improve future retrieval?
- Do we need per-agent retrieval preferences (some agents may want more/fewer memories)?
- Should high-confidence, high-reinforcement memories be "always on" for an agent (pinned context)?
