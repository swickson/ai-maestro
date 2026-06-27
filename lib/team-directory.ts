/**
 * Team Directory - Mesh sync for teams across nodes
 *
 * Mirrors the agent-directory.ts pattern:
 * - Periodic polling of peer hosts for their local teams
 * - Merge remote teams into local view with source='remote' tagging
 * - Local teams owned by this host, remote teams read-only
 *
 * Storage: remote teams are persisted to a SEPARATE file
 * (~/.aimaestro/teams/remote-teams-directory.json), NOT teams.json — teams.json
 * holds only this host's local teams and getLocalTeamsForSync isSelf-filters it,
 * so writing remote teams there would drop or pollute the local set. File-backing
 * (mirroring agent-directory.ts) is load-bearing: the sync WRITER (server.mjs's
 * startTeamDirectorySync timer instance) and a dashboard READER (Next's
 * /api/teams -> getAllTeams instance) are different module instances, so an
 * in-memory Map never bridges them in full mode — the timer's synced teams would
 * never reach the pane. The file + #281-style mtime-invalidation bridges them.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { getPeerHosts } from './hosts-config'
import { loadTeams, getLocalTeamsForSync } from './team-registry'
import { computeTeamTaskSummary } from './task-registry'
import type { Team } from '@/types/team'

// Sync interval (60 seconds, same as agent directory)
const SYNC_INTERVAL = 60 * 1000

// Remote teams persisted to a separate file (see header). Shape: { teams, hostMap }
// where hostMap tracks which peer host each remote team came from (for stale GC).
const REMOTE_TEAMS_FILE = path.join(os.homedir(), '.aimaestro', 'teams', 'remote-teams-directory.json')

interface RemoteTeamsStore {
  teams: Record<string, Team>
  hostMap: Record<string, string>
}

// In-memory cache of the file. The mtime check (#281) lets a reader instance
// detect another instance's writes instead of serving a stale snapshot.
let cache: RemoteTeamsStore | null = null
let cacheTimestamp = 0

function loadRemoteTeams(): RemoteTeamsStore {
  // Serve cache only if the on-disk file is not newer than our cache stamp.
  if (cache) {
    try {
      if (fs.statSync(REMOTE_TEAMS_FILE).mtimeMs <= cacheTimestamp) return cache
    } catch {
      return cache  // stat failed (file not created yet) — keep serving the cache
    }
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(REMOTE_TEAMS_FILE, 'utf-8')) as RemoteTeamsStore
    cache = { teams: parsed.teams ?? {}, hostMap: parsed.hostMap ?? {} }
    cacheTimestamp = fs.statSync(REMOTE_TEAMS_FILE).mtimeMs
  } catch {
    cache = { teams: {}, hostMap: {} }  // no file yet — empty remote set
  }
  return cache
}

function saveRemoteTeams(store: RemoteTeamsStore): void {
  try {
    fs.mkdirSync(path.dirname(REMOTE_TEAMS_FILE), { recursive: true })
    fs.writeFileSync(REMOTE_TEAMS_FILE, JSON.stringify(store))
    cache = store
    cacheTimestamp = Date.now()  // stamp AFTER the write so the writer never self-invalidates (#281)
  } catch (err) {
    console.error('[Team Directory] Failed to persist remote teams:', err)
  }
}

let syncInterval: NodeJS.Timeout | null = null

// ============================================================================
// Public API
// ============================================================================

/**
 * Get all teams: local (from disk) + remote (from sync).
 * This is the main function consumers should use instead of raw loadTeams().
 */
export function getAllTeams(): Team[] {
  // Local teams get a freshly-computed task rollup (read-time-fresh); remote
  // teams keep the rollup that rode the sync from their owning host.
  const local = loadTeams().map(t => ({
    ...t,
    source: 'local' as const,
    taskSummary: computeTeamTaskSummary(t.id),
  }))
  const remote = Object.values(loadRemoteTeams().teams)
  return [...local, ...remote]
}

/**
 * Get a team by ID from local + remote.
 */
export function getTeamFromDirectory(id: string): Team | null {
  // Check local first
  const local = loadTeams().find(t => t.id === id)
  if (local) return { ...local, source: 'local' }

  // Check remote (file-backed)
  return loadRemoteTeams().teams[id] || null
}

/**
 * Sync with all peer hosts.
 * Fetches local teams from each peer and merges into remote teams map.
 */
