# Memory Retrieval + User Directory — Implementation Roadmap

Combined implementation plan for two interdependent features: automatic memory retrieval (injecting long-term memories into agent context) and the user directory (centralized contact/identity resolution for gateway routing).

**Design specs:** [MEMORY-RETRIEVAL.md](./MEMORY-RETRIEVAL.md), [USER-DIRECTORY.md](./USER-DIRECTORY.md)

---

## Team Assignments

| Phase | Owner(s) | Focus |
|---|---|---|
| **Phase 1** — Data Layer | CelestIA (dev-aimaestro-bananajr) | Types, registries, REST APIs, tests |
| **Phase 2** — Gateway Integration | Watson (dev-aimaestro-holmes) + DataIA (dev-aimaestrogw-holmes) | Gateway enrichment, resolve calls, memory middleware |
| **Phase 3** — Outbound Routing + Retrieval | Watson + DataIA | DM routing, memory injection, caching |
| **Phase 4** — Dashboard UI | Kai (dev-aimaestro-admin) | User management page, memory retrieval visibility |

**Dependency chain:** Phase 2 depends on Phase 1 APIs. Phase 3 depends on Phase 2 gateway enrichment. Phase 4 can start in parallel with Phase 3 (only needs Phase 1 APIs).

---

## Phase 1 — Data Layer (CelestIA)

Build the foundational types, file-based registries, and REST APIs for both features. No gateway or frontend work — just the core data layer and tests.

### 1A. User Directory Data Layer

**Files to create:**
- `types/user.ts` — TypeScript types for UserRecord, UserPlatformMapping, UserDirectoryFile
- `lib/user-directory.ts` — File-based registry with CRUD + lookups (mirrors `lib/team-registry.ts` pattern)
- `app/api/users/route.ts` — GET (list) + POST (create)
- `app/api/users/[id]/route.ts` — GET, PATCH, DELETE
- `app/api/users/resolve/route.ts` — GET with query params (?alias=, ?platform=&platformUserId=, ?displayName=)

**Types (types/user.ts):**
```typescript
interface UserPlatformMapping {
  type: string                    // 'discord' | 'slack' | 'email' | etc.
  platformUserId: string          // Platform-native user ID
  handle: string                  // Platform display name
  context: Record<string, any>    // Platform-specific metadata (guildIds, workspaceId, etc.)
}

interface UserRecord {
  id: string                      // UUID
  displayName: string
  aliases: string[]               // Cross-platform nicknames, lowercased for matching
  platforms: UserPlatformMapping[]
  role: 'operator' | 'external'
  trustLevel: 'full' | 'none'
  preferredPlatform?: string
  notificationPreferences?: {
    urgent?: string[]
    normal?: string[]
    digest?: string[]
  }
  createdAt: string               // ISO
  updatedAt: string               // ISO
  lastSeenPerPlatform?: Record<string, string>  // platform type → ISO timestamp
}

interface UserDirectoryFile {
  version: 1
  users: UserRecord[]
}
```

**Registry (lib/user-directory.ts):**
- Storage: `~/.aimaestro/users/directory.json`
- Functions: `loadUsers()`, `saveUsers()`, `createUser()`, `getUser(id)`, `updateUser(id, updates)`, `deleteUser(id)`
- Lookups: `getUserByAlias(alias)`, `getUserByPlatform(type, platformUserId)`, `getUserByDisplayName(name)`, `getUsersByRole(role)`
- All alias/name lookups case-insensitive

**Seed data:** Create Shane's operator record on first load if directory is empty:
- displayName: "Shane Wickson"
- aliases: ["gosub", "shane", "shanewickson", "swick"]
- platforms: [discord entry with his user ID from current OPERATOR_DISCORD_IDS env var]
- role: "operator", trustLevel: "full"

**Tasks:**
- [ ] Create `types/user.ts` with all type definitions
- [ ] Create `lib/user-directory.ts` — file-based CRUD + lookup functions
- [ ] Create REST API routes (list, create, get, update, delete, resolve)
- [ ] Create `services/users-service.ts` — pure business logic layer (mirrors teams-service.ts pattern)
- [ ] Seed Shane's operator record on first load
- [ ] Write unit tests: `tests/user-directory.test.ts` (CRUD, all lookup modes, alias case-insensitivity, duplicate alias handling)
- [ ] Write API tests: `tests/services/users-service.test.ts` (resolve endpoint edge cases: unknown user 404, multi-platform match, etc.)

### 1B. Memory Retrieval Data Layer

**Files to create:**
- `lib/memory/retrieval-middleware.ts` — Middleware skeleton with trigger detection (implemented but not wired)
- `lib/memory/entity-extractor.ts` — Extract search terms from messages

