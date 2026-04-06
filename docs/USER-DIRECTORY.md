# User Directory — Design Document

A centralized contact directory for identity resolution and outbound message routing across AI Maestro gateways.

## Problem

Discord (and other platform gateways) can't initiate DMs without knowing the user's platform-specific ID. Currently operator IDs are scattered across `OPERATOR_*_IDS` environment variables in each gateway instance, which doesn't scale and can't support cross-platform routing.

## Design Principles

- **Centralized at the Maestro level** — not per-gateway
- **File-based registry** — mirrors the agent registry pattern (`~/.aimaestro/users/`)
- **Not multi-user auth** — Maestro stays single-operator with no login
- **Contact directory** — for routing and identity resolution, not access control

---

## Data Model

### User Record

```jsonc
{
  // Core identity
  "id": "uuid-v4",                          // Stable internal identifier
  "displayName": "Shane Wickson",           // Human-readable name
  "aliases": ["gosub", "shane", "swick"],   // Cross-host nicknames, case-insensitive match

  // Platform mappings — one entry per platform account
  "platforms": [
    {
      "type": "discord",                    // Gateway type identifier
      "platformUserId": "123456789012345",  // Platform-native user ID
      "handle": "gosub",                    // Platform display name / username
      "context": {                          // Platform-specific metadata
        "guildIds": ["987654321098765"]      // Discord: which guilds this mapping applies to
      }
    },
    {
      "type": "slack",
      "platformUserId": "U0ABC123DEF",
      "handle": "shane.wickson",
      "context": {
        "workspaceId": "T0ABC123"
      }
    },
    {
      "type": "email",
      "platformUserId": "shane@example.com",
      "handle": "shane@example.com",
      "context": {}
    }
  ],

  // Trust and role
  "role": "operator",                       // "operator" | "external"
  "trustLevel": "full",                     // Future: granular trust tiers

  // Routing preferences
  "preferredPlatform": "discord",           // Default outbound channel
  "notificationPreferences": {
    "urgent": ["discord", "email"],         // Escalation chain by priority
    "normal": ["discord"],
    "digest": ["email"]
  },

  // Timestamps
  "createdAt": "2026-04-06T00:00:00Z",
  "updatedAt": "2026-04-06T00:00:00Z",
  "lastSeenPerPlatform": {
    "discord": "2026-04-06T12:00:00Z",
    "slack": "2026-04-05T18:30:00Z"
  }
}
```

### Storage

```
~/.aimaestro/users/
  directory.json          # Array of user records (single-file for Phase 1)
```

Single-file JSON keeps reads atomic and diffs reviewable. Splits to per-user files only if the directory grows beyond ~100 records.

### Indexes / Lookups

The in-memory directory supports these lookup patterns:

| Lookup | Use case |
|---|---|
| `byId(uuid)` | Canonical reference |
| `byAlias(string)` | AMP message `@mention` resolution |
| `byPlatform(type, platformUserId)` | Inbound message → internal user |
| `byRole(role)` | List all operators, list all externals |

---

## API Endpoints

All under `/api/users/`.

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/users` | List all users (with optional `?role=` filter) |
| `GET` | `/api/users/:id` | Get user by ID |
| `POST` | `/api/users` | Create user |
| `PATCH` | `/api/users/:id` | Update user fields |
| `DELETE` | `/api/users/:id` | Remove user |
| `GET` | `/api/users/resolve?alias=gosub` | Resolve alias/handle to user |
| `GET` | `/api/users/resolve?platform=discord&platformUserId=123` | Resolve platform ID to user |

---

## Phased Roadmap

### Phase 1 — Data Layer

- Define TypeScript types for the user record schema
- Implement file-based registry (`lib/user-directory.ts`) with CRUD + lookup methods
- Add REST API endpoints (`app/api/users/`)
- Seed with Shane's record (operator, Discord + any other active platforms)
- Unit tests for CRUD and resolution logic

### Phase 2 — Gateway Integration

- Gateways call `/api/users/resolve` on inbound messages to map platform IDs to internal users
- Replace `OPERATOR_*_IDS` env vars with directory lookups in Watson (Discord) and DataIA (Slack/gateway)
- Watson and DataIA coordinate on the trust-check migration since Watson has context on the current content-security trust model

### Phase 3 — Outbound DM Routing

- When an agent needs to DM a user: resolve user → check preferred platform → get platform ID → route to correct gateway
- AMP messages with `@mention` resolve through the alias index
- Fallback chain: preferred platform → any available platform → queue for next seen

### Phase 4 — Dashboard UI

- User management page in Maestro dashboard (can be API-only for v1)
- View/edit users, platform mappings, notification preferences
- Activity: last seen per platform

---

## Migration Path

To retire `OPERATOR_*_IDS` env vars:

1. Seed directory with current operator records
2. Gateways check directory first, fall back to env vars
3. Once validated, remove env var fallback
4. Delete `OPERATOR_*_IDS` from gateway configs

---

## Open Questions

- Should external users (non-operators) be auto-created on first inbound message, or require explicit registration?
- Notification preference schema — keep it simple now or design for future webhook/push channels?
- Do we need a "group" concept (e.g., a team alias that routes to multiple users)?
