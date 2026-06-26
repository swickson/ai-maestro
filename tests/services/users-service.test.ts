/**
 * Users Service — Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the user directory module
vi.mock('@/lib/user-directory', () => {
  const users = [
    {
      id: 'user-1',
      displayName: 'the operator',
      aliases: ['<user>', 'operator'],
      platforms: [
        { type: 'discord', platformUserId: '123', handle: '<user>' },
        { type: 'teams', platformUserId: 'aad-xyz', handle: 'the operator', context: { tenantId: 't1', botSlug: 'bot-alpha' } },
      ],
      role: 'operator',
      trustLevel: 'full',
      lastSeenPerPlatform: { discord: '2026-01-01T00:00:00Z' },
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
  updateLastSeen,
  notifyUser,
} from '@/services/users-service'
import * as directory from '@/lib/user-directory'

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
      expect(result.data?.user.displayName).toBe('the operator')
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
      const result = resolveUser({ alias: '<user>' })
      expect(result.status).toBe(200)
      expect(result.data?.user.id).toBe('user-1')
    })

    it('resolves by platform', () => {
      const result = resolveUser({ platform: 'discord', platformUserId: '123' })
      expect(result.status).toBe(200)
      expect(result.data?.user.id).toBe('user-1')
    })

    it('resolves by displayName', () => {
      const result = resolveUser({ displayName: 'the operator' })
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

  describe('updateLastSeen', () => {
    beforeEach(() => vi.clearAllMocks())

    it('rejects missing platform', () => {
      const result = updateLastSeen('user-1', '')
      expect(result.status).toBe(400)
    })

    it('returns 404 for unknown user', () => {
      const result = updateLastSeen('nonexistent', 'teams')
      expect(result.status).toBe(404)
    })

    it('bumps lastSeen merge-safe, preserving other platforms timestamps', () => {
      const result = updateLastSeen('user-1', 'teams')
      expect(result.status).toBe(200)
      const updates = vi.mocked(directory.updateUser).mock.calls[0][1]
      // existing discord timestamp preserved + teams freshly stamped
      expect(updates.lastSeenPerPlatform).toHaveProperty('discord', '2026-01-01T00:00:00Z')
      expect(updates.lastSeenPerPlatform).toHaveProperty('teams')
      // no context patch => platforms array untouched
      expect(updates.platforms).toBeUndefined()
    })

    it('deep-merges context into the matching mapping, preserving its other fields and other mappings', () => {
      const result = updateLastSeen('user-1', 'teams', {
        platformUserId: 'aad-xyz',
        context: { botSlug: 'bot-beta' },
      })
      expect(result.status).toBe(200)
      const updates = vi.mocked(directory.updateUser).mock.calls[0][1]
      const teams = updates.platforms!.find(p => p.type === 'teams')!
      // botSlug refreshed to latest bot, tenantId preserved
      expect(teams.context).toEqual({ tenantId: 't1', botSlug: 'bot-beta' })
      expect(teams.platformUserId).toBe('aad-xyz')
      expect(teams.handle).toBe('the operator')
      // discord mapping untouched
      const discord = updates.platforms!.find(p => p.type === 'discord')!
      expect(discord.platformUserId).toBe('123')
      expect(discord.context).toBeUndefined()
    })

    it('still bumps lastSeen when context has no matching mapping (no platforms rewrite)', () => {
      const result = updateLastSeen('user-1', 'teams', {
        platformUserId: 'aad-DIFFERENT',
        context: { botSlug: 'bot-beta' },
      })
      expect(result.status).toBe(200)
      const updates = vi.mocked(directory.updateUser).mock.calls[0][1]
      expect(updates.lastSeenPerPlatform).toHaveProperty('teams')
      expect(updates.platforms).toBeUndefined()
    })
  })

  describe('notifyUser gateway routing', () => {
    let fetchMock: ReturnType<typeof vi.fn>

    beforeEach(() => {
      vi.clearAllMocks()
      fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({}) }))
      vi.stubGlobal('fetch', fetchMock)
    })

    it('routes teams to port 3024; unpinned send OMITS botSlug (no recency pre-fill) but still carries tenantId', async () => {
      // Multi-bot mis-attribution fix: an unpinned proactive DM must NOT be pre-filled
      // with context.botSlug (most-recently-inbound bot). It posts an ABSENT botSlug so
      // the gateway is the single arbiter (409 for multi-bot, reuse for single-bot).
      const result = await notifyUser('user-1', 'hi', { platform: 'teams' })
      expect(result.status).toBe(200)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('http://localhost:3024/api/gateway/dm')
      const body = JSON.parse(init.body)
      expect(body.platformUserId).toBe('aad-xyz')
      expect('botSlug' in body).toBe(false)        // NOT pre-filled with 'bot-alpha'
      // tenantId is independent of the botSlug fallback (still needed for cold-start
      // createConversation) and continues to reach the gateway.
      expect(body.tenantId).toBe('t1')
    })

    it('routes discord to port 3023 and omits botSlug + tenantId (single-bot/tenant platform)', async () => {
      const result = await notifyUser('user-1', 'hi', { platform: 'discord' })
      expect(result.status).toBe(200)
      const [url, init] = fetchMock.mock.calls[0]
      expect(url).toBe('http://localhost:3023/api/gateway/dm')
      const body = JSON.parse(init.body)
      expect(body.platformUserId).toBe('123')
      expect('botSlug' in body).toBe(false)
      // No tenantId on the discord mapping context → dropped from the body
      // (JSON.stringify omits undefined), preserving the single-tenant shape.
      expect('tenantId' in body).toBe(false)
    })

    it('explicit options.botSlug TARGETS that bot, overriding context.botSlug (#13 cold-start)', async () => {
      // Proactive DM that must send as a specific bot (e.g. an agent) rather than
      // whichever bot last had inbound — this is what drives a gateway cold-start.
      const result = await notifyUser('user-1', 'hi', { platform: 'teams', botSlug: 'leoai' })
      expect(result.status).toBe(200)
      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect(body.botSlug).toBe('leoai')          // override, NOT 'bot-alpha'
      expect(body.tenantId).toBe('t1')            // tenantId still carried (one per mapping)
    })

    it('does NOT fall back to context.botSlug even when a recency slug exists (multi-bot mis-attribution fix)', async () => {
      // user-1's teams context carries botSlug 'bot-alpha' (most-recently-inbound bot).
      // Pre-fix this leaked into the body and defeated the gateway's absent->409 guard,
      // mis-attributing the DM through the wrong bot. Now an unpinned send omits botSlug.
      const result = await notifyUser('user-1', 'hi', { platform: 'teams' })
      expect(result.status).toBe(200)
      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect('botSlug' in body).toBe(false)
      expect(body.botSlug).toBeUndefined()
    })

    it('cold-start (no recency slug in context) also omits botSlug, tenantId still carried', async () => {
      // A never-DM'd user: tenantId captured on auto-create, but no context.botSlug
      // (recency slug is only written on inbound). Dropping the fallback does not
      // regress cold-start — there was no recency value to send anyway, and the gateway
      // already requires a pinned botSlug to createConversation.
      vi.mocked(directory.getUser).mockReturnValueOnce({
        id: 'cold-user',
        displayName: 'never-dmed operator',
        aliases: ['coldstart'],
        platforms: [
          { type: 'teams', platformUserId: 'aad-cold', handle: 'x', context: { tenantId: 't1' } },
        ],
        role: 'operator',
        trustLevel: 'full',
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      } as any)
      const result = await notifyUser('cold-user', 'hi', { platform: 'teams' })
      expect(result.status).toBe(200)
      const body = JSON.parse(fetchMock.mock.calls[0][1].body)
      expect('botSlug' in body).toBe(false)
      expect(body.tenantId).toBe('t1')
    })
  })
})
