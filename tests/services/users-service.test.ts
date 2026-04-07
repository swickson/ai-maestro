/**
 * Users Service — Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the user directory module
vi.mock('@/lib/user-directory', () => {
  const users = [
    {
      id: 'user-1',
      displayName: 'Shane Wickson',
      aliases: ['gosub', 'shane'],
      platforms: [
        { type: 'discord', platformUserId: '123', handle: 'gosub' },
      ],
      role: 'operator',
      trustLevel: 'full',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'user-2',
      displayName: 'External User',
      aliases: ['ext'],
      platforms: [],
      role: 'external',
      trustLevel: 'none',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    },
  ]

  return {
    loadUsers: vi.fn(() => users),
    createUser: vi.fn((params: any) => ({
      id: 'new-uuid',
      ...params,
      aliases: params.aliases || [],
      platforms: params.platforms || [],
      role: params.role || 'external',
      trustLevel: params.trustLevel || 'none',
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })),
    getUser: vi.fn((id: string) => users.find(u => u.id === id) || null),
    updateUser: vi.fn((id: string, updates: any) => {
      const user = users.find(u => u.id === id)
      if (!user) return null
      return { ...user, ...updates, updatedAt: '2026-01-02T00:00:00Z' }
    }),
    deleteUser: vi.fn((id: string) => users.some(u => u.id === id)),
    getUserByAlias: vi.fn((alias: string) => {
      const lower = alias.toLowerCase()
      return users.find(u => u.aliases.some((a: string) => a.toLowerCase() === lower)) || null
    }),
    getUserByPlatform: vi.fn((type: string, userId: string) => {
      return users.find(u =>
        u.platforms.some((p: any) => p.type === type && p.platformUserId === userId)
      ) || null
    }),
    getUserByDisplayName: vi.fn((name: string) => {
      const lower = name.toLowerCase()
      return users.find(u => u.displayName.toLowerCase() === lower) || null
    }),
    getUsersByRole: vi.fn((role: string) => users.filter(u => u.role === role)),
  }
})

import {
  listAllUsers,
  createNewUser,
  findUserById,
  updateUserById,
  deleteUserById,
  resolveUser,
} from '@/services/users-service'

describe('users-service', () => {
  describe('listAllUsers', () => {
    it('returns all users without filter', () => {
      const result = listAllUsers()
      expect(result.status).toBe(200)
      expect(result.data?.users).toHaveLength(2)
    })

    it('filters by role', () => {
      const result = listAllUsers('operator')
      expect(result.status).toBe(200)
      expect(result.data?.users).toHaveLength(1)
    })

    it('rejects invalid role', () => {
      const result = listAllUsers('admin')
      expect(result.status).toBe(400)
      expect(result.error).toContain('Invalid role')
    })
  })

  describe('createNewUser', () => {
    it('creates a user with valid params', () => {
      const result = createNewUser({ displayName: 'New Person' })
      expect(result.status).toBe(201)
      expect(result.data?.user.displayName).toBe('New Person')
    })

    it('rejects missing displayName', () => {
      const result = createNewUser({ displayName: '' })
      expect(result.status).toBe(400)
    })

    it('rejects invalid role', () => {
      const result = createNewUser({ displayName: 'X', role: 'admin' as any })
      expect(result.status).toBe(400)
    })
  })

  describe('findUserById', () => {
    it('returns user when found', () => {
      const result = findUserById('user-1')
      expect(result.status).toBe(200)
      expect(result.data?.user.displayName).toBe('Shane Wickson')
    })

    it('returns 404 when not found', () => {
      const result = findUserById('nonexistent')
      expect(result.status).toBe(404)
    })
  })

  describe('updateUserById', () => {
    it('updates existing user', () => {
      const result = updateUserById('user-1', { displayName: 'Updated' })
      expect(result.status).toBe(200)
      expect(result.data?.user.displayName).toBe('Updated')
    })

    it('returns 404 for unknown user', () => {
      const result = updateUserById('nonexistent', { displayName: 'X' })
      expect(result.status).toBe(404)
    })
  })

  describe('deleteUserById', () => {
    it('deletes existing user', () => {
      const result = deleteUserById('user-1')
      expect(result.status).toBe(200)
      expect(result.data?.success).toBe(true)
    })

    it('returns 404 for unknown user', () => {
      const result = deleteUserById('nonexistent')
      expect(result.status).toBe(404)
    })
  })

  describe('resolveUser', () => {
    it('resolves by alias', () => {
      const result = resolveUser({ alias: 'gosub' })
      expect(result.status).toBe(200)
      expect(result.data?.user.id).toBe('user-1')
    })

    it('resolves by platform', () => {
      const result = resolveUser({ platform: 'discord', platformUserId: '123' })
      expect(result.status).toBe(200)
      expect(result.data?.user.id).toBe('user-1')
    })

    it('resolves by displayName', () => {
      const result = resolveUser({ displayName: 'Shane Wickson' })
      expect(result.status).toBe(200)
      expect(result.data?.user.id).toBe('user-1')
    })

    it('returns 404 for unknown alias', () => {
      const result = resolveUser({ alias: 'nobody' })
      expect(result.status).toBe(404)
      expect(result.error).toBe('user_not_found')
    })

    it('returns 400 when no params provided', () => {
      const result = resolveUser({})
      expect(result.status).toBe(400)
    })
  })
})
