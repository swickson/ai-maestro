/**
 * AMP (Agent Messaging Protocol) Types
 *
 * Type definitions for implementing AMP protocol in AI Maestro.
 * Based on the AMP Protocol Specification v0.1.3
 *
 * AI Maestro acts as an AMP PROVIDER for local agents.
 * This enables three deployment scenarios:
 * - Solo Agent + External Provider (e.g., CrabMail)
 * - Air-Gapped Organization (AI Maestro only)
 * - Federated Organization (AI Maestro + External Providers)
 */

import type { AMPAgentIdentity, AMPExternalRegistration } from '@/types/agent'
import type { ServiceErrorCode, ServiceError } from '@/services/service-errors'

// Re-export for convenience
export type { AMPAgentIdentity, AMPExternalRegistration }

// ============================================================================
// Storage Configuration
// ============================================================================

/**
 * Relay TTL in days (default 7 per protocol spec, configurable via AMP_RELAY_TTL_DAYS env)
 */
export const AMP_RELAY_TTL_DAYS = parseInt(process.env.AMP_RELAY_TTL_DAYS || '7', 10)

/**
 * API key prefix format: amp_<environment>_<type>_<random>
 */
export const AMP_API_KEY_PREFIX = 'amp_live_sk_'

// ============================================================================
// Protocol Version
// ============================================================================

export const AMP_PROTOCOL_VERSION = '0.1.3'

/**
 * Default provider name (used when organization is not set)
 * @deprecated Use getAMPProviderDomain() instead for dynamic organization support
 */
export const AMP_PROVIDER_NAME = 'aimaestro.local'

/**
 * Default organization name when none is configured
 */
export const AMP_DEFAULT_ORGANIZATION = 'default'

/**
 * Get the AMP provider domain based on organization
 * Format: {organization}.aimaestro.local
 *
 * @param organization - Organization name (optional, reads from config if not provided)
 * @returns Provider domain string
 *
 * Note: This function is synchronous and returns a default if organization
 * is not available. For server-side usage with dynamic organization,
 * import getOrganization from hosts-config.ts
 */
export function getAMPProviderDomain(organization?: string): string {
  const org = organization || AMP_DEFAULT_ORGANIZATION
  return `${org}.aimaestro.local`
}

/**
 * Build an AMP address from components
 *
 * @param agentName - Agent name (e.g., "backend-api")
 * @param organization - Organization name (e.g., "acme-corp")
 * @returns Full AMP address (e.g., "backend-api@acme-corp.aimaestro.local")
 */
export function buildAMPAddress(agentName: string, organization?: string): string {
  const domain = getAMPProviderDomain(organization)
  return `${agentName}@${domain}`
}

/**
 * Parse an AMP address into components
 *
 * @param address - Full AMP address (e.g., "agent@org.aimaestro.local")
 * @returns Parsed components or null if invalid
 */
export function parseAMPAddress(address: string): {
  name: string
  organization: string
  provider: string
  full: string
} | null {
  const match = address.match(/^([^@]+)@([^.]+)\.(.+)$/)
  if (!match) return null

  return {
    name: match[1],
    organization: match[2],
    provider: match[3],
    full: address,
  }
}

// ============================================================================
// Message Envelope (Protocol Layer)
// ============================================================================

/**
 * AMP Message Envelope
 * Contains routing, authentication, and metadata for message delivery
 */
export interface AMPEnvelope {
  /** Protocol version (e.g., "amp/0.1") */
  version: string

  /** Unique message ID: msg_{timestamp}_{random} */
  id: string

  /** Sender's AMP address: name@tenant.provider */
  from: string

  /** Recipient's AMP address: name@tenant.provider */
  to: string

  /** Message subject */
  subject: string

  /** Message priority */
  priority: 'low' | 'normal' | 'high' | 'urgent'

  /** ISO 8601 timestamp */
  timestamp: string

  /** ISO 8601 expiration time; agents and providers SHOULD reject expired messages */
  expires_at?: string

  /** Ed25519 signature of canonical envelope (base64) */
  signature: string

