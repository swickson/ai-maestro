/**
 * AMP attachment signed-URL helper.
 *
 * Spec §1: `url` is provider-signed; "no authentication required for
 * cross-provider access." Pattern is S3-presigned-URL style — opaque token
 * embedded in query string, server validates server-side at request time.
 *
 * Implementation: HMAC-SHA256 over canonical-stringified payload of
 * {att_id, action, expires_at}, secret = AMP_ATTACHMENT_SIGNING_SECRET env
 * (auto-generated + persisted to ~/.aimaestro/attachment-signing-secret on
 * first use). Token = base64url(HMAC). Query: ?sig=<token>&exp=<unix-ms>.
 *
 * Single-use is enforced at the storage layer by transitioning meta.scan_status
 * away from `pending` on confirm — the signed URL stays valid for `expires_at`
 * but the underlying blob enforces single-action semantics.
 *
 * Uses canonicalStringify (PR #114) for the signing input so any compliant
 * peer that re-canonicalizes for verification matches our signature.
 */

import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { canonicalStringify } from '@/lib/amp-canonical-json'

const SECRET_PATH = path.join(os.homedir(), '.aimaestro', 'attachment-signing-secret')

function loadOrCreateSecret(): Buffer {
  const envSecret = process.env.AMP_ATTACHMENT_SIGNING_SECRET
  if (envSecret && envSecret.length >= 32) {
    return Buffer.from(envSecret, 'utf-8')
  }
  try {
    return Buffer.from(fs.readFileSync(SECRET_PATH, 'utf-8').trim(), 'hex')
  } catch {
    // First-use: mint a 32-byte secret + persist
    const secret = crypto.randomBytes(32)
    fs.mkdirSync(path.dirname(SECRET_PATH), { recursive: true, mode: 0o700 })
    fs.writeFileSync(SECRET_PATH, secret.toString('hex'), { mode: 0o600 })
    return secret
  }
}

export type SignableAction = 'upload' | 'download'

export interface SignedTokenPayload {
  action: SignableAction
  att_id: string
  exp: number // unix ms
}

export function signToken(payload: SignedTokenPayload): string {
  const secret = loadOrCreateSecret()
  // Canonical-stringify so re-derivation by recipient matches byte-for-byte.
  const canonical = canonicalStringify(payload)
  return crypto.createHmac('sha256', secret).update(canonical).digest('base64url')
}

export function verifyToken(payload: SignedTokenPayload, providedSig: string): boolean {
  const expected = signToken(payload)
  if (expected.length !== providedSig.length) return false
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(providedSig))
}

/**
 * Build the absolute signed URL for an attachment action. The host portion
 * comes from the request — the upload + download routes both expose this so
 * the federated recipient can fetch from the origin host.
 */
export function buildSignedUrl(
  baseUrl: string,
  action: SignableAction,
  attId: string,
  expiresAtIso: string,
): string {
  const exp = new Date(expiresAtIso).getTime()
  const sig = signToken({ action, att_id: attId, exp })
  const pathSuffix = action === 'upload' ? `/api/v1/attachments/${attId}` : `/api/v1/attachments/${attId}/download`
  return `${baseUrl}${pathSuffix}?sig=${sig}&exp=${exp}`
}

/**
 * Validate a signed URL request. Returns null if valid, an error string if not.
 * Caller checks for null and proceeds; non-null is a 401/403 reason.
 */
export function verifySignedRequest(
  action: SignableAction,
  attId: string,
  providedSig: string | null,
  providedExp: string | null,
): string | null {
  if (!providedSig || !providedExp) return 'missing signature parameters'
  const exp = parseInt(providedExp, 10)
  if (!Number.isFinite(exp)) return 'invalid expiration parameter'
  if (Date.now() > exp) return 'signed URL expired'
  const ok = verifyToken({ action, att_id: attId, exp }, providedSig)
  if (!ok) return 'signature verification failed'
  return null
}
