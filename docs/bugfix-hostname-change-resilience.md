# Bugfix: Hostname-Change Resilience (Dock vs WiFi)

**Date:** 2026-03-22
**Status:** Fixed and deployed

## Problem

A MacBook that connects via Thunderbolt dock reports hostname `milo-dock.internal`, but on WiFi reports `shanes-m3-pro-mbp`. The codebase treated these as two separate machines, causing a cascade of failures across the agent registry, AMP messaging, and API key management.

The issue was first noticed when the AI Maestro UI showed duplicate "hosts" entries in the hosts section, which led to an initial small fix to `isSelf()` in a prior session. This session uncovered the full extent of the damage.

## Root Cause

`os.hostname()` returns different values depending on which network interface is active. The codebase used hostname as the primary machine identity throughout, but lacked resilience to hostname changes on the same physical machine.

Three layers of the hostname-matching infrastructure were broken:

### Layer 1: Agent lookup used string comparison instead of `isSelf()`

**Files:** `lib/agent-registry.ts`

`getAgentByName()` and `getAgentByAlias()` compared `agent.hostId` directly against `getSelfHostId()` using string equality. When the hostname changed, agents registered under the old hostname were invisible to lookups under the new hostname.

```typescript
// BEFORE: string comparison fails across hostname changes
const selfHostId = getSelfHostId().toLowerCase()
return agents.find(a =>
  a.name?.toLowerCase() === normalizedName &&
  a.hostId?.toLowerCase() === selfHostId
) || null
```

This meant `createAgent()` would not find the existing agent during its uniqueness check, and would create a duplicate.

### Layer 2: `isSelf()` only searched cached hosts by ID, not aliases

**Files:** `lib/hosts-config-server.mjs`, `lib/hosts-config.ts`

Even after switching agent lookup to use `isSelf()`, it still returned `false` for old hostnames. The cached hosts fallback searched by `host.id` only:

```javascript
// BEFORE: only matches by host ID, misses alias matches
const matchedHost = cachedHosts.find(h => h.id.toLowerCase() === hostIdLower)
```

When asked "is `milo-dock.internal` this machine?", it looked for a host with `id === "milo-dock.internal"`. But after hostname migration, the host's ID had been updated to `shanes-m3-pro-mbp`, with `milo-dock.internal` only present in the aliases array -- which was never searched.

### Layer 3: Hostname migration discarded old aliases

**Files:** `lib/hosts-config-server.mjs`, `lib/hosts-config.ts`

The `validateHosts()` function detected hostname changes and auto-migrated the host ID. But it replaced the aliases array with only current aliases, losing the old hostname entirely:

```javascript
// BEFORE: replaces aliases, discarding old hostname
validHosts[selfIdx] = {
  ...selfHost,
  id: newId,
  aliases: getSelfAliases(),  // only current IPs/hostname
}
```

After migration, `milo-dock.internal` was gone from both the ID field and the aliases array, making it unrecoverable.

## Cascading Failures

The hostname mismatch propagated through every system that depends on agent identity:

### 1. Duplicate agents in the registry

When the MacBook was on WiFi (`shanes-m3-pro-mbp`), any operation that called `getAgentByName()` or `createAgent()` failed to find agents registered under `milo-dock.internal`. This created duplicates:

| Original | Duplicate | Trigger |
|----------|-----------|---------|
| dev-ziggy-orchestrator (Maestro) | dev-ziggy-orchestrator (Nikolai) | Auto-registration from tmux session |
| dev-ziggy-se (Ziggy-SE) | dev-ziggy-se (Natalia) | Auto-registration from tmux session |
| dev-ziggy-se (Ziggy-SE) | dev-ziggy-se (Gaius) | Manual curl re-registration |

### 2. AMP public key overwrites

Each duplicate agent registered with the AMP server using a new keypair. The server stored the new public key, overwriting the original. When the original agent (with its original private key) tried to send messages, signature verification failed:

```
[AMP Route] Invalid signature from dev-ziggy-orchestrator@n4x-corp.aimaestro.local
```

### 3. Orphaned API keys causing 500 errors

API keys were tied to the duplicate agent's UUID. After cleanup deleted the duplicates from the registry, the API keys still referenced non-existent agent IDs. When an agent sent a message, the auth middleware resolved the key to a deleted UUID, and `getAgent()` returned null:

```
{ error: 'internal_error', message: 'Sender agent not found in registry' }  // HTTP 500
```

### 4. Stale `AMP_DIR` environment variables

When duplicate agents were created, `amp-init --auto` set `AMP_DIR` to the duplicate's UUID directory. After cleanup, the env var persisted in the tmux session, pointing to a directory with no inbox, no keys, and no config. The agent could not see incoming messages or send outgoing ones.

### 5. API key accumulation

The AMP registration endpoint issued a new API key on every re-registration without revoking old ones. Combined with repeated auto-registrations from hostname-triggered duplicates, agents accumulated many active keys (up to 10 for dev-ziggy-orchestrator). While not a functional failure, this cluttered the key store and created confusion during debugging.

### 6. `.index.json` overwrites

