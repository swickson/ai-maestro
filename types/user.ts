/**
 * User Directory Types
 *
 * Centralized contact directory for identity resolution and
 * outbound message routing across AI Maestro gateways.
 *
 * Users are NOT auth principals — Maestro stays single-operator.
 * This is a contact directory for routing and identity resolution.
 */

/**
 * User role in the system
 * - operator: The human running the Maestro instance (full trust)
 * - external: Someone who messages in from a platform (no trust by default)
 */
export type UserRole = 'operator' | 'external'

/**
 * Trust level for message handling
 * - full: Messages are processed without restriction
 * - none: Messages may be filtered or require approval
 */
export type UserTrustLevel = 'full' | 'none'

/**
 * Platform-specific identity mapping
 * Links an internal user to their account on an external platform.
 */
export interface UserPlatformMapping {
  type: string                    // Platform identifier: 'discord', 'slack', 'email', etc.
  platformUserId: string          // Platform-native user ID
  handle: string                  // Platform display name / username
  context?: Record<string, unknown> // Platform-specific metadata (guildIds, workspaceId, etc.)
}

/**
 * Notification preferences by priority level
 */
export interface NotificationPreferences {
  urgent?: string[]               // Escalation chain for urgent messages
  normal?: string[]               // Default notification channels
  digest?: string[]               // Digest/summary channels
}

/**
 * Core user record in the directory
 */
export interface UserRecord {
  id: string                      // UUID v4
  displayName: string             // Human-readable name (e.g., "Shane Wickson")
  aliases: string[]               // Cross-host nicknames, case-insensitive match
  platforms: UserPlatformMapping[] // One entry per platform account
  role: UserRole
  trustLevel: UserTrustLevel
  preferredPlatform?: string      // Default outbound channel
  notificationPreferences?: NotificationPreferences
  createdAt: string               // ISO
  updatedAt: string               // ISO
  lastSeenPerPlatform?: Record<string, string> // platform type -> ISO timestamp
}

/**
 * File format for ~/.aimaestro/users/directory.json
 */
export interface UserDirectoryFile {
  version: 1
  users: UserRecord[]
}

/**
 * Parameters for creating a new user
 */
export interface CreateUserParams {
  displayName: string
  aliases?: string[]
  platforms?: UserPlatformMapping[]
  role?: UserRole
  trustLevel?: UserTrustLevel
  preferredPlatform?: string
  notificationPreferences?: NotificationPreferences
}

/**
 * Parameters for updating an existing user
 */
export interface UpdateUserParams {
  displayName?: string
  aliases?: string[]
  platforms?: UserPlatformMapping[]
  role?: UserRole
  trustLevel?: UserTrustLevel
  preferredPlatform?: string
  notificationPreferences?: NotificationPreferences
  lastSeenPerPlatform?: Record<string, string>
}
