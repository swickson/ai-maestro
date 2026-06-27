/**
 * Agent Directory (Phase 3: AMP Protocol Fix)
 *
 * A distributed directory service for locating agents across the mesh network.
 * Each AI Maestro instance maintains its own directory of known agents.
 *
 * Key features:
 * - Fast agent name -> host location lookups
 * - Mesh-wide agent discovery
 * - Periodic sync with peer hosts
 * - Caching with TTL for performance
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { getPeerHosts, isSelf } from './hosts-config'
import { loadAgents, normalizeHostId } from './agent-registry'
import { readHookState, isBlockingPrompt, HOOK_BUSY_STALE_MS } from './inject-readiness'

const AIMAESTRO_DIR = path.join(os.homedir(), '.aimaestro')
const DIRECTORY_FILE = path.join(AIMAESTRO_DIR, 'agent-directory.json')

// Cache TTL in milliseconds (5 minutes)
const CACHE_TTL = 5 * 60 * 1000

// Directory sync interval (1 minute)
const SYNC_INTERVAL = 60 * 1000

// ============================================================================
// Types
// ============================================================================

/**
 * Directory entry for a single agent
 */
/**
 * Per-agent runtime activity — the "who's idle / working / stuck" signal that
 * Mission Control reads (P2). Derived from the CLIENT-INDEPENDENT hook state
 * (services/shared-state via inject-readiness), NOT terminal scraping, so it's
 * trustworthy for an unwatched pane. Computed fresh at read time for local
 * agents in getLocalEntriesForSync(); rides the existing directory sync to
 * peers (as-of-last-sync for remote agents). Never persisted on the entry.
 */
export interface AgentActivity {
  state: 'active' | 'idle' | 'waiting' | 'stuck' | 'unknown'  // working / quiet / needs-input / wedged / no-signal
  lastActivityAt?: string       // ISO — last hook state write
  observedStuck?: boolean        // hook says 'busy' but stale > HOOK_BUSY_STALE_MS (token-timer stalled)
}

export interface AgentDirectoryEntry {
  agentId?: string              // Agent UUID — for cross-referencing with meeting participants
  name: string                  // Agent name (e.g., "backend-api")
  label?: string                // Display label (e.g., "a peer dev (prod-host)") — for UI and @mention resolution
  hostId: string                // Host where agent lives
  hostUrl?: string              // URL to reach the host
  ampAddress?: string           // Full AMP address (e.g., "backend-api@acme.aimaestro.local")
  ampRegistered: boolean        // Is this a proper AMP-registered agent?
  lastSeen: string              // ISO timestamp of last verification
  source: 'local' | 'remote'    // Where we learned about this agent
  activity?: AgentActivity      // Runtime state (P2) — read-time-fresh for local, synced for remote
}

/**
 * Full agent directory state
 */
export interface AgentDirectory {
  version: number               // Directory version (increments on changes)
  lastSync: string              // When directory was last synced
  entries: Record<string, AgentDirectoryEntry>  // name -> entry
}

// ============================================================================
// Directory Keying (#42)
// ============================================================================

// Canonical entry key. agentId (a globally-unique UUID) is the only collision-
// free key — agent names (and even hostId:name) collide across hosts and churn
// on rename/recreate, which silently shadowed one agent's identity behind
// another's under the old name-keyed map (#42; e.g. the laptop "an agent" vs
// the prod host "a peer dev (prod-host)", both named dev-<team>-<role>). Entries without an agentId
// (legacy / non-AMP-registered) fall back to a hostId:name composite, which is
// at least per-host unique.
function entryKey(e: { agentId?: string; hostId: string; name: string }): string {
  if (e.agentId) return e.agentId
  return `${normalizeHostId(e.hostId)}:${(e.name || '').toLowerCase()}`
}

