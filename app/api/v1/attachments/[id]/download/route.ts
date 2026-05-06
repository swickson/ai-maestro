/**
 * GET /api/v1/attachments/:id/download
 *
 * Authenticated download of an AMP attachment (kanban #48 / spec §3 step 5).
 *
 * Authenticated via signed URL (?sig=...&exp=...) — no Authorization header
 * required. Per spec §1, "no authentication required for cross-provider
 * access" — the URL itself IS the authentication, S3-presigned-URL style.
 *
 * Recipient verifies the SHA-256 digest client-side against the meta record
 * (returned in /status). Server returns the raw blob with Content-Type +
 * Content-Length headers + the digest in X-Amp-Attachment-Digest.
 *
 * Refuses to serve `pending`, `rejected`, or `suspicious` attachments.
 */

import { NextRequest, NextResponse } from 'next/server'
import { readMeta, readBlob, hasBlob } from '@/lib/attachment-storage'
import { verifySignedRequest } from '@/lib/attachment-signer'

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  const sig = request.nextUrl.searchParams.get('sig')
  const exp = request.nextUrl.searchParams.get('exp')
  const sigError = verifySignedRequest('download', id, sig, exp)
  if (sigError) {
    return NextResponse.json({ error: { code: 'unauthorized', message: sigError } }, { status: 401 })
  }

  const meta = readMeta(id)
  if (!meta) {
    return NextResponse.json({ error: { code: 'not_found', message: `attachment ${id} not found` } }, { status: 404 })
  }
  if (meta.scan_status !== 'clean') {
    return NextResponse.json({ error: { code: 'forbidden', message: `attachment ${id} not in clean state (${meta.scan_status})` } }, { status: 403 })
  }
  if (!hasBlob(id)) {
    return NextResponse.json({ error: { code: 'not_found', message: `attachment ${id} blob missing` } }, { status: 404 })
  }
  if (Date.now() > new Date(meta.expires_at).getTime()) {
    return NextResponse.json({ error: { code: 'forbidden', message: `attachment ${id} expired at ${meta.expires_at}` } }, { status: 410 })
  }

  const data = readBlob(id)!
  // Buffer/Uint8Array → ArrayBuffer slice for BodyInit compatibility.
  const ab = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer
  return new NextResponse(ab, {
    status: 200,
    headers: {
      'Content-Type': meta.content_type,
      'Content-Length': String(data.length),
      'Content-Disposition': `attachment; filename="${meta.filename}"`,
      'X-Amp-Attachment-Digest': meta.digest || '',
      'Cache-Control': 'private, no-store',
    },
  })
}
