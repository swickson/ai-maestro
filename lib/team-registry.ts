/**
 * Team Registry - File-based CRUD for team persistence
 *
 * Storage: ~/.aimaestro/teams/teams.json
 * Mirrors the pattern from lib/agent-registry.ts
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import type { Team, TeamsFile } from '@/types/team'
import { getSelfHostId } from './hosts-config'

const AIMAESTRO_DIR = path.join(os.homedir(), '.aimaestro')
const TEAMS_DIR = path.join(AIMAESTRO_DIR, 'teams')
const TEAMS_FILE = path.join(TEAMS_DIR, 'teams.json')

function ensureTeamsDir() {
  if (!fs.existsSync(TEAMS_DIR)) {
    fs.mkdirSync(TEAMS_DIR, { recursive: true })
  }
}

export function loadTeams(): Team[] {
  try {
    ensureTeamsDir()
    if (!fs.existsSync(TEAMS_FILE)) {
      return []
    }
    const data = fs.readFileSync(TEAMS_FILE, 'utf-8')
    const parsed: TeamsFile = JSON.parse(data)
    let teams = Array.isArray(parsed.teams) ? parsed.teams : []

    // v1 → v2 migration: add hostId to existing teams
    if (!parsed.version || parsed.version < 2) {
      const selfHostId = getSelfHostId()
      let migrated = false
      teams = teams.map(t => {
        if (!t.hostId) {
          migrated = true
          return { ...t, hostId: selfHostId }
        }
        return t
      })
      if (migrated) {
        console.log(`[Teams] Migrated ${teams.length} teams to v2 (added hostId=${selfHostId})`)
        const file: TeamsFile = { version: 2, teams }
        fs.writeFileSync(TEAMS_FILE, JSON.stringify(file, null, 2), 'utf-8')
      }
    }

    return teams
  } catch (error) {
    console.error('Failed to load teams:', error)
    return []
  }
}

export function saveTeams(teams: Team[]): boolean {
  try {
    ensureTeamsDir()
    // Only persist local teams — remote teams come from sync
    const localTeams = teams.filter(t => t.source !== 'remote')
    // Strip runtime-only source field before writing
    const cleaned = localTeams.map(({ source, ...rest }) => rest)
    const file: TeamsFile = { version: 2, teams: cleaned }
    fs.writeFileSync(TEAMS_FILE, JSON.stringify(file, null, 2), 'utf-8')
    return true
  } catch (error) {
    console.error('Failed to save teams:', error)
    return false
  }
}

export function getTeam(id: string): Team | null {
  const teams = loadTeams()
  return teams.find(t => t.id === id) || null
}

export function createTeam(data: { name: string; description?: string; agentIds: string[] }): Team {
  const teams = loadTeams()
  const now = new Date().toISOString()

  const team: Team = {
    id: uuidv4(),
    name: data.name,
    description: data.description,
    agentIds: data.agentIds,
    hostId: getSelfHostId(),
    createdAt: now,
    updatedAt: now,
  }

  teams.push(team)
  saveTeams(teams)
  return team
}

export function updateTeam(id: string, updates: Partial<Pick<Team, 'name' | 'description' | 'agentIds' | 'lastMeetingAt' | 'instructions' | 'lastActivityAt'>>): Team | null {
  const teams = loadTeams()
  const index = teams.findIndex(t => t.id === id)
  if (index === -1) return null

  teams[index] = {
    ...teams[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  }

  saveTeams(teams)
  return teams[index]
}

export function deleteTeam(id: string): boolean {
  const teams = loadTeams()
  const team = teams.find(t => t.id === id)
  // Don't allow deleting remote teams
  if (!team || team.source === 'remote') return false
  const filtered = teams.filter(t => t.id !== id)
  saveTeams(filtered)
  return true
}

/**
 * Get local teams for sharing with peers during sync.
 * Returns teams owned by this host (source !== 'remote').
 */
export function getLocalTeamsForSync(): Team[] {
  const teams = loadTeams()
  const selfHostId = getSelfHostId()
  return teams.filter(t => t.hostId === selfHostId && t.source !== 'remote')
}
