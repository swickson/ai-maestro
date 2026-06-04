# Team Mesh Sync — Implementation Plan

Sync team definitions across all mesh nodes so teams are visible and manageable from any host.

## Problem

Teams are stored per-node in `~/.aimaestro/teams/teams.json` with no mesh awareness. A team created on Milo that references agents on Bananajr and Holmes only exists on Milo — the other nodes can't see or manage it. This breaks the expectation that teams (which already reference cross-node agents) should be accessible from any node.

## Current State

- **Agent sync exists:** `lib/agent-directory.ts` polls peers every 60 seconds via `GET /api/agents/directory`, merging remote agents into a local directory with `source: 'local' | 'remote'` tracking.
- **Host sync exists:** `lib/host-sync.ts` handles peer discovery via bidirectional push exchange.
- **Team sync does not exist:** `lib/team-registry.ts` reads/writes only local `teams.json`.

## Approach: Piggyback on Agent Directory Sync Pattern

Mirror the agent directory sync model — periodic polling, eventually consistent, source tracking.

---

## Data Model Changes

### Team Type (types/team.ts)

Add mesh-awareness fields:

```typescript
interface Team {
  // Existing fields...
  id: string
  name: string
  agentIds: string[]
  // ...

  // New mesh fields
  hostId: string          // Host that owns/created this team
  updatedAt: number       // Timestamp for conflict resolution (last-write-wins)
  source?: 'local' | 'remote'  // Runtime only, not persisted — set during sync
}
```

- `hostId` — the node that created the team. Only the owner node can modify it.
- `updatedAt` — used for conflict resolution. If two nodes have the same team ID, the one with the later `updatedAt` wins.
- `source` — runtime field (not written to disk), marks whether this team came from local or a peer.

### teams.json Format

```jsonc
{
  "version": 2,       // Bump from 1 to signal mesh-aware format
  "teams": [
    {
      "id": "uuid",
      "name": "Iron Alliance",
      "hostId": "milo.aimaestro.local",
      "updatedAt": 1712419200000,
      // ... other fields
    }
  ]
}
```

---

## Sync Mechanism

### New File: `lib/team-directory.ts`

Mirrors `lib/agent-directory.ts` structure:

```
┌─────────────┐     GET /api/teams/directory      ┌─────────────┐
│   Host A     │ ──────────────────────────────>   │   Host B     │
│              │ <──────────────────────────────    │              │
│ teams.json   │    B's local teams (source=local) │ teams.json   │
│ + merged     │                                   │ + merged     │
│   remote     │                                   │   remote     │
└─────────────┘                                    └─────────────┘
```

**Sync loop (runs every 60 seconds, alongside agent directory sync):**

1. Query each known peer: `GET /api/teams/directory`
2. Peer responds with its **local** teams only (teams where `hostId` matches its own host)
3. For each remote team received:
   - If team ID doesn't exist locally → add with `source: 'remote'`
   - If team ID exists locally with `source: 'remote'` and remote `updatedAt` is newer → update
   - If team ID exists locally with `source: 'local'` → skip (local owner wins)
4. **Stale handling (host-health-aware):** If a host stops reporting, don't immediately remove its teams. Instead, track `lastSeenAt` per host. Remote teams from an unreachable host remain visible but flagged as `hostOffline: true`. Only remove remote teams if the host has been unreachable for 24+ hours AND the operator hasn't manually intervened. This handles VM restarts, hardware shuffling, and temporary network issues gracefully.

### New API Endpoint

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/teams/directory` | Return local teams for peer sync (filtered to `source: 'local'` only) |

### Modified Files

| File | Change |
|---|---|
| `types/team.ts` | Add `hostId`, `updatedAt`, `source` fields |
| `lib/team-registry.ts` | Set `hostId` on create, update `updatedAt` on every write |
| `lib/team-directory.ts` | **New file** — sync logic, mirrors agent-directory.ts |
| `services/teams-service.ts` | Return merged local + remote teams from service layer |
| `app/api/teams/directory/route.ts` | **New route** — serve local teams to peers |
| `app/api/teams/route.ts` | Modify list endpoint to include remote teams |

---

## Ownership Rules

- **Create:** Team is created on the local node. `hostId` = local host identity. `source` = 'local'.
- **Update/Delete:** Only allowed on the owning node (`hostId` must match local host). Remote nodes get a 403 or redirect to the owner.
- **Read:** All nodes can read all teams (local + synced remote).
- **Agent membership:** Agents from any node can be in any team (already works — agent IDs are UUIDs, not host-scoped).

---

## Integration with Existing Sync

The team sync hooks into the existing sync infrastructure:

1. **Startup:** `startTeamDirectorySync()` called alongside `startDirectorySync()` in server initialization
2. **Interval:** Same 60-second cycle, can share the same timer or run independently
3. **Peer list:** Reuses the host list from `hosts.json` (same peers as agent sync)
4. **Health checks:** Skip peers that failed the last agent sync health check (already tracked)

---

## Migration

For existing installations with teams already in `teams.json`:

1. On first load of v2 format: if `version` is missing or 1, migrate:
   - Set `hostId` to local host identity for all existing teams
   - Set `updatedAt` to current timestamp
   - Bump version to 2
   - Write back to disk
2. This is a non-breaking migration — existing teams become "owned by this node"

---

## Implementation Steps

### Step 1 — Data model + migration
- Add `hostId`, `updatedAt` to Team type
- Update `team-registry.ts` to set these fields on create/update
- Add v1 → v2 migration on load

### Step 2 — Directory endpoint
- Add `GET /api/teams/directory` route
- Returns local teams only (filtered by hostId)

### Step 3 — Sync loop
- Create `lib/team-directory.ts` with periodic sync
- Wire into server startup alongside agent directory sync

### Step 4 — Service layer + API updates
- `teams-service.ts` returns merged local + remote teams
- List/get endpoints include remote teams
- Update/delete endpoints enforce ownership

### Step 5 — Testing
- Unit tests for sync merge logic
- Integration test: create team on node A, verify it appears on node B after sync cycle

---

## Decisions (from team review)

- **Meetings are ephemeral per-node.** No sync needed — meetings are transient by nature.
- **Manual "claim team" for orphaned teams.** If the owning host goes down permanently, an operator can manually claim the team from another node (e.g., `POST /api/teams/:id/claim`). No automatic adoption — keeps it simple and predictable.
- **Host last-seen tracking.** Track `lastSeenAt` per host in `hosts.json`. Stale remote teams stay visible (flagged as host-offline) rather than being removed on a short timer. This handles the reality of VM shuffling and hardware instability.

## Open Questions

- Should we notify other team members when a team syncs for the first time (e.g., "Team X from Milo is now visible")?
- What's the right threshold for "host gone permanently" before suggesting a claim? 24 hours? Configurable?