export async function syncTeamsWithPeers(timeout: number = 5000): Promise<{
  synced: string[]
  failed: string[]
  newTeams: number
  removedTeams: number
}> {
  const peerHosts = getPeerHosts()
  const result = {
    synced: [] as string[],
    failed: [] as string[],
    newTeams: 0,
    removedTeams: 0,
  }

  // Track which teams we see this cycle (for stale removal)
  const seenTeamIds = new Set<string>()

  // Load the persisted remote set, mutate working copies, persist once at the end
  // so the WRITER instance's changes reach READER instances (the full-mode pane)
  // via the file rather than a process-local Map.
  const store = loadRemoteTeams()
  const teams: Record<string, Team> = { ...store.teams }
  const hostMap: Record<string, string> = { ...store.hostMap }

  for (const host of peerHosts) {
    try {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), timeout)

      const response = await fetch(`${host.url}/api/teams/directory`, {
        signal: controller.signal,
      })
      clearTimeout(timeoutId)

      if (!response.ok) {
        result.failed.push(host.id)
        continue
      }

      const data = await response.json()
      if (data.teams && Array.isArray(data.teams)) {
        for (const team of data.teams as Team[]) {
          seenTeamIds.add(team.id)

          // Don't overwrite local teams
          const localTeams = loadTeams()
          if (localTeams.some(t => t.id === team.id)) continue

          const existing = teams[team.id]
          if (!existing || new Date(team.updatedAt) > new Date(existing.updatedAt)) {
            teams[team.id] = { ...team, source: 'remote' }
            hostMap[team.id] = host.id
            if (!existing) result.newTeams++
          } else {
            // Metadata unchanged (updatedAt not newer), but the runtime task
            // rollup changes on task CRUD WITHOUT bumping Team.updatedAt — so the
            // updatedAt gate alone would freeze a remote team's taskSummary stale
            // forever (no new counts, no NEEDS-YOU alarm). Always refresh the
            // runtime field from the peer's read-time-fresh value, the way the
            // agent directory re-registers activity every sync.
            teams[team.id] = { ...existing, taskSummary: team.taskSummary }
          }
        }
      }

      result.synced.push(host.id)
    } catch {
      result.failed.push(host.id)
    }
  }

  // Remove remote teams from hosts that synced successfully but no longer report the team.
  // Keep teams from hosts that failed to sync (they might just be temporarily down).
  const syncedHostSet = new Set(result.synced)
  for (const [teamId, hostId] of Object.entries(hostMap)) {
    if (syncedHostSet.has(hostId) && !seenTeamIds.has(teamId)) {
      delete teams[teamId]
      delete hostMap[teamId]
      result.removedTeams++
    }
  }

  // Persist the updated remote set so reader instances (the full-mode pane) see it.
  saveRemoteTeams({ teams, hostMap })

  return result
}

/**
 * Start periodic team sync with peers.
 * Should be called alongside startDirectorySync() in server initialization.
 */
export function startTeamDirectorySync(intervalMs: number = SYNC_INTERVAL): void {
  if (syncInterval) {
    clearInterval(syncInterval)
  }

  // Initial sync
  syncTeamsWithPeers().then(result => {
    if (result.newTeams > 0) {
      console.log(`[Team Directory] Initial sync: discovered ${result.newTeams} remote teams`)
    }
  }).catch(err => {
    console.error('[Team Directory] Initial sync failed:', err)
  })

  // Periodic sync
  syncInterval = setInterval(async () => {
    try {
      const result = await syncTeamsWithPeers()
      if (result.newTeams > 0 || result.removedTeams > 0) {
        console.log(`[Team Directory] Sync: +${result.newTeams} new, -${result.removedTeams} removed`)
      }
    } catch (err) {
      console.error('[Team Directory] Periodic sync failed:', err)
    }
  }, intervalMs)

  console.log(`[Team Directory] Started periodic sync (every ${intervalMs / 1000}s)`)
}

/**
 * Stop periodic team sync.
 */
export function stopTeamDirectorySync(): void {
  if (syncInterval) {
    clearInterval(syncInterval)
    syncInterval = null
    console.log('[Team Directory] Stopped periodic sync')
  }
}

/**
 * Get remote teams count (for diagnostics).
 */
export function getTeamDirectoryStats(): {
  local: number
  remote: number
  total: number
} {
  const local = loadTeams().length
  const remote = Object.keys(loadRemoteTeams().teams).length
  return { local, remote, total: local + remote }
}