  /** Original message ID if this is a reply */
  in_reply_to?: string

  /** Thread ID for conversation tracking (ID of first message in thread) */
  thread_id: string

  /** Cached return address for replies (avoids re-resolving sender) */
  reply_to?: string
}

/**
 * AMP Message Payload
 * The actual message content
 */
export interface AMPPayload {
  /** Content type */
  type: 'request' | 'response' | 'notification' | 'alert' | 'task' | 'status' | 'handoff' | 'ack' | 'update' | 'system'

  /** Main message body */
  message: string

  /** Structured context/metadata */
  context?: Record<string, unknown>

  /** File attachments (paths or URLs) */
  attachments?: AMPAttachment[]
}

/**
 * AMP Attachment — discriminated union (kanban b2ab2a77 + #48).
 *
 * - `legacy`: pre-#48 path/url shape, local-host-only by construction (no
 *   url is provider-signed). Federation MUST hard-reject + log per the
 *   deprecation horizon set at PR #48 merge.
 * - `amp-v1`: spec-compliant attachment with provider-signed URL,
 *   content_type, size, digest, scan_status, uploaded_at, expires_at.
 *   Cross-provider safe.
 *
 * Discriminator forces explicit handling at every callsite — field-presence
 * detection (path vs url) tends to silent shape drift.
 */
export type AMPAttachment = AMPAttachmentLegacy | AMPAttachmentV1

export interface AMPAttachmentLegacy {
  kind: 'legacy'
  name: string
  path?: string
  url?: string
  type: string
  size?: number
}

export interface AMPAttachmentV1 {
  kind: 'amp-v1'
  /** Provider-issued opaque identifier (att_xxx). Single-use per id. */
  id: string
  /** Sanitized filename (server-authoritative; [a-zA-Z0-9._-] only). */
  filename: string
  /** RFC-2046 content type from MIME sniff at confirm time. */
  content_type: string
  /** Bytes. Bounded by AMP_MAX_ATTACHMENT_BYTES (default 25MB). */
  size: number
  /** SHA-256 hex digest of the binary contents. Verifier computes and compares. */
  digest: string
  /** Provider-signed download URL (HMAC-signed, embeds expires_at + att_id). */
  url: string
  /**
   * Scan state. `basic_clean` is what /confirm emits today (MUSTs only,
   * no AV / injection — spec v0.1.2 §5 table line 429). `clean` is reserved
   * for a future SHOULD-tier scanner.
   */
  scan_status: 'pending' | 'clean' | 'basic_clean' | 'suspicious' | 'rejected'
  /** ISO-8601 upload completion timestamp. */
  uploaded_at: string
  /** ISO-8601 expiry. Spec mandates >=7 days from upload. Immutable post-routing. */
  expires_at: string
}

// ============================================================================
// Delivery Enrichment (Card B) — receiver-added, server-authoritative, UNSIGNED
// ============================================================================

/**
 * A single recalled memory item surfaced to the recipient. Mirrors the shape
 * agreed in the Card B contract (combined-proposal §3).
 */
export interface MemoryRecallItem {
  /** The recalled fact/snippet. */
  text: string
  /** 0..1 confidence; consumers MAY threshold/sort/hide low-confidence items. */
  confidence: number
  /** Times the memory has been reinforced, if the store tracks it. */
  reinforcement?: number
  /** Opaque memory id for trace/audit + cross-turn dedupe. */
  sourceId?: string
}

/**
 * Recipient-local memory recall, injected by THIS Maestro at delivery time.
 * Provenance is inline (recipientAgentId/injectedAt) so a consumer can render it
 * distinctly with no out-of-band knowledge.
 */
export interface MemoryRecall {
  /** Schema marker; an unknown future version => consumer ignores the object. */
  kind: 'memory-recall-v1'
  /** WHOSE memory this is (the recipient) — provenance. */
  recipientAgentId: string
  /** ISO-8601 Maestro stamp at injection (recipient clock, not the sender's). */
  injectedAt: string
  /** Advisory the consumer SHOULD surface verbatim if it renders recall. */
  advisory: string
  items: MemoryRecallItem[]
}

