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
 */

import { NextRequest, NextResponse } from 'next/server'
import * as crypto from 'crypto'
import { readMeta, writeMeta, writeBlob, hasBlob } from '@/lib/attachment-storage'
import { verifySignedRequest } from '@/lib/attachment-signer'

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
