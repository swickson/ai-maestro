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
import type { CreateUserParams, UpdateUserParams, UserRole } from '@/types/user'

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