**Retrieval middleware (lib/memory/retrieval-middleware.ts):**
```typescript
interface RetrievalContext {
  agentId: string
  messageText: string
  senderId?: string
  threadId?: string
  isNewConversation?: boolean
  topicHints?: string[]
}

interface RetrievedMemory {
  memoryId: string
  category: string           // 'fact' | 'pattern' | 'insight' | etc.
  content: string
  confidence: number
  reinforcementCount: number
  score: number              // Composite retrieval score
}

interface RetrievalResult {
  triggered: boolean         // Whether search was triggered
  memories: RetrievedMemory[]
  cacheHit: boolean
  searchDurationMs?: number
}

// Main entry point — called by AMP message handler
async function retrieveMemories(ctx: RetrievalContext): Promise<RetrievalResult>

// Trigger heuristic — should we search?
function shouldTriggerSearch(ctx: RetrievalContext, lastTrigger?: TriggerState): boolean

// Format memories into injection block
function formatMemoryContext(memories: RetrievedMemory[]): string
```

**Entity extractor (lib/memory/entity-extractor.ts):**
- Extract keywords/noun phrases from message text (simple regex + stop-word removal, not a full NLP pipeline)
- Match against known names from agent registry and user directory
- Return combined search query for embedding

**Tasks:**
- [ ] Create `lib/memory/retrieval-middleware.ts` — trigger heuristic, search orchestration, result formatting
- [ ] Create `lib/memory/entity-extractor.ts` — keyword extraction, named entity matching
- [ ] Implement `shouldTriggerSearch()` — new conversation always triggers, topic shift detection (keyword overlap < 30%)
- [ ] Implement `formatMemoryContext()` — generates `<memory-context>` block per the spec
- [ ] Wire up `searchMemoriesByEmbedding` (already exists in cozo-schema-memory) with extracted query
- [ ] Composite ranking: similarity score + reinforcement count + recency
- [ ] Cap results at top 3 (configurable)
- [ ] Write unit tests: `tests/memory/retrieval-middleware.test.ts` (trigger heuristic, ranking, formatting)
- [ ] Write unit tests: `tests/memory/entity-extractor.test.ts` (keyword extraction, entity matching)

### Phase 1 Deliverables
- All types, registries, APIs, and tests committed and passing
- User directory seeded with Shane's record
- Memory retrieval middleware skeleton functional but not wired into AMP handler
- Version bump + push to main

---

## Phase 2 — Gateway Integration (Watson + DataIA)

Wire the user directory into gateways for identity resolution, and begin enriching AMP messages with context needed by memory retrieval.

### 2A. Gateway → User Directory Integration (DataIA leads, Watson supports)

**Watson's tasks (Maestro side):**
- [ ] Add `/api/users/resolve` to headless router (`services/headless-router.ts`) so gateways can hit it in headless mode
- [ ] Add `POST /api/users/auto-create` endpoint — gateways call this for unknown senders (creates external user with trustLevel='none')
- [ ] Ensure resolve endpoint returns 404 (not 500) for unknown users, with structured error `{ "error": "user_not_found" }`
- [ ] Add `updateLastSeen(userId, platform)` to user-directory.ts — gateways call this on every inbound
- [ ] Integration test: gateway sends inbound message → resolve → auto-create if unknown → updateLastSeen

**DataIA's tasks (Gateway side):**
- [ ] Add user-resolver module to gateway: cache resolved users locally (pattern from existing agent-resolver)
- [ ] On inbound message: resolve sender via `/api/users/resolve?platform=discord&platformUserId=...`
- [ ] If 404: call `/api/users/auto-create` with platform info, then cache result
- [ ] Replace `OPERATOR_DISCORD_IDS` env var checks with user directory trust lookups (`role === 'operator'` or `trustLevel === 'full'`)
- [ ] Include resolved user info in AMP message envelope: `context.sender.userId`, `context.sender.displayName`, `context.sender.trustLevel`
- [ ] Test: known operator sends DM → resolves correctly, trust check passes
- [ ] Test: unknown user sends DM → auto-created as external, trust check blocks appropriately

### 2B. AMP Envelope Enrichment for Memory Retrieval (DataIA leads)

**DataIA's tasks:**
- [ ] Add `context.thread` to AMP message envelope: `threadId`, `inReplyTo`, `isNewConversation`
- [ ] Add `context.sender` to AMP envelope: `platformUserId`, `platform`, `handle` (from resolved user)
- [ ] Add `context.topicHints` (optional): extract 2-3 keywords from message for retrieval hint
- [ ] Document the enriched envelope format in gateway README

**Watson's tasks:**
- [ ] Update AMP message types in Maestro to accept new `context` fields (additive, backward compatible)
- [ ] Validate that existing AMP handlers don't break with new fields (regression test)

### Phase 2 Deliverables
- Gateways resolve sender identity via user directory on every inbound message
- Unknown senders auto-created as external users
- OPERATOR_*_IDS env vars retired (or deprecated with fallback)
- AMP envelope carries sender identity, thread context, and topic hints
- All existing tests still pass + new integration tests

---

## Phase 3 — Outbound Routing + Memory Injection (Watson + DataIA)

### 3A. Memory Retrieval Pipeline (Watson leads)

