/**
 * Team Directory - Mesh sync for teams across nodes
 *
 * Mirrors the agent-directory.ts pattern:
 * - Periodic polling of peer hosts for their local teams
 * - Merge remote teams into local view with source='remote' tagging
 * - Local teams owned by this host, remote teams read-only
 *
 * Storage: Remote teams held in memory (not persisted to teams.json).
 * teams.json only contains local teams; remote teams are re-fetched each sync.
 */

import { getPeerHosts } from './hosts-config'
import { loadTeams, getLocalTeamsForSync } from './team-registry'
import type { Team } from '@/types/team'

// Sync interval (60 seconds, same as agent directory)
const SYNC_INTERVAL = 60 * 1000

// In-memory store for remote teams (not persisted)
let remoteTeams: Map<string, Team> = new Map()

// Track which host each remote team came from
let teamHostMap: Map<string, string> = new Map()

let syncInterval: NodeJS.Timeout | null = null

// ============================================================================
// Public API
// ============================================================================

/**
 * Get all teams: local (from disk) + remote (from sync).
 * This is the main function consumers should use instead of raw loadTeams().
 */
export function getAllTeams(): Team[] {
  const local = loadTeams().map(t => ({ ...t, source: 'local' as const }))
  const remote = Array.from(remoteTeams.values())
  return [...local, ...remote]
}

/**
 * Get a team by ID from local + remote.
 */
export function getTeamFromDirectory(id: string): Team | null {
  // Check local first
  const local = loadTeams().find(t => t.id === id)
  if (local) return { ...local, source: 'local' }

  // Check remote
  return remoteTeams.get(id) || null
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

          const existing = remoteTeams.get(team.id)
          if (!existing || new Date(team.updatedAt) > new Date(existing.updatedAt)) {
            remoteTeams.set(team.id, { ...team, source: 'remote' })
            teamHostMap.set(team.id, host.id)
            if (!existing) result.newTeams++
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
  for (const [teamId, hostId] of teamHostMap.entries()) {
    if (syncedHostSet.has(hostId) && !seenTeamIds.has(teamId)) {
      remoteTeams.delete(teamId)
      teamHostMap.delete(teamId)
      result.removedTeams++
    }
  }

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
  const remote = remoteTeams.size
  return { local, remote, total: local + remote }
}
