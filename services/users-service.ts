/**
 * Users Service
 *
 * Pure business logic for the User Directory.
 * No HTTP concepts (Request, Response, NextResponse) leak into this module.
 * API routes are thin wrappers that call these functions.
 *
 * Covers:
 *   GET    /api/users                                 -> listAllUsers
 *   POST   /api/users                                 -> createNewUser
 *   GET    /api/users/[id]                            -> getUserById
 *   PATCH  /api/users/[id]                            -> updateUserById
 *   DELETE /api/users/[id]                            -> deleteUserById
 *   GET    /api/users/resolve?alias=...               -> resolveUser
 *   GET    /api/users/resolve?platform=...&platformUserId=... -> resolveUser
 *   GET    /api/users/resolve?displayName=...         -> resolveUser
 */

import {
  loadUsers,
  createUser,
  getUser,
  updateUser,
  deleteUser,
  getUserByAlias,
  getUserByPlatform,
  getUserByDisplayName,
  getUsersByRole,
} from '@/lib/user-directory'
import type { CreateUserParams, UpdateUserParams, UserRole, UserRecord, UserPlatformMapping } from '@/types/user'
import { getHostById, getPeerHosts } from '@/lib/hosts-config'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ServiceResult<T> {
  data?: T
  error?: string
  status: number
}

// ─── List / Create ──────────────────────────────────────────────────────────

/**
 * List all users, optionally filtered by role.
 */
export function listAllUsers(role?: string): ServiceResult<{ users: any[] }> {
  if (role) {
    if (role !== 'operator' && role !== 'external') {
      return { error: 'Invalid role. Must be "operator" or "external"', status: 400 }
    }
    const users = getUsersByRole(role as UserRole)
    return { data: { users }, status: 200 }
  }
  const users = loadUsers()
  return { data: { users }, status: 200 }
}

/**
 * Create a new user.
 */
export function createNewUser(params: CreateUserParams): ServiceResult<{ user: any }> {
  if (!params.displayName || typeof params.displayName !== 'string') {
    return { error: 'displayName is required', status: 400 }
  }

  if (params.aliases && !Array.isArray(params.aliases)) {
    return { error: 'aliases must be an array of strings', status: 400 }
  }

  if (params.platforms && !Array.isArray(params.platforms)) {
    return { error: 'platforms must be an array', status: 400 }
  }

  if (params.role && params.role !== 'operator' && params.role !== 'external') {
    return { error: 'role must be "operator" or "external"', status: 400 }
  }

  try {
    const user = createUser(params)
    return { data: { user }, status: 201 }
  } catch (error) {
    console.error('[UsersService] Failed to create user:', error)
    return { error: error instanceof Error ? error.message : 'Failed to create user', status: 500 }
  }
}

// ─── Get / Update / Delete ──────────────────────────────────────────────────

export function findUserById(id: string): ServiceResult<{ user: any }> {
  const user = getUser(id)
  if (!user) {
    return { error: 'User not found', status: 404 }
  }
  return { data: { user }, status: 200 }
}

export function updateUserById(id: string, params: UpdateUserParams): ServiceResult<{ user: any }> {
  try {
    const user = updateUser(id, params)
    if (!user) {
      return { error: 'User not found', status: 404 }
    }
    return { data: { user }, status: 200 }
  } catch (error) {
    console.error('[UsersService] Failed to update user:', error)
    return { error: error instanceof Error ? error.message : 'Failed to update user', status: 500 }
  }
}

export function deleteUserById(id: string): ServiceResult<{ success: boolean }> {
  const deleted = deleteUser(id)
  if (!deleted) {
    return { error: 'User not found', status: 404 }
  }
  return { data: { success: true }, status: 200 }
}

// ─── Resolve ────────────────────────────────────────────────────────────────

export interface ResolveParams {
  alias?: string
  platform?: string
  platformUserId?: string
  displayName?: string
}

/**
 * Resolve a user by alias, platform identity, or display name.
 * Returns 404 with { error: 'user_not_found' } for unknown users —
 * gateways handle every inbound message through this endpoint.
 */