/**
 * Receiver-added advisory content, injected by the receiving Maestro at delivery
 * time. SERVER-AUTHORITATIVE and UNSIGNED by design (Card B §4a):
 *  - It sits OUTSIDE `payload`, so it is NOT covered by the sender Ed25519
 *    signature (canonical = from|to|subject|priority|in_reply_to|hash(payload))
 *    NOR by the outbound webhook HMAC (hash of {envelope, payload,
 *    sender_public_key}). Delivered `payload` therefore stays == signed payload.
 *  - A sender NEVER supplies `enrichment`; Maestro strips any inbound-supplied
 *    `enrichment` on `/route` and populates this field exclusively, server-side.
 *    Its trust derives entirely from the receiving Maestro owning the field —
 *    without that, an "outside the signature" object would be sender-forgeable
 *    provenance (worse than the in-band banner it replaces).
 * Purely additive + optional: a consumer that ignores it still gets the verbatim,
 * signature-valid body.
 */
export interface Enrichment {
  /** Absent when there is no recall for this delivery. */
  memoryRecall?: MemoryRecall
}

/**
 * Complete AMP Message (envelope + payload).
 *
 * `enrichment` is a top-level sibling of `envelope`/`payload` (NEVER nested under
 * either — nesting it under `envelope` would pull it into the webhook HMAC body,
 * and under `payload` into the sender signature). See {@link Enrichment}.
 */
export interface AMPMessage {
  envelope: AMPEnvelope
  payload: AMPPayload
  /** Receiver-added, server-authoritative, unsigned. Absent when no enrichment. */
  enrichment?: Enrichment
}

// ============================================================================
// Registration Types
// ============================================================================

/**
 * Registration request body
 * POST /v1/register
 */
export interface AMPRegistrationRequest {
  /** Client-provided agent UUID (offline-first identity). Server uses this if valid, generates one otherwise. */
  agent_id?: string

  /** Tenant/organization identifier */
  tenant: string

  /** Desired agent name (1-63 chars, alphanumeric + hyphens) */
  name: string

  /** PEM-encoded public key */
  public_key: string

  /** Key algorithm (Ed25519 recommended) */
  key_algorithm: 'Ed25519' | 'RSA' | 'ECDSA'

  /** Optional human-friendly display name */
  alias?: string

  /** Optional scope for namespacing */
  scope?: {
    platform?: string
    repo?: string
  }

  /** Message delivery configuration */
  delivery?: {
    webhook_url?: string
    webhook_secret?: string
    prefer_websocket?: boolean
  }

  /** Arbitrary metadata */
  metadata?: Record<string, unknown>

  /** Invite code for restricted tenants */
  invite_code?: string
}

/**
 * Registration response
 */
export interface AMPRegistrationResponse {
  /** Full AMP address: name@scope.tenant.provider */
  address: string

  /** Short address (if unique): name@tenant.provider */
  short_address: string

  /** Local name within tenant */
  local_name: string

  /** Internal agent ID */
  agent_id: string

  /** Tenant ID */
  tenant_id: string

  /** Tenant name (alias for tenant_id, for CLI compatibility) */
  tenant?: string

  /** API key (shown ONLY ONCE) */
  api_key: string

  /** Provider info */
  provider: {
    name: string
    endpoint: string
    /** Full URL for routing messages (POST). Clients MUST use this instead of hardcoding paths. */
    route_url: string
  }

  /** Public key fingerprint */
  fingerprint: string

  /** Registration timestamp */
  registered_at: string
}

// ============================================================================
// Relay Queue Types
// ============================================================================

/**
 * Message in the relay queue (waiting for pickup)
 */
export interface AMPPendingMessage {
  /** Message ID */
  id: string

  /** Full AMP message */
  envelope: AMPEnvelope
  payload: AMPPayload

  /** Sender's public key for verification */
  sender_public_key: string

  /** When queued */
  queued_at: string

  /** When message expires (TTL) */
  expires_at: string