// Re-key an entries map to canonical keys. Idempotent, and the load-time
// backward-compat bridge: it transparently converts an OLD name-keyed map to
// the new agentId-keyed shape on read, so a host running new code reads BOTH
// shapes (its own freshly-migrated file AND any older file). Sync transmits
// entry VALUES (not keys) and the receiver re-keys, so the on-disk key shape
// never crosses hosts — old-code peers keep working during a staggered rollout.
function migrateToCanonicalKeys(directory: AgentDirectory): AgentDirectory {
  if (!directory.entries) return directory
  const rekeyed: Record<string, AgentDirectoryEntry> = {}
  for (const entry of Object.values(directory.entries)) {
    if (!entry || typeof entry !== 'object' || !entry.name) continue
    rekeyed[entryKey(entry)] = entry
  }
  directory.entries = rekeyed
  return directory
}

// ============================================================================
// Directory Storage
// ============================================================================

let directoryCache: AgentDirectory | null = null
let cacheTimestamp: number = 0

/**
 * Ensure the .aimaestro directory exists
 */
function ensureDir(): void {
  if (!fs.existsSync(AIMAESTRO_DIR)) {
    fs.mkdirSync(AIMAESTRO_DIR, { recursive: true })
  }
}

/**
 * Load directory from disk
 */
function loadDirectory(): AgentDirectory {
  // Serve the in-memory cache only if it is BOTH within TTL AND not older than
  // the on-disk file. The mtime check is load-bearing: the directory sync WRITER
  // and a dashboard READER can be different module instances (Next bundles each
  // route's imports separately), so a pure time-cache never sees the writer's
  // file writes — it serves a stale blob and, via rebuildLocalDirectory's
  // save-on-read, even clobbers the writer's fresh remote activity back to
  // stale. A cheap statSync lets any reader detect any writer's change and
  // re-read. saveDirectory stamps cacheTimestamp AFTER the write, so a writer
  // never self-invalidates on its own writes.
  if (directoryCache && (Date.now() - cacheTimestamp) < CACHE_TTL) {
    try {
      if (fs.statSync(DIRECTORY_FILE).mtimeMs <= cacheTimestamp) {
        return directoryCache
      }
      // file is newer than our cache → fall through and re-read it
    } catch {
      // stat failed (e.g. file not yet created) — keep serving the cache
      return directoryCache
    }
  }

  ensureDir()

  if (!fs.existsSync(DIRECTORY_FILE)) {
    const emptyDir: AgentDirectory = {
      version: 0,
      lastSync: new Date().toISOString(),
      entries: {}
    }
    return emptyDir
  }

  try {
    const data = fs.readFileSync(DIRECTORY_FILE, 'utf-8')
    // #42: re-key to canonical (agentId) shape on load — transparently migrates
    // an old name-keyed file and is idempotent for an already-migrated one.
    directoryCache = migrateToCanonicalKeys(JSON.parse(data))
    cacheTimestamp = Date.now()
    return directoryCache!
  } catch (error) {
    console.error('[Agent Directory] Failed to load directory:', error)
    return {
      version: 0,
      lastSync: new Date().toISOString(),
      entries: {}
    }
  }
}

/**
 * Save directory to disk
 */
function saveDirectory(directory: AgentDirectory): boolean {
  ensureDir()

  try {
    directory.version++
    directory.lastSync = new Date().toISOString()
    fs.writeFileSync(DIRECTORY_FILE, JSON.stringify(directory, null, 2), 'utf-8')
    directoryCache = directory
    cacheTimestamp = Date.now()
    return true
  } catch (error) {
    console.error('[Agent Directory] Failed to save directory:', error)
    return false
  }
}

/**
 * Clear directory cache
 */
export function clearDirectoryCache(): void {
  directoryCache = null
  cacheTimestamp = 0
}

// ============================================================================
// Directory Operations
// ============================================================================

/**
 * Rebuild directory from local agents
 * Called on startup or when agents change
 */