export function resolveUser(params: ResolveParams): ServiceResult<{ user: any }> {
  // Resolve by alias
  if (params.alias) {
    const user = getUserByAlias(params.alias)
    if (!user) {
      return { error: 'user_not_found', status: 404 }
    }
    return { data: { user }, status: 200 }
  }

  // Resolve by platform + platformUserId
  if (params.platform && params.platformUserId) {
    const user = getUserByPlatform(params.platform, params.platformUserId)
    if (!user) {
      return { error: 'user_not_found', status: 404 }
    }
    return { data: { user }, status: 200 }
  }

  // Resolve by display name
  if (params.displayName) {
    const user = getUserByDisplayName(params.displayName)
    if (!user) {
      return { error: 'user_not_found', status: 404 }
    }
    return { data: { user }, status: 200 }
  }

  return { error: 'At least one of alias, platform+platformUserId, or displayName is required', status: 400 }
}

// ─── Auto-Create ───────────────────────────────────────────────────────────

export interface AutoCreateParams {
  platform: string
  platformUserId: string
  handle?: string
  context?: Record<string, unknown>
}

/**
 * Auto-create an external user from a gateway's first-contact event.
 * If the user already exists (by platform+platformUserId), returns the existing record.
 */
export function autoCreateExternalUser(params: AutoCreateParams): ServiceResult<{ user: any; created: boolean }> {
  if (!params.platform || !params.platformUserId) {
    return { error: 'platform and platformUserId are required', status: 400 }
  }

  // Check if user already exists
  const existing = getUserByPlatform(params.platform, params.platformUserId)
  if (existing) {
    return { data: { user: existing, created: false }, status: 200 }
  }

  try {
    const handle = params.handle || params.platformUserId
    const user = createUser({
      displayName: handle,
      aliases: [handle.toLowerCase()],
      platforms: [{
        type: params.platform,
        platformUserId: params.platformUserId,
        handle,
        context: params.context,
      }],
      role: 'external',
      trustLevel: 'none',
    })
    return { data: { user, created: true }, status: 201 }
  } catch (error) {
    console.error('[UsersService] Failed to auto-create external user:', error)
    return { error: error instanceof Error ? error.message : 'Failed to auto-create user', status: 500 }
  }
}

// ─── Last Seen ─────────────────────────────────────────────────────────────

/**
 * Touch a user's platform presence on inbound.
 *
 * Bumps lastSeenPerPlatform[platform] (merge-safe — preserves every other
 * platform's timestamp), and, when a context patch is supplied, DEEP-MERGES it
 * into the matching platform mapping's `context`. The mapping is matched by
 * `type === platform` (and `platformUserId` when given), and only that entry is
 * rewritten — all other mappings and the matched mapping's other fields are
 * preserved. updateUser() is a shallow top-level spread, so we hand it the full
 * platforms array with just the one entry merged.
 *
 * Used by gateways on every inbound message. Teams (multi-bot on one port) sends
 * `{ platform:'teams', platformUserId:<aad>, context:{ botSlug } }` so the stored
 * context.botSlug refreshes to the latest bot each contact. This still drives
 * reply/thread resolution and the gateway's single-bot reuse, but is NO LONGER the
 * proactive-DM bot selector: notifyUser no longer falls back to it (that recency
 * guess mis-attributed multi-bot DMs — see notifyUser), so an unpinned proactive DM
 * is forwarded with an absent botSlug and the gateway arbitrates.
 */
export function updateLastSeen(
  userId: string,
  platform: string,
  options?: { platformUserId?: string; context?: Record<string, unknown> }
): ServiceResult<{ success: boolean }> {
  if (!platform) {
    return { error: 'platform is required', status: 400 }
  }
  const user = getUser(userId)
  if (!user) {
    return { error: 'User not found', status: 404 }
  }

  const lastSeenPerPlatform = { ...user.lastSeenPerPlatform, [platform]: new Date().toISOString() }
  const updates: UpdateUserParams = { lastSeenPerPlatform }

  // Optional targeted context merge (e.g. Teams botSlug refresh).
  if (options?.context && user.platforms?.length) {
    const matchIdx = user.platforms.findIndex(p =>
      p.type === platform &&
      (!options.platformUserId || p.platformUserId === options.platformUserId)
    )
    if (matchIdx !== -1) {
      const existing = user.platforms[matchIdx]
      const merged: UserPlatformMapping = {
        ...existing,
        context: { ...(existing.context || {}), ...options.context },
      }
      updates.platforms = [
        ...user.platforms.slice(0, matchIdx),
        merged,
        ...user.platforms.slice(matchIdx + 1),
      ]
    }
  }

  const updated = updateUser(userId, updates)
  if (!updated) {
    return { error: 'Failed to update user', status: 500 }
  }
  return { data: { success: true }, status: 200 }
}

// ─── Outbound Notify ───────────────────────────────────────────────────────

