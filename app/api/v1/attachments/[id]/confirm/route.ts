/**
 * POST /api/v1/attachments/:id/confirm
 *
 * Finalize an uploaded AMP attachment (kanban #48 / spec v0.1.2 §5 scanning
 * pipeline, kanban dcba7c52).
 *
 * The confirm endpoint runs the MUST-tier scan pipeline (no AV/injection
 * — those are SHOULD-tier and we don't run them, so terminal success state
 * is `basic_clean`, not `clean`):
 *
 *   1. Size re-verification (spec §5 step 1) — blobSize ↔ meta.size
 *   2. Digest re-verification (spec §5 step 1) — sha256(blob) ↔ meta.digest
 *   3. Executable detection (spec §5 step 2) — magic-byte sniff
 *   4. Magic-bytes vs declared content_type at primary type (spec §5 step 3)
 *
 * Any MUST failure → scan_status = 'rejected', HTTP 422.
 * All MUSTs pass     → scan_status = 'basic_clean', HTTP 200.
 *
 * After confirm, the attachment is immutable — meta + blob never change.
 */

import { NextRequest, NextResponse } from 'next/server'
import { authenticateRequest } from '@/lib/amp-auth'
import { readMeta, writeMeta, readBlob, hasBlob, blobSize, digestBlob } from '@/lib/attachment-storage'
import { sniff, primaryTypeMatches } from '@/lib/attachment-mime'

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

  const rejectWith = (reason: string, contentType?: string) => {
    meta.scan_status = 'rejected'
    if (contentType) meta.content_type = contentType
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
      reason,
    }, { status: 422 })
  }

  // §5 step 1a: size re-verification.
  // PUT already enforces this on upload, but disk state can drift between PUT
  // and confirm (manual edit, tampering); the confirm-time re-check is
  // defense-in-depth and the explicit spec gate.
  const actualSize = blobSize(id)
  if (actualSize !== meta.size) {
    return rejectWith(`blob size ${actualSize} does not match declared size ${meta.size}`)
  }

  // §5 step 1b: digest re-verification.
  // PUT computes the digest server-side and stores it; here we re-hash to
  // catch any post-PUT tampering of the blob.
  const actualDigest = digestBlob(id)
  if (!actualDigest || actualDigest !== meta.digest) {
    return rejectWith(`blob sha256 ${actualDigest || '(unreadable)'} does not match declared digest ${meta.digest}`)
  }

  const data = readBlob(id)!
  const sniffed = sniff(data, meta.content_type)

  // §5 step 2: executable detection. Server-authoritative — overwrite
  // content_type with the sniff result so the rejection record reflects what
  // the file actually is.
  if (sniffed.is_executable) {
    return rejectWith('executable content rejected by MIME sniff', sniffed.detected_type)
  }

  // §5 step 3: magic-bytes vs declared content_type cross-check at primary
  // type level. `application/octet-stream` declarations and 0-byte files are
  // exempt per spec (the latter unreachable here — PUT rejects empty bodies).
  if (!primaryTypeMatches(meta.content_type, sniffed, data.length)) {
    return rejectWith(
      `declared content_type ${meta.content_type} disagrees with sniffed ${sniffed.detected_type} at primary type level`,
      sniffed.detected_type,
    )
  }

  // All MUSTs passed. Upgrade content_type only when client declared
  // octet-stream and sniff found a real type — otherwise keep the declared
  // value (it cross-checked successfully).
  if (
    sniffed.matched_magic &&
    (meta.content_type === 'application/octet-stream' || !meta.content_type)
  ) {
    meta.content_type = sniffed.detected_type
  }
  // Terminal state: basic_clean (not clean) — we ran the MUSTs but no SHOULD
  // (AV / injection scan). Spec v0.1.2 §5 table line 429.
  meta.scan_status = 'basic_clean'
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