export function rebuildLocalDirectory(): AgentDirectory {
  const directory = loadDirectory()
  const agents = loadAgents()

  // Use isSelf() for self-detection rather than a raw hostId equality: when this
  // machine's runtime hostname drifts from the stored hostId (e.g. a docked
  // laptop), a raw === would stop recognizing this host's own agents — stale
  // entries wouldn't be GC'd and freshly-created local agents wouldn't be added
  // to the directory (so they'd never publish). isSelf() is drift-aware
  // (hostname/IP/alias-cache). Mirrors the getLocalTeamsForSync fix (#284).
  // Remove stale local entries (key-agnostic — match by stored identity, #42).
  for (const [key, entry] of Object.entries(directory.entries)) {
    if (entry.source === 'local' && isSelf(entry.hostId)) {
      // Check if agent still exists locally (by id when known, else by name).
      const stillExists = agents.some(a =>
        isSelf(a.hostId) &&
        (entry.agentId
          ? a.id === entry.agentId
          : (a.name || a.alias)?.toLowerCase() === entry.name.toLowerCase())
      )
      if (!stillExists) {
        delete directory.entries[key]
      }
    }
  }

  // Add/update local agents, keyed canonically (agentId) so same-named agents
  // on different hosts never shadow each other (#42).
  for (const agent of agents) {
    const name = (agent.name || agent.alias)?.toLowerCase()
    if (!name) continue

    const hostId = normalizeHostId(agent.hostId)
    if (!isSelf(agent.hostId)) continue  // Only local agents (drift-aware)

    const newEntry: AgentDirectoryEntry = {
      agentId: agent.id,
      name,
      label: agent.label || undefined,
      hostId,
      hostUrl: agent.hostUrl,
      ampAddress: agent.metadata?.amp?.address,
      ampRegistered: agent.ampRegistered === true,
      lastSeen: new Date().toISOString(),
      source: 'local'
    }
    directory.entries[entryKey(newEntry)] = newEntry
  }

  saveDirectory(directory)
  return directory
}

/**
 * Look up an agent in the directory by name, optionally disambiguated by host.
 *
 * Since the map is now agentId-keyed (#42), a name can legitimately match
 * MULTIPLE entries (same name on different hosts). With `hostId` given, returns
 * the unique host-qualified match. Without it, returns the sole match, or null
 * when the name is AMBIGUOUS across hosts — callers that need a specific one
 * must pass hostId. Use `lookupAgentsByName` to see all matches.
 */
export function lookupAgent(name: string, hostId?: string): AgentDirectoryEntry | null {
  const matches = lookupAgentsByName(name)
  if (hostId) {
    const h = normalizeHostId(hostId)
    return matches.find(e => normalizeHostId(e.hostId) === h) || null
  }
  if (matches.length === 1) return matches[0]
  if (matches.length > 1) {
    console.warn(
      `[Agent Directory] Ambiguous name "${name}" matches ${matches.length} agents across hosts ` +
      `(${matches.map(e => e.hostId).join(', ')}); pass hostId to disambiguate.`
    )
    return null
  }
  return null
}

/**
 * All directory entries matching a name (across hosts). Surfaces collisions
 * instead of silently shadowing them (#42).
 */
export function lookupAgentsByName(name: string): AgentDirectoryEntry[] {
  const directory = loadDirectory()
  const normalizedName = name.toLowerCase()
  return Object.values(directory.entries).filter(e => e.name.toLowerCase() === normalizedName)
}

/**
 * Look up an agent in the directory by UUID. O(1) for agentId-keyed entries;
 * falls back to a scan for legacy composite-keyed ones.
 */
export function lookupAgentById(agentId: string): AgentDirectoryEntry | null {
  const directory = loadDirectory()
  const direct = directory.entries[agentId]
  if (direct && direct.agentId === agentId) return direct
  for (const entry of Object.values(directory.entries)) {
    if (entry.agentId === agentId) return entry
  }
  return null
}

/**
 * Register a remote agent in the directory
 * Called when we learn about agents from peer hosts
 */
export function registerRemoteAgent(entry: Omit<AgentDirectoryEntry, 'source' | 'lastSeen'>): boolean {
  const directory = loadDirectory()
  const normalizedName = entry.name.toLowerCase()
  const newEntry: AgentDirectoryEntry = {
    ...entry,
    name: normalizedName,
    lastSeen: new Date().toISOString(),
    source: 'remote'
  }
  const key = entryKey(newEntry)

  // Don't overwrite a LOCAL entry for the SAME agent (same canonical key) with a
  // remote one. Keying by agentId means a remote agent that merely shares a NAME
  // with a local agent on this host now gets its own key and coexists, instead
  // of being silently dropped by the old name-collision guard (#42).
  const existing = directory.entries[key]
  if (existing && existing.source === 'local') {
    console.log(`[Agent Directory] Skipping remote update for local agent: ${key}`)
    return false
  }

  directory.entries[key] = newEntry
  return saveDirectory(directory)
}

