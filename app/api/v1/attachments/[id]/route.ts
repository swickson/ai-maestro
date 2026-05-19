/**
 * PUT /api/v1/attachments/:id
 *
 * Binary upload for an initiated AMP attachment (kanban #48 / spec §3 step 2).
 * Authenticated via signed URL (?sig=...&exp=...) — no Authorization header
 * required. The signed URL is single-use semantically: confirm transitions
 * the attachment off pending, blocking re-upload at the meta layer.
 *
 * Body: raw binary bytes (request.arrayBuffer()). Server enforces:
 *   - sig + exp validation (lib/attachment-signer.ts)
 *   - existing meta record + attachment in `pending` state
 *   - bytes within meta.size + AMP_MAX_ATTACHMENT_BYTES
 *
 * No transition to `clean` here — that happens on /confirm. Just store the
 * blob and update meta.digest.
 *
 * GET /api/v1/attachments/:id
 *
 * Status-poll alias of /status (kanban 4e70636e). amp-helper.sh upload_attachment
 * polls this exact URL waiting for scan_status to leave 'pending'; without the
 * GET handler the bare path returns 405 (only PUT is exported), the polling
 * loop hits the "Provider may not support polling — leave as pending" branch
 * and ships scan_status='pending' + url=null to the recipient — breaking
 * cross-host attachments (PR #119/#122/#123 chain). Returns identical shape
 * to GET /:id/status, including the signed download URL when scan_status=clean.
 */

import { NextRequest, NextResponse } from 'next/server'
import * as crypto from 'crypto'
import { authenticateRequest } from '@/lib/amp-auth'
import { readMeta, writeMeta, writeBlob, hasBlob } from '@/lib/attachment-storage'
import { verifySignedRequest, buildSignedUrl } from '@/lib/attachment-signer'
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

export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const sig = request.nextUrl.searchParams.get('sig')
  const exp = request.nextUrl.searchParams.get('exp')
  const sigError = verifySignedRequest('upload', id, sig, exp)
  if (sigError) {
    return NextResponse.json({ error: { code: 'unauthorized', message: sigError } }, { status: 401 })
  }

  const meta = readMeta(id)
  if (!meta) {
    return NextResponse.json({ error: { code: 'not_found', message: `attachment ${id} not initiated` } }, { status: 404 })
  }
  if (meta.scan_status !== 'pending') {
    return NextResponse.json({ error: { code: 'conflict', message: `attachment ${id} already in ${meta.scan_status} state` } }, { status: 409 })
  }
  if (hasBlob(id)) {
    return NextResponse.json({ error: { code: 'conflict', message: `attachment ${id} already uploaded` } }, { status: 409 })
  }

  const arrayBuf = await request.arrayBuffer()
  const data = Buffer.from(arrayBuf)
  if (data.length === 0) {
    return NextResponse.json({ error: { code: 'invalid_request', message: 'empty body' } }, { status: 400 })
  }
  const cap = maxAttachmentBytes()
  if (data.length > cap) {
    return NextResponse.json({ error: { code: 'invalid_field', message: `body size ${data.length} exceeds AMP_MAX_ATTACHMENT_BYTES cap (${cap})` } }, { status: 413 })
  }
  if (data.length !== meta.size) {
    return NextResponse.json({ error: { code: 'invalid_field', message: `body size ${data.length} does not match initiated size ${meta.size}` } }, { status: 400 })
  }

  writeBlob(id, data)
  meta.digest = crypto.createHash('sha256').update(data).digest('hex')
  writeMeta(meta)

  return NextResponse.json({ attachment_id: id, digest: meta.digest })
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const authHeader = request.headers.get('Authorization')
  const auth = authenticateRequest(authHeader)
  if (!auth.authenticated) {
    return NextResponse.json({ error: { code: auth.error || 'unauthorized', message: auth.message || 'unauthorized' } }, { status: 401 })
  }

  const meta = readMeta(id)
  if (!meta) {
    return NextResponse.json({ error: { code: 'not_found', message: `attachment ${id} not found` } }, { status: 404 })
  }

  // Build the download URL only when the attachment is routable — both
  // `clean` and `basic_clean` qualify per spec v0.1.2 §5 (table). `pending`,
  // `suspicious`, and `rejected` return null. /confirm emits `basic_clean`
  // since we run no AV/injection; `clean` is reserved for a future SHOULD-
  // tier scanner. Same logic as the dedicated /status sub-route.
  //
  // baseUrl uses getSelfHost().url for the canonical Tailscale URL (NOT
  // request.nextUrl.host which captures the bind address and would resolve
  // to the recipient's loopback — kanban 1259f3a0).
  const baseUrl = getSelfHost().url
  const isRoutable = meta.scan_status === 'clean' || meta.scan_status === 'basic_clean'
  const url = isRoutable
    ? buildSignedUrl(baseUrl, 'download', id, meta.expires_at)
    : null

  return NextResponse.json({
    attachment_id: id,
    filename: meta.filename,
    content_type: meta.content_type,
    size: meta.size,
    digest: meta.digest,
    scan_status: meta.scan_status,
    uploaded_at: meta.uploaded_at,
    expires_at: meta.expires_at,
    url,
  })
}
