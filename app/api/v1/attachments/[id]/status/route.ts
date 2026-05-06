/**
 * GET /api/v1/attachments/:id/status
 *
 * Poll the scan_status of an AMP attachment (kanban #48 / spec §3 step 4).
 *
 * Returns full meta minus internal-only fields. Polling protocol — clients
 * call this until scan_status leaves 'pending'.
 */

import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/amp-auth'
import { readMeta } from '@/lib/attachment-storage'
import { buildSignedUrl } from '@/lib/attachment-signer'

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

  // Build the download URL only when status is 'clean' — recipients should not
  // be able to start fetching a 'pending' or 'rejected' attachment.
  const baseUrl = `${request.nextUrl.protocol}//${request.nextUrl.host}`
  const url = meta.scan_status === 'clean'
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