  /** Delivery attempts */
  delivery_attempts?: number

  /** Last delivery attempt timestamp */
  last_attempt_at?: string
}

/**
 * Pending messages response
 * GET /v1/messages/pending
 */
export interface AMPPendingMessagesResponse {
  messages: AMPPendingMessage[]
  count: number
  remaining: number
}

// ============================================================================
// Route Types
// ============================================================================

/**
 * Route request body
 * POST /v1/route
 */
export interface AMPRouteRequest {
  /** Original sender address (used in mesh-forwarded requests) */
  from?: string

  /** Recipient address */
  to: string

  /** Message subject */
  subject: string

  /** Message priority */
  priority?: 'low' | 'normal' | 'high' | 'urgent'

  /** Reply reference */
  in_reply_to?: string

  /** ISO 8601 expiration time for the message */
  expires_at?: string

  /** Message payload */
  payload: AMPPayload

  /**
   * Client-provided Ed25519 signature (base64)
   * The server will VERIFY this signature, not create one.
   * Signature covers: id|from|to|subject|timestamp (pipe-delimited)
   */
  signature?: string

  /** Delivery options */
  options?: {
    /** Request delivery receipt */
    receipt?: boolean
  }

  /** Mesh forwarding metadata (added by forwarding host) */
  _forwarded?: {
    original_from: string
    original_to: string
    forwarded_by: string
    forwarded_url?: string
    forwarded_at: string
  }
}

/**
 * Route response
 */
export interface AMPRouteResponse {
  /** Message ID */
  id: string

  /** Delivery status */
  status: 'delivered' | 'queued' | 'failed'

  /** Delivery method used */
  method?: 'websocket' | 'webhook' | 'relay' | 'local' | 'mesh'

  /** Remote host ID (if delivered via mesh) */
  remote_host?: string

  /** Delivery timestamp (if delivered) */
  delivered_at?: string

  /** Queue timestamp (if queued) */
  queued_at?: string

  /** Error message (if failed or partial) */
  error?: string

  /** Informational note */
  note?: string
}

// ============================================================================
// Health & Info Types
// ============================================================================

/**
 * Health check response
 * GET /v1/health
 */
export interface AMPHealthResponse {
  status: 'healthy' | 'degraded' | 'unhealthy'
  version: string
  provider: string
  federation: boolean
  agents_online: number
  uptime_seconds: number
}

/**
 * Provider info response
 * GET /v1/info
 */
export interface AMPInfoResponse {
  provider: string
  version: string
  public_key?: string
  fingerprint?: string
  capabilities: string[]
  registration_modes: ('open' | 'invite' | 'verified' | 'admin')[]
  rate_limits: {
    messages_per_minute: number
    api_requests_per_minute: number
  }
}

// ============================================================================
// Error Types
// ============================================================================

/**
 * AMP error codes — subset of ServiceErrorCode covering the 18 AMP protocol codes.
 */
export type AMPErrorCode = Extract<ServiceErrorCode,
  | 'invalid_request'
  | 'missing_field'
  | 'invalid_field'
  | 'unauthorized'
  | 'forbidden'
  | 'not_found'
  | 'name_taken'
  | 'rate_limited'
  | 'internal_error'
  | 'invalid_signature'
  | 'agent_not_found'
  | 'tenant_access_denied'
  | 'organization_not_set'
  | 'external_provider'
  | 'payload_too_large'
  | 'missing_header'
  | 'duplicate_message'
  | 'key_already_registered'
>

/**
 * AMP error response — extends ServiceError with constrained error code.
 */
export interface AMPError extends ServiceError {
  error: AMPErrorCode
}

/**
 * Name taken error with suggestions (in details.suggestions)
 */
export interface AMPNameTakenError extends AMPError {
  error: 'name_taken'
  details: { suggestions: string[] }
}

// ============================================================================
// API Key Types
// ============================================================================

/**
 * Stored API key record (hashed for security)
 */
export interface AMPApiKeyRecord {
  /** API key hash (SHA-256) */
  key_hash: string

