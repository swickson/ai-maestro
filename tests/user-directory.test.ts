/**
 * User Directory — Unit Tests
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Mock fs to avoid touching the real filesystem
vi.mock('fs')
vi.mock('uuid', () => ({ v4: () => 'test-uuid-1234' }))

const USERS_DIR = path.join(os.homedir(), '.aimaestro', 'users')
const DIRECTORY_FILE = path.join(USERS_DIR, 'directory.json')

describe('user-directory', () => {
  let mockFs: Record<string, string>

  let mtimeCounter: number

  beforeEach(() => {
    vi.resetModules()
    mockFs = {}
    mtimeCounter = 1
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      return p.toString() in mockFs || p.toString() === USERS_DIR
    })
    vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
      const content = mockFs[p.toString()]
      if (!content) throw new Error(`ENOENT: ${p}`)
      return content
    })
    vi.mocked(fs.writeFileSync).mockImplementation((p: fs.PathOrFileDescriptor, data: any) => {
      mockFs[p.toString()] = typeof data === 'string' ? data : String(data)
      mtimeCounter++ // Simulate file change
    })
    vi.mocked(fs.statSync).mockImplementation(() => ({ mtimeMs: mtimeCounter } as any))
    vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('loadUsers', () => {
    it('seeds operator record on first load', async () => {
      // No file exists — existsSync returns false for the file
      vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
        if (p.toString() === DIRECTORY_FILE) return false
        return true // Directory exists
      })

      const { loadUsers } = await import('@/lib/user-directory')
      const users = loadUsers()

      expect(users).toHaveLength(1)
      expect(users[0].displayName).toBe('Shane Wickson')
      expect(users[0].role).toBe('operator')
      expect(users[0].trustLevel).toBe('full')
      expect(users[0].aliases).toContain('gosub')
      expect(users[0].aliases).toContain('shane')
    })

    it('loads existing users from file', async () => {
      const existingUser = {
        id: 'existing-id',
        displayName: 'Test User',
        aliases: ['tester'],
        platforms: [],
        role: 'external',
        trustLevel: 'none',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }
      mockFs[DIRECTORY_FILE] = JSON.stringify({ version: 1, users: [existingUser] })

      const { loadUsers } = await import('@/lib/user-directory')
      const users = loadUsers()

      expect(users).toHaveLength(1)
      expect(users[0].displayName).toBe('Test User')
    })
  })

  describe('CRUD operations', () => {
    it('creates a user', async () => {
      mockFs[DIRECTORY_FILE] = JSON.stringify({ version: 1, users: [] })

      const { createUser } = await import('@/lib/user-directory')
      const user = createUser({
        displayName: 'New User',
        aliases: ['newbie'],
        role: 'external',
      })

      expect(user.id).toBe('test-uuid-1234')
      expect(user.displayName).toBe('New User')
      expect(user.aliases).toEqual(['newbie'])
      expect(user.role).toBe('external')
      expect(user.trustLevel).toBe('none') // default
    })

    it('updates a user', async () => {
      const existing = {
        id: 'user-1',
        displayName: 'Old Name',
        aliases: [],
        platforms: [],
        role: 'external',
        trustLevel: 'none',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }
      mockFs[DIRECTORY_FILE] = JSON.stringify({ version: 1, users: [existing] })

      const { updateUser } = await import('@/lib/user-directory')
      const updated = updateUser('user-1', { displayName: 'New Name' })

      expect(updated).not.toBeNull()
      expect(updated!.displayName).toBe('New Name')
      expect(updated!.updatedAt).not.toBe(existing.updatedAt)
    })

    it('returns null when updating non-existent user', async () => {
      mockFs[DIRECTORY_FILE] = JSON.stringify({ version: 1, users: [] })

      const { updateUser } = await import('@/lib/user-directory')
      const result = updateUser('nonexistent', { displayName: 'X' })

      expect(result).toBeNull()
    })

    it('deletes a user', async () => {
      const existing = {
        id: 'user-1',
        displayName: 'Doomed',
        aliases: [],
        platforms: [],
        role: 'external',
        trustLevel: 'none',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }
      mockFs[DIRECTORY_FILE] = JSON.stringify({ version: 1, users: [existing] })

      const { deleteUser } = await import('@/lib/user-directory')
      expect(deleteUser('user-1')).toBe(true)
      expect(deleteUser('nonexistent')).toBe(false)
    })
  })

  describe('lookups', () => {
    const users = [
      {
        id: 'user-1',
        displayName: 'Shane Wickson',
        aliases: ['gosub', 'shane', 'swick'],
        platforms: [
          { type: 'discord', platformUserId: '123456789', handle: 'gosub' },
          { type: 'slack', platformUserId: 'U0ABC', handle: 'shane.wickson' },
        ],
        role: 'operator',
        trustLevel: 'full',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
      {
        id: 'user-2',
        displayName: 'External Person',
        aliases: ['extuser'],
        platforms: [
          { type: 'discord', platformUserId: '987654321', handle: 'ext' },
        ],
        role: 'external',
        trustLevel: 'none',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      },
    ]

    beforeEach(() => {
      mockFs[DIRECTORY_FILE] = JSON.stringify({ version: 1, users })
    })

    it('getUserByAlias — case insensitive', async () => {
      const { getUserByAlias } = await import('@/lib/user-directory')
      expect(getUserByAlias('gosub')?.id).toBe('user-1')
      expect(getUserByAlias('GOSUB')?.id).toBe('user-1')
      expect(getUserByAlias('Shane')?.id).toBe('user-1')
      expect(getUserByAlias('unknown')).toBeNull()
    })

    it('getUserByPlatform', async () => {
      const { getUserByPlatform } = await import('@/lib/user-directory')
      expect(getUserByPlatform('discord', '123456789')?.id).toBe('user-1')
      expect(getUserByPlatform('slack', 'U0ABC')?.id).toBe('user-1')
      expect(getUserByPlatform('discord', '987654321')?.id).toBe('user-2')
      expect(getUserByPlatform('discord', 'nonexistent')).toBeNull()
    })

    it('getUserByDisplayName — case insensitive', async () => {
      const { getUserByDisplayName } = await import('@/lib/user-directory')
      expect(getUserByDisplayName('Shane Wickson')?.id).toBe('user-1')
      expect(getUserByDisplayName('shane wickson')?.id).toBe('user-1')
      expect(getUserByDisplayName('Nobody')).toBeNull()
    })

    it('getUsersByRole', async () => {
      const { getUsersByRole } = await import('@/lib/user-directory')
      expect(getUsersByRole('operator')).toHaveLength(1)
      expect(getUsersByRole('operator')[0].id).toBe('user-1')
      expect(getUsersByRole('external')).toHaveLength(1)
      expect(getUsersByRole('external')[0].id).toBe('user-2')
    })
  })
})