The registration endpoint called `initAgentAMPHome()` with the server-side agent UUID. When a duplicate was created, this wrote the wrong UUID to `.index.json`, breaking inbox resolution for `amp-inbox.sh` and other CLI tools.

## Fixes Applied

### Fix 1: Agent lookup uses `isSelf()` for host matching

**File:** `lib/agent-registry.ts`

`getAgentByName()` and `getAgentByAlias()` now use `isSelf(a.hostId)` instead of string comparison when searching for local agents. If a specific `hostId` is passed and it refers to this machine, `isSelf()` is used for matching; otherwise, exact string comparison is used for genuinely remote hosts.

```typescript
// AFTER: robust matching via isSelf()
if (hostId) {
  if (isSelf(hostId)) {
    return agents.find(a =>
      !a.deletedAt &&
      a.name?.toLowerCase() === normalizedName &&
      a.hostId != null && isSelf(a.hostId)
    ) || null
  }
  // Remote host: exact string match
  return agents.find(a => ... && a.hostId?.toLowerCase() === hostId.toLowerCase()) || null
}
// Default: search self host
return agents.find(a =>
  !a.deletedAt &&
  a.name?.toLowerCase() === normalizedName &&
  a.hostId != null && isSelf(a.hostId)
) || null
```

### Fix 2: `isSelf()` searches host aliases

**Files:** `lib/hosts-config-server.mjs`, `lib/hosts-config.ts`

The cached hosts fallback now searches both `host.id` and `host.aliases` when looking up a hostId:

```javascript
// AFTER: find by ID or alias
const matchedHost = cachedHosts.find(h =>
  h.id.toLowerCase() === hostIdLower ||
  (h.aliases || []).some(a => a.toLowerCase() === hostIdLower)
)
```

### Fix 3: Hostname migration preserves old hostname as alias

**Files:** `lib/hosts-config-server.mjs`, `lib/hosts-config.ts`

When a hostname change is detected, old aliases and the old hostname are merged with current aliases instead of being replaced:

```javascript
// AFTER: merge old + new aliases
const mergedAliases = Array.from(new Set([
  ...getSelfAliases(),
  ...(selfHost.aliases || []),
  oldId,
]))
```

### Fix 4: `amp-helper.sh` cross-checks `AMP_DIR` against `.index.json`

**File:** `~/.local/bin/amp-helper.sh`

After resolving `AMP_DIR` (whether from env var, `CLAUDE_AGENT_ID`, or name lookup), the script now validates it against the canonical `.index.json` mapping. If they disagree, it warns and corrects:

```bash
if [ -n "$_amp_indexed_uuid" ] && [ "$_amp_indexed_uuid" != "$_amp_current_uuid" ]; then
    echo "  Warning: AMP_DIR points to ${_amp_current_uuid} but .index.json says ${_amp_check_name} -> ${_amp_indexed_uuid}" >&2
    echo "  Correcting AMP_DIR to use indexed UUID." >&2
    AMP_DIR="${AMP_AGENTS_BASE}/${_amp_indexed_uuid}"
fi
```

### Fix 5: Re-registration revokes old API keys

**File:** `services/amp-service.ts`

Both the "re-registering same fingerprint" and "adopting existing agent" paths now call `revokeAllKeysForAgent()` before issuing a new key:

```typescript
revokeAllKeysForAgent(agent.id)
console.log(`[AMP Register] Re-registering agent '${normalizedName}' (same key fingerprint, revoked old keys, issuing new)`)
```

## Manual Cleanup Performed

In addition to the code fixes, the following manual cleanup was required to restore the system:

1. **Deleted duplicate agents** from `~/.aimaestro/agents/registry.json` (Natalia, Nikolai, Gaius)
2. **Merged inbox messages** from duplicate agent directories into originals
3. **Fixed `.index.json`** to point to correct local UUIDs (3 times -- the registration endpoint kept overwriting it)
4. **Re-registered agents** with correct public keys after duplicates had overwritten them
5. **Fixed API key records** in `~/.aimaestro/amp-api-keys.json` to point to correct agent UUIDs
6. **Revoked 23 stale API keys**, leaving 1 active key per agent
7. **Added `milo-dock.internal` to host aliases** in `~/.aimaestro/hosts.json` (since the migration had already run and wouldn't re-trigger)
8. **Updated `dev-ziggy-se` AMP config** after rename from `ziggy` (config.json, registration file, registry metadata)

## Lessons Learned

1. **Machine identity should not depend on `os.hostname()` alone.** Tailscale IP or a persistent machine UUID would be more reliable.
2. **Every hostname comparison should go through `isSelf()`** -- never use direct string comparison against `getSelfHostId()`.
3. **Alias preservation is critical during migration.** Replacing aliases loses history; merging preserves it.
4. **API key lifecycle needs revocation on re-issue.** Without it, keys accumulate silently.
5. **The `.index.json` name-to-UUID mapping is fragile.** Multiple code paths write to it, and the server registration endpoint can overwrite it with the wrong UUID. This file should be treated as authoritative for local directory resolution and protected from server-side overwrites.
