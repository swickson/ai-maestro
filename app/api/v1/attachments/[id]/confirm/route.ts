/**
 * POST /api/v1/attachments/:id/confirm
 *
 * Finalize an uploaded AMP attachment (kanban #48 / spec §3 step 3).
 *
 * Server runs MIME sniff (lib/attachment-mime.ts) — rejects executables
 * regardless of client-declared content_type. Updates meta:
 *   - content_type → sniff result
 *   - scan_status → 'clean' or 'rejected' (no AV integration yet, scan_status
 *     advances directly from 'pending' to terminal state)
 *   - uploaded_at → now
 *
 * After confirm, the attachment is immutable — meta + blob never change.
 */

import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/amp-auth'
import { readMeta, writeMeta, readBlob, hasBlob } from '@/lib/attachment-storage'
import { sniff } from '@/lib/attachment-mime'

export async function POST(
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
  if (meta.scan_status !== 'pending') {
    // Idempotent: already-confirmed attachment returns its current shape.
    return NextResponse.json({
      attachment_id: id,
      content_type: meta.content_type,
      size: meta.size,
      digest: meta.digest,
      scan_status: meta.scan_status,
      uploaded_at: meta.uploaded_at,
      expires_at: meta.expires_at,
    })
  }
  if (!hasBlob(id)) {
    return NextResponse.json({ error: { code: 'conflict', message: `attachment ${id} blob not uploaded yet` } }, { status: 409 })
  }

  const data = readBlob(id)!
  const sniffed = sniff(data, meta.content_type)
  if (sniffed.is_executable) {
    meta.scan_status = 'rejected'
    meta.content_type = sniffed.detected_type
    meta.uploaded_at = new Date().toISOString()
    writeMeta(meta)
    return NextResponse.json({
      attachment_id: id,
      content_type: meta.content_type,
      size: meta.size,
      digest: meta.digest,
      scan_status: 'rejected',
      uploaded_at: meta.uploaded_at,
      expires_at: meta.expires_at,
      reason: 'executable content rejected by MIME sniff',
    }, { status: 422 })
  }

  meta.content_type = sniffed.detected_type
  meta.scan_status = 'clean'
  meta.uploaded_at = new Date().toISOString()
  writeMeta(meta)

  return NextResponse.json({
    attachment_id: id,
    content_type: meta.content_type,
    size: meta.size,
    digest: meta.digest,
    scan_status: meta.scan_status,
    uploaded_at: meta.uploaded_at,
    expires_at: meta.expires_at,
  })
}