  /** Agent ID this key belongs to */
  agent_id: string

  /** Tenant ID */
  tenant_id: string

  /** Agent address */
  address: string

  /** Creation timestamp */
  created_at: string

  /** Expiration timestamp (null = never) */
  expires_at: string | null

  /** Last used timestamp */
  last_used_at?: string

  /** Key status */
  status: 'active' | 'revoked' | 'expired'
}

/**
 * Key rotation response
 */
export interface AMPKeyRotationResponse {
  api_key: string
  expires_at: string | null
  previous_key_valid_until: string
}

/**
 * Keypair rotation request (proof-of-possession)
 *
 * POST /v1/auth/rotate-keys
 * Agent provides new public key + proof (new key signed with old private key).
 * If body is omitted, server falls back to server-side key generation (backward compat).
 */
export interface AMPKeypairRotationRequest {
  /** PEM-encoded Ed25519 public key */
  new_public_key: string

  /** Key algorithm — must be 'Ed25519' */
  key_algorithm: 'Ed25519'

  /** Base64-encoded proof: sign(new_public_key_hex, old_private_key) */
  proof: string
}

// ============================================================================
// Agent Management Types
// ============================================================================

/**
 * Agent info returned by /v1/agents/me
 */
export interface AMPAgentInfo {
  address: string
  alias?: string
  delivery?: {
    webhook_url?: string
    prefer_websocket?: boolean
  }
  fingerprint: string
  registered_at: string
  last_seen_at?: string
}

/**
 * Agent update request
 * PATCH /v1/agents/me
 */
export interface AMPAgentUpdateRequest {
  alias?: string
  delivery?: {
    webhook_url?: string
    webhook_secret?: string
    prefer_websocket?: boolean
  }
  metadata?: Record<string, unknown>
}

/**
 * Agent list item (search/list results)
 */
export interface AMPAgentListItem {
  address: string
  alias?: string
  online: boolean
}

/**
 * Resolve agent response
 * GET /v1/agents/resolve/:address
 */
export interface AMPAgentResolveResponse {
  address: string
  alias?: string
  public_key: string
  key_algorithm: 'Ed25519' | 'RSA' | 'ECDSA'
  fingerprint: string
  online: boolean
}

// ============================================================================
// Federation Types
// ============================================================================

/**
 * Federation delivery request
 * POST /v1/federation/deliver
 */
export interface AMPFederationDeliveryRequest {
  envelope: AMPEnvelope
  payload: AMPPayload
  sender_public_key: string
}

/**
 * Federation delivery response
 */
export interface AMPFederationDeliveryResponse {
  accepted: boolean
  id: string
  delivered: boolean
}

/**
 * Federation headers
 */
export interface AMPFederationHeaders {
  'X-AMP-Provider': string
  'X-AMP-Signature': string
  'X-AMP-Timestamp': string
}

// ============================================================================
// WebSocket Types
// ============================================================================

/**
 * WebSocket message types (client → server)
 */
export type AMPWSClientMessageType = 'auth' | 'ping' | 'route' | 'ack'

/**
 * WebSocket message types (server → client)
 */
export type AMPWSServerMessageType =
  | 'pong'
  | 'connected'
  | 'message.new'
  | 'message.delivered'
  | 'message.read'
  | 'error'

/**
 * WebSocket auth message (client → server)
 */
export interface AMPWSAuthMessage {
  type: 'auth'
  token: string
}

/**
 * WebSocket connected response (server → client)
 */
export interface AMPWSConnectedMessage {
  type: 'connected'
  data: {
    address: string
    pending_count: number
  }
}

/**
 * WebSocket new message notification
 */
export interface AMPWSNewMessage {
  type: 'message.new'
  data: {
    id: string
    envelope: AMPEnvelope
    payload: AMPPayload
  }
}

/**
 * WebSocket delivery confirmation
 */
export interface AMPWSDeliveredMessage {
  type: 'message.delivered'
  data: {
    id: string
    to: string
    delivered_at: string
    method: 'websocket' | 'webhook' | 'relay'
  }
}