/**
 * Remove an agent from the directory
 */
export function unregisterAgent(name: string, hostId?: string): boolean {
  const directory = loadDirectory()
  const normalizedName = name.toLowerCase()
  const h = hostId ? normalizeHostId(hostId) : undefined

  // Find every key whose entry matches the name (+ host when given). Without a
  // host, an ambiguous name removes all matches (caller didn't disambiguate).
  const keys = Object.entries(directory.entries)
    .filter(([, e]) => e.name.toLowerCase() === normalizedName && (!h || normalizeHostId(e.hostId) === h))
    .map(([k]) => k)

  if (keys.length === 0) return false
  for (const k of keys) delete directory.entries[k]
  return saveDirectory(directory)
}

/**
 * Get all entries in the directory
 */
export function getAllDirectoryEntries(): AgentDirectoryEntry[] {
  const directory = loadDirectory()
  // Local entries get fresh activity here (the dashboard's merged view); remote
  // entries keep the activity that rode the sync from their home host.
  return enrichLocalActivity(Object.values(directory.entries))
}

/**
 * Get directory statistics
 */
export function getDirectoryStats(): {
  total: number
  local: number
  remote: number
  ampRegistered: number
  version: number
  lastSync: string
} {
  const directory = loadDirectory()
  const entries = Object.values(directory.entries)

  return {
    total: entries.length,
    local: entries.filter(e => e.source === 'local').length,
    remote: entries.filter(e => e.source === 'remote').length,
    ampRegistered: entries.filter(e => e.ampRegistered).length,
    version: directory.version,
    lastSync: directory.lastSync
  }
}

// ============================================================================
// Mesh Sync
// ============================================================================

/**
 * Sync directory with peer hosts
 * Fetches agent lists from all known peers and updates directory
 */
export async function syncWithPeers(timeout: number = 5000): Promise<{
  synced: string[]
  failed: string[]
  newAgents: number
}> {
  const peerHosts = getPeerHosts()
  const result = {
    synced: [] as string[],
    failed: [] as string[],
    newAgents: 0
  }

  for (const host of peerHosts) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      const response = await fetch(`${host.url}/api/agents/directory`, {
        signal: controller.signal
      })
      clearTimeout(timeoutId)

      if (!response.ok) {
        result.failed.push(host.id)
        continue
      }

      const data = await response.json()
      if (data.entries && Array.isArray(data.entries)) {
        for (const entry of data.entries) {
          // Only import entries from the peer's local agents
          if (entry.source === 'local' && entry.hostId === host.id) {
            // Existence check by agentId (#42) — a local agent that merely
            // SHARES A NAME with this remote one must not block its import
            // (the old lookupAgent(name) guard silently shadowed cross-host
            // same-named agents). Fall back to host-qualified name when the
            // peer entry has no agentId.
            const existing = entry.agentId
              ? lookupAgentById(entry.agentId)
              : lookupAgent(entry.name, entry.hostId)
            if (!existing || existing.source === 'remote') {
              registerRemoteAgent({
                agentId: entry.agentId,
                name: entry.name,
                label: entry.label,
                hostId: entry.hostId,
                hostUrl: entry.hostUrl || host.url,
                ampAddress: entry.ampAddress,
                ampRegistered: entry.ampRegistered,
                // Carry the peer's runtime activity through the pull-sync (P2):
                // the peer's getLocalEntriesForSync enriched it; without this it
                // is dropped here and remote agents show no activity on the pane.
                activity: entry.activity
              })
              result.newAgents++
            }
          }
        }
      }

      result.synced.push(host.id)
    } catch (error) {
      result.failed.push(host.id)
    }
  }

  return result
}

/**
 * Get local entries for sharing with peers
 */
