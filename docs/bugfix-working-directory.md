# Bugfix: Agent Working Directory Not Persisting from Wizard

**Date:** 2026-03-22
**Status:** Fix applied, pending verification after agent restart

## Problem

When creating an agent via the wizard UI and specifying a working directory, the agent always ended up with `/Users/shanewickson` (the home directory) instead of the user's selection. This happened regardless of what path was entered.

## Root Cause Analysis

Three bugs working together:

### Bug 1: tmux does not expand tilde paths

**File:** `services/sessions-service.ts:594` (original)

```typescript
const cwd = workingDirectory || process.cwd()
```

The `workingDirectory` string from the wizard (e.g., `~/projects/my-app`) was passed directly to:

```typescript
tmux new-session -d -s "name" -c "~/projects/my-app"
```

**tmux does not expand `~`.** It silently falls back to `$HOME` (`/Users/shanewickson`). This was confirmed empirically -- creating a tmux session with `-c "~/anything"` always results in `#{pane_current_path}` reporting the home directory.

### Bug 2: Session listing used tmux-derived path instead of registry

**File:** `services/sessions-service.ts:222-227` (original)

`fetchLocalSessions()` populated `workingDirectory` from `tmux display-message #{pane_current_path}` via `runtime.listSessions()`. Even if the agent registry stored the correct path, the session list overwrote it with whatever tmux reported -- which after tilde-path failure was `/Users/shanewickson`.

### Bug 3: Wizard placeholder encouraged tilde paths

**File:** `components/AgentCreationWizard.tsx:699` (original)

The directory input placeholder was `~/projects/my-app`, directly encouraging users to enter the exact path format that breaks.

## Fixes Applied

### Fix 1: Tilde expansion before tmux session creation

**File:** `services/sessions-service.ts`

```typescript
// Expand tilde to absolute path -- tmux does NOT expand ~ in -c flag.
// Handle both / (macOS/Linux) and \ (Windows) separators.
const resolvedDir = workingDirectory
  ? workingDirectory.replace(/^~(?=$|[/\\])/, os.homedir())
  : ''
const cwd = resolvedDir || process.cwd()
```

`os.homedir()` is cross-platform: `/Users/x` on macOS, `/home/x` on Linux, `C:\Users\x` on Windows.

### Fix 2: Prefer registry workingDirectory over tmux-derived

**File:** `services/sessions-service.ts` in `fetchLocalSessions()`

```typescript
const agent = getAgentBySession(disc.name)
// Prefer registry workingDirectory over tmux-derived (tmux reports $HOME if tilde path failed)
const agentWorkingDir = agent?.workingDirectory || agent?.sessions?.[0]?.workingDirectory

sessions.push({
  ...
  workingDirectory: agentWorkingDir || disc.workingDirectory,
  ...
})
```

### Fix 3: Updated wizard placeholder

**File:** `components/AgentCreationWizard.tsx`

Changed placeholder from `~/projects/my-app` to `/full/path/to/your/project`.

## Registry Repairs

The following agents had their registry entries manually corrected:

| Agent | Field | Before | After |
|-------|-------|--------|-------|
| `dev-aimaestro-admin` | workingDirectory | `/Users/shanewickson` | `/Users/shanewickson/Antigravity/ai-maestro` |
| `dev-aimaestro-admin` | sessions[0].workingDirectory | `/Users/shanewickson` | `/Users/shanewickson/Antigravity/ai-maestro` |
| `dev-aimaestro-admin` | preferences.defaultWorkingDirectory | `/Users/shanewickson` | `/Users/shanewickson/Antigravity/ai-maestro` |
| `dev-aimaestrogw-operator` | workingDirectory | `~/Antigravity/aimaestro-gateways` | `/Users/shanewickson/Antigravity/aimaestro-gateways` |
| `dev-aimaestrogw-operator` | sessions[0].workingDirectory | `~/Antigravity/aimaestro-gateways` | `/Users/shanewickson/Antigravity/aimaestro-gateways` |
| `dev-aimaestrogw-operator` | preferences.defaultWorkingDirectory | `~/Antigravity/aimaestro-gateways` | `/Users/shanewickson/Antigravity/aimaestro-gateways` |

`test-wizard-dir3` was a debug artifact and was deleted from the registry.

## Verification

- All 486 unit tests pass (`yarn test`)
- Production build succeeds (`yarn build`)

## Expected Results After Restart

1. `dev-aimaestro-admin` should start with working directory `/Users/shanewickson/Antigravity/ai-maestro`
2. Creating a new agent via the wizard with any path (including `~/...`) should correctly resolve and persist the full absolute path
3. The session list should show registry-stored paths, not tmux-derived paths

## If the Fix Did NOT Take

1. Check `~/.aimaestro/agents/registry.json` -- verify `dev-aimaestro-admin` still has the corrected `workingDirectory`
2. Check if AI Maestro server was restarted (`pm2 restart ai-maestro`) to pick up the code changes
3. The three code changes are in:
   - `services/sessions-service.ts` (tilde expansion + registry preference)
   - `components/AgentCreationWizard.tsx` (placeholder text)
