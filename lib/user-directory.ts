/**
 * User Directory — File-based CRUD for user identity resolution
 *
 * Storage: ~/.aimaestro/users/directory.json
 * Mirrors the pattern from lib/team-registry.ts and lib/agent-registry.ts
 *
 * Provides 5 lookup methods:
 *   byId, byAlias, byPlatform, byDisplayName, byRole
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'
import type {
  UserRecord,
  UserDirectoryFile,
  CreateUserParams,
  UpdateUserParams,
  UserRole,
} from '@/types/user'

const AIMAESTRO_DIR = path.join(os.homedir(), '.aimaestro')
const USERS_DIR = path.join(AIMAESTRO_DIR, 'users')
const DIRECTORY_FILE = path.join(USERS_DIR, 'directory.json')

// ─── Seed Data ──────────────────────────────────────────────────────────────

const OPERATOR_SEED: CreateUserParams = {
  displayName: 'Shane Wickson',
  aliases: ['gosub', 'shane', 'swick', 'shanewickson'],
  platforms: [
    {
      type: 'discord',
      platformUserId: '',  // Filled in by gateway integration (Phase 2)
      handle: 'gosub',
    },
  ],
  role: 'operator',
  trustLevel: 'full',
  preferredPlatform: 'discord',
}

// ─── File I/O ───────────────────────────────────────────────────────────────

function ensureUsersDir() {
  if (!fs.existsSync(USERS_DIR)) {
    fs.mkdirSync(USERS_DIR, { recursive: true })
  }
}

// mtime-based cache to avoid redundant disk reads (same pattern as loadAgents)
let _cachedUsers: UserRecord[] | null = null
let _cachedMtimeMs: number = 0

/**
 * Load all users from the directory file.
 * Seeds the operator record on first load if the file doesn't exist.
 * Uses mtime-based caching for fast repeated lookups (sub-50ms for resolve).
 */
export function loadUsers(): UserRecord[] {
  try {
    ensureUsersDir()

    if (!fs.existsSync(DIRECTORY_FILE)) {
      // First load — seed with operator record
      const operator = createUserRecord(OPERATOR_SEED)
      saveUsers([operator])
      console.log('[UserDirectory] Seeded operator record for Shane Wickson')
      return [operator]
    }

    // Return cached data if file hasn't changed
    const stat = fs.statSync(DIRECTORY_FILE)
    if (_cachedUsers && stat.mtimeMs === _cachedMtimeMs) {
      return _cachedUsers
    }

    const data = fs.readFileSync(DIRECTORY_FILE, 'utf-8')
    const parsed: UserDirectoryFile = JSON.parse(data)
    const users = Array.isArray(parsed.users) ? parsed.users : []

    _cachedUsers = users
    _cachedMtimeMs = stat.mtimeMs
    return users
  } catch (error) {
    console.error('[UserDirectory] Failed to load users:', error)
    return []
  }
}

export function saveUsers(users: UserRecord[]): boolean {
  try {
    ensureUsersDir()
    const file: UserDirectoryFile = { version: 1, users }
    fs.writeFileSync(DIRECTORY_FILE, JSON.stringify(file, null, 2), 'utf-8')
    // Invalidate cache so next read picks up the write
    _cachedUsers = null
    _cachedMtimeMs = 0
    return true
  } catch (error) {
    console.error('[UserDirectory] Failed to save users:', error)
    return false
  }
}

// ─── CRUD ───────────────────────────────────────────────────────────────────

function createUserRecord(params: CreateUserParams): UserRecord {
  const now = new Date().toISOString()
  return {
    id: uuidv4(),
    displayName: params.displayName,
    aliases: params.aliases || [],
    platforms: params.platforms || [],
    role: params.role || 'external',
    trustLevel: params.trustLevel || 'none',
    preferredPlatform: params.preferredPlatform,
    notificationPreferences: params.notificationPreferences,
    createdAt: now,
    updatedAt: now,
  }
}

export function createUser(params: CreateUserParams): UserRecord {
  const users = loadUsers()
  const user = createUserRecord(params)
  users.push(user)
  saveUsers(users)
  return user
}

export function getUser(id: string): UserRecord | null {
  const users = loadUsers()
  return users.find(u => u.id === id) || null
}

export function updateUser(id: string, updates: UpdateUserParams): UserRecord | null {
  const users = loadUsers()
  const index = users.findIndex(u => u.id === id)
  if (index === -1) return null

  users[index] = {
    ...users[index],
    ...updates,
    updatedAt: new Date().toISOString(),
  }

  saveUsers(users)
  return users[index]
}

export function deleteUser(id: string): boolean {
  const users = loadUsers()
  const filtered = users.filter(u => u.id !== id)
  if (filtered.length === users.length) return false
  saveUsers(filtered)
  return true
}

// ─── Lookups ────────────────────────────────────────────────────────────────

/**
 * Look up user by stable UUID
 */
export function getUserById(id: string): UserRecord | null {
  return getUser(id)
}

/**
 * Look up user by alias (case-insensitive).
 * Used for @mention resolution in AMP messages.
 */
export function getUserByAlias(alias: string): UserRecord | null {
  const normalized = alias.toLowerCase()
  const users = loadUsers()
  return users.find(u =>
    u.aliases.some(a => a.toLowerCase() === normalized)
  ) || null
}

/**
 * Look up user by platform type + platform user ID.
 * Used for inbound message → internal user mapping.
 */
export function getUserByPlatform(platformType: string, platformUserId: string): UserRecord | null {
  const normalizedType = platformType.toLowerCase()
  const users = loadUsers()
  return users.find(u =>
    u.platforms.some(p =>
      p.type.toLowerCase() === normalizedType &&
      p.platformUserId === platformUserId
    )
  ) || null
}

/**
 * Look up user by display name (case-insensitive).
 * Used for natural language references like "notify Shane Wickson".
 */
export function getUserByDisplayName(displayName: string): UserRecord | null {
  const normalized = displayName.toLowerCase()
  const users = loadUsers()
  return users.find(u =>
    u.displayName.toLowerCase() === normalized
  ) || null
}

/**
 * List all users with a given role.
 */
export function getUsersByRole(role: UserRole): UserRecord[] {
  const users = loadUsers()
  return users.filter(u => u.role === role)
}
