/**
 * POST /api/v1/attachments/upload
 *
 * Initiate an AMP attachment upload (kanban #48 / spec §3 step 1).
 *
 * Request:
 *   { filename, content_type, size, digest }
 * Response:
 *   { attachment_id, upload_url }
 *
 * The upload_url is HMAC-signed (lib/attachment-signer.ts) so the binary
 * PUT can proceed without re-authenticating. Filename is server-sanitized;
 * size is bounded by AMP_MAX_ATTACHMENT_BYTES (default 25MB).
 */

import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/amp-auth'
import {
  generateAttachmentId,
  writeMeta,
  defaultExpiresAt,
  type AttachmentMeta,
} from '@/lib/attachment-storage'
import { buildSignedUrl } from '@/lib/attachment-signer'
import { sanitize as sanitizeFilename } from '@/lib/attachment-filename'
import { getSelfHost } from '@/lib/hosts-config'

const DEFAULT_MAX_BYTES = 25 * 1024 * 1024
function maxAttachmentBytes(): number {
  const env = process.env.AMP_MAX_ATTACHMENT_BYTES
  if (env) {
    const n = parseInt(env, 10)
    if (Number.isFinite(n) && n > 0) return n
  }
  return DEFAULT_MAX_BYTES
}

export async function POST(request: NextRequest) {
  const authHeader = request.headers.get('Authorization')
  const auth = authenticateRequest(authHeader)
  if (!auth.authenticated) {
    return NextResponse.json({ error: { code: auth.error || 'unauthorized', message: auth.message || 'unauthorized' } }, { status: 401 })
  }

  let body: { filename?: string; content_type?: string; size?: number; digest?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: { code: 'invalid_request', message: 'invalid JSON' } }, { status: 400 })
  }

  if (!body.filename || typeof body.filename !== 'string') {
    return NextResponse.json({ error: { code: 'missing_field', message: 'filename required' } }, { status: 400 })
  }
  const filename = sanitizeFilename(body.filename)
  if (!filename) {
    return NextResponse.json({ error: { code: 'invalid_field', message: 'filename failed sanitization (allowed: [a-zA-Z0-9._-], not reserved, <=255 chars)' } }, { status: 400 })
  }
  if (typeof body.size !== 'number' || body.size <= 0) {
    return NextResponse.json({ error: { code: 'missing_field', message: 'size (bytes, >0) required' } }, { status: 400 })
  }
  const cap = maxAttachmentBytes()
  if (body.size > cap) {
    return NextResponse.json({ error: { code: 'invalid_field', message: `size ${body.size} exceeds AMP_MAX_ATTACHMENT_BYTES cap (${cap})` } }, { status: 413 })
  }

  const id = generateAttachmentId()
  const expiresAt = defaultExpiresAt()
  const meta: AttachmentMeta = {
    id,
    filename,
    content_type: body.content_type || 'application/octet-stream',
    size: body.size,
    digest: null,
    scan_status: 'pending',
    uploaded_at: null,
    expires_at: expiresAt,
    initiated_at: new Date().toISOString(),
    initiator_agent_id: auth.agentId || 'unknown',
  }
  writeMeta(meta)

  // Use getSelfHost().url for the canonical Tailscale URL — request.nextUrl.host
  // captures the bind address (typically 0.0.0.0) which fails for any cross-host
  // caller that needs to PUT to this signed URL (kanban 1259f3a0).
  const baseUrl = getSelfHost().url
  const upload_url = buildSignedUrl(baseUrl, 'upload', id, expiresAt)

  return NextResponse.json({ attachment_id: id, upload_url })
}