/**
 * Gateway DM endpoint by platform type — where to POST a proactive DM.
 * Each platform's gateway runs on its own port on the same host (discord 3023,
 * teams 3024). The bot identity for multi-bot platforms is NOT encoded here
 * (it's per-user) — it travels in the request body as botSlug.
 */
const GATEWAY_DM_ENDPOINTS: Record<string, { port: string; path: string }> = {
  discord: { port: process.env.DISCORD_GATEWAY_PORT || process.env.GATEWAY_PORT || '3023', path: '/api/gateway/dm' },
  teams: { port: process.env.TEAMS_GATEWAY_PORT || '3024', path: '/api/gateway/dm' },
}

/**
 * Send a notification to a user via their preferred platform.
 * Resolves user -> finds platform mapping -> routes to gateway DM endpoint.
 *
 * Resolution chain: preferred platform -> any available platform.
 */
export async function notifyUser(
  userId: string,
  message: string,
  options?: { platform?: string; subject?: string; botSlug?: string }
): Promise<ServiceResult<{ success: boolean; platform?: string; method?: string }>> {
  const user = getUser(userId)
  if (!user) {
    return { error: 'User not found', status: 404 }
  }

  if (!user.platforms || user.platforms.length === 0) {
    return { error: 'User has no platform mappings', status: 422 }
  }

  // Pick platform: explicit > preferred > first available
  let targetMapping: UserPlatformMapping | undefined
  if (options?.platform) {
    targetMapping = user.platforms.find(p => p.type === options.platform)
  }
  if (!targetMapping && user.preferredPlatform) {
    targetMapping = user.platforms.find(p => p.type === user.preferredPlatform)
  }
  if (!targetMapping) {
    targetMapping = user.platforms[0]
  }

  const endpoint = GATEWAY_DM_ENDPOINTS[targetMapping.type]
  if (!endpoint) {
    return { error: `No gateway DM endpoint configured for platform: ${targetMapping.type}`, status: 422 }
  }

  // Gateway runs on the same host as Maestro, on its per-platform port.
  const gatewayUrl = `http://localhost:${endpoint.port}${endpoint.path}`
  // Multi-bot platforms (Teams) need to know which bot to deliver as. We pass through
  // ONLY an explicit options.botSlug — the caller TARGETS a specific bot (e.g. a
  // proactive DM that must send as its own bot, not as whichever bot last had inbound).
  // We deliberately do NOT fall back to the per-user mapping context.botSlug
  // (most-recently-inbound bot): that recency guess MIS-ATTRIBUTES a botSlug-less
  // proactive DM through the wrong bot for any user who talks to multiple bots, and
  // because notifyUser pre-filled a non-empty botSlug, the gateway's "absent botSlug +
  // multi-bot -> 409" guard could never fire on this path. Passing undefined when
  // unpinned makes the gateway the SINGLE arbiter: it 409s an unpinned multi-bot send
  // and reuses the lone live bot for a single-bot user (gateway dm.ts). notifyUser
  // can't cheaply know multi-bot-ness anyway (context holds only a single recency
  // slug), so the gateway is the right place to decide. undefined is dropped by
  // JSON.stringify, preserving body shape. (multi-bot mis-attribution fix)
  const botSlug = options?.botSlug
  // Teams cold-start DM (#13): the gateway needs the tenant to createConversation
  // for a user it has never DM'd. tenantId is captured per-user on the mapping
  // context on inbound (auto-create / updateLastSeen store it). Same shape as
  // botSlug — undefined for single-tenant platforms and dropped by JSON.stringify.
  const tenantId = (targetMapping.context as { tenantId?: string } | undefined)?.tenantId

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 10000)

    const response = await fetch(gatewayUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.ADMIN_TOKEN || ''}`,
      },
      body: JSON.stringify({
        platformUserId: targetMapping.platformUserId,
        botSlug,
        tenantId,
        message,
        subject: options?.subject,
      }),
      signal: controller.signal,
    })
    clearTimeout(timeoutId)

    if (!response.ok) {
      const errBody = await response.json().catch(() => ({}))
      return {
        error: (errBody as any).error || `Gateway returned ${response.status}`,
        status: 502,
      }
    }

    const result = await response.json()
    return {
      data: {
        success: true,
        platform: targetMapping.type,
        method: 'gateway-dm',
        ...(result as any),
      },
      status: 200,
    }
  } catch (err) {
    return {
      error: `Gateway DM delivery failed: ${err instanceof Error ? err.message : String(err)}`,
      status: 502,
    }
  }
}