/**
 * Derive an agent's runtime activity from its CLIENT-INDEPENDENT hook state
 * (P2). Leans on the hook (written by the Claude hook at turn start/end, read
 * from disk via readHookState) rather than `isTerminalIdle`, whose idle verdict
 * is untrustworthy for an unwatched pane (#239 BUG1). Pure + synchronous — no
 * tmux shell-out — so it's cheap to run for every agent on each directory read.
 *
 *   blocking prompt          -> 'waiting' (needs the human — the NEEDS-YOU row)
 *   hook 'busy' & stale >5min -> 'stuck'  (token-timer stalled; observedStuck)
 *   hook 'busy' & fresh       -> 'active'
 *   otherwise (dormant/null)  -> 'idle'
 */
export function computeAgentActivity(workingDir?: string | null, now: number = Date.now()): AgentActivity {
  const hookState = readHookState(workingDir)
  const lastActivityAt = hookState?.updatedAt
  if (isBlockingPrompt(hookState)) {
    return { state: 'waiting', lastActivityAt, observedStuck: false }
  }
  if (hookState?.status === 'busy') {
    const age = hookState.updatedAt ? now - new Date(hookState.updatedAt).getTime() : Infinity
    if (age >= HOOK_BUSY_STALE_MS) {
      return { state: 'stuck', lastActivityAt, observedStuck: true }
    }
    return { state: 'active', lastActivityAt, observedStuck: false }
  }
  // Claude-not-busy is authoritative idle; a null/dormant hook also reads as
  // quiet for display purposes (nothing observable demanding attention).
  return { state: 'idle', lastActivityAt, observedStuck: false }
}

/**
 * Attach fresh runtime activity to LOCAL entries at READ time (never persisted).
 * Remote entries are left untouched — they carry their home host's activity as of
 * the last sync. workingDirectory is stored on the agent registry (agent-first
 * architecture), not on the directory entry — resolve it by canonical id, else
 * by name. Shared by getLocalEntriesForSync (sync payload) + getAllDirectoryEntries
 * (the dashboard's merged view) so both surface the same signal.
 */
function enrichLocalActivity(entries: AgentDirectoryEntry[]): AgentDirectoryEntry[] {
  const agents = loadAgents()
  const now = Date.now()
  return entries.map(e => {
    if (e.source !== 'local') return e
    const agent = agents.find(a =>
      e.agentId ? a.id === e.agentId : (a.name || a.alias)?.toLowerCase() === e.name.toLowerCase()
    )
    const workingDir = agent?.workingDirectory || agent?.sessions?.[0]?.workingDirectory
    return { ...e, activity: computeAgentActivity(workingDir, now) }
  })
}

export function getLocalEntriesForSync(): AgentDirectoryEntry[] {
  const directory = loadDirectory()
  const locals = Object.values(directory.entries).filter(e => e.source === 'local')
  return enrichLocalActivity(locals)
}

// ============================================================================
// Background Sync (Optional)
// ============================================================================

let syncInterval: NodeJS.Timeout | null = null

/**
 * Start periodic directory sync with peers
 */
export function startDirectorySync(intervalMs: number = SYNC_INTERVAL): void {
  if (syncInterval) {
    clearInterval(syncInterval)
  }

  // Do initial sync
  rebuildLocalDirectory()
  syncWithPeers().then(result => {
    if (result.newAgents > 0) {
      console.log(`[Agent Directory] Initial sync: discovered ${result.newAgents} new agents`)
    }
  }).catch(err => {
    console.error('[Agent Directory] Initial sync failed:', err)
  })

  // Set up periodic sync
  syncInterval = setInterval(async () => {
    try {
      const result = await syncWithPeers()
      if (result.newAgents > 0) {
        console.log(`[Agent Directory] Sync: discovered ${result.newAgents} new agents`)
      }
    } catch (err) {
      console.error('[Agent Directory] Periodic sync failed:', err)
    }
  }, intervalMs)

  console.log(`[Agent Directory] Started periodic sync (every ${intervalMs / 1000}s)`)
}

/**
 * Stop periodic directory sync
 */
export function stopDirectorySync(): void {
  if (syncInterval) {
    clearInterval(syncInterval)
    syncInterval = null
    console.log('[Agent Directory] Stopped periodic sync')
  }
}