**Watson's tasks:**
- [ ] Wire `retrieveMemories()` into AMP message handler — call before agent processes message
- [ ] Use enriched AMP envelope fields (sender, thread, topicHints) as retrieval context
- [ ] Implement in-memory cache: key = `{agentId}:{threadId}:{keywordsHash}`, TTL = 5 minutes
- [ ] Cache invalidation on consolidation run (listen for consolidation-complete event)
- [ ] Inject `<memory-context>` block into agent's system context (append to prompt, not inline)
- [ ] Add logging: `[MemoryRetrieval] Agent {id}: searched ({durationMs}ms), found {n} memories`
- [ ] Integration test: send AMP message to agent → memories retrieved → context block injected
- [ ] Integration test: same topic follow-up → cache hit, no re-search
- [ ] Integration test: topic shift → cache miss, new search triggered

### 3B. Outbound DM Routing (Watson + DataIA)

**Watson's tasks (Maestro side):**
- [ ] Add `POST /api/users/:id/notify` endpoint — route outbound notification to user's preferred platform
- [ ] Resolution chain: preferred platform → any available platform → queue for next seen
- [ ] Use user directory to get platform mapping, then POST to appropriate gateway
- [ ] Add to AMP @mention resolution: check user directory aliases in addition to agent names
- [ ] Integration test: agent sends AMP to @gosub → resolves to Shane → routes to Discord via DataIA gateway

**DataIA's tasks (Gateway side):**
- [ ] Add `POST /api/gateway/dm` endpoint — accepts `{ platformUserId, message }` and sends DM
- [ ] Validate that the gateway has the capability to DM the target user (e.g., mutual guild membership for Discord)
- [ ] Return structured response: `{ success, messageId }` or `{ error, reason }` (e.g., "no mutual guild")
- [ ] Test: Maestro calls gateway DM endpoint → DM delivered to user

### Phase 3 Deliverables
- Agents automatically receive relevant memories in context when processing messages
- Outbound DMs route through user directory → gateway pipeline
- Caching prevents redundant memory searches within conversations
- @mention resolution includes user aliases (not just agent names)

---

## Phase 4 — Dashboard UI (Kai)

Build the user management UI and memory retrieval visibility in the Maestro dashboard.

**Can start in parallel with Phase 3** — only depends on Phase 1 APIs.

### 4A. User Management Page

**Tasks:**
- [ ] Create `app/users/page.tsx` — list all users with role badges (operator/external)
- [ ] Create `app/users/[id]/page.tsx` — user detail view with platform mappings
- [ ] Add/edit user form: display name, aliases, platform mappings, role, preferred platform
- [ ] Delete user with confirmation dialog
- [ ] Platform mapping management: add/remove platforms per user
- [ ] Search/filter: by name, alias, role, platform
- [ ] Add "Users" link to sidebar navigation

### 4B. Memory Retrieval Visibility (stretch goal)

**Tasks:**
- [ ] Add memory retrieval stats to agent detail page: last retrieval, cache hit rate, avg memories returned
- [ ] Add `/api/agents/:id/memory/retrieval-stats` endpoint (Watson provides the data layer)
- [ ] Optional: show recent retrievals log — what memories were surfaced for which messages

### Phase 4 Deliverables
- User management accessible from dashboard
- Operators can manage user records, platform mappings, and trust levels through the UI
- Memory retrieval activity visible on agent detail pages

---

## Timeline Dependencies

```
Phase 1 (CelestIA)          Phase 2 (Watson + DataIA)       Phase 3 (Watson + DataIA)      Phase 4 (Kai)
─────────────────── ──────>  ───────────────────────── ───>  ─────────────────────────      ──────────────
User Directory types         Gateway resolve calls           Outbound DM routing            User mgmt UI
User Directory APIs          Auto-create external users      @mention user resolution       (starts after
Memory middleware skeleton   AMP envelope enrichment         Memory injection pipeline        Phase 1)
Entity extractor             Replace OPERATOR_*_IDS          Caching + invalidation
Tests                        Tests                           Tests
```

---

## Coordination Notes

- **Watson + DataIA** share the Holmes host — the gateway (`aimaestro-gateways`) and Maestro core both run here. Watson handles Maestro-side changes, DataIA handles gateway-side changes. Coordinate via AMP messages or meeting chat.
- **CelestIA** works on Bananajr — Phase 1 is pure Maestro core code, no gateway dependency. Commit and push when done; Watson pulls and starts Phase 2.
- **Kai** works on Milo — Phase 4 can start as soon as Phase 1 APIs are available. No gateway dependency.
- **Version bumps:** Each phase gets its own version bump on completion. Don't batch across phases.

---

## Open Questions (from design specs)

- Should agents provide feedback on memory relevance (thumbs up/down)?
- Per-agent retrieval preferences (more/fewer memories)?
- Pinned high-confidence memories as "always on" context?
- Group/team aliases in user directory? (deferred for now)

These are deferred to post-v1 tuning. Don't block implementation on them.
