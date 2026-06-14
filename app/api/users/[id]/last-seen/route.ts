import { NextRequest, NextResponse } from 'next/server'
import { updateLastSeen } from '@/services/users-service'

/**
 * PATCH /api/users/[id]/last-seen
 *
 * Touch a user's platform presence on inbound: bumps lastSeenPerPlatform[platform]
 * (merge-safe) and optionally deep-merges a context patch into the matching
 * platform mapping. Used by gateways on every inbound message.
 *
 * Body: { platform, platformUserId?, context? }
 *   e.g. Teams every-inbound: { platform:'teams', platformUserId:'<aad>', context:{ botSlug:'<slug>' } }
 *
 * NOTE: this route previously existed only in the headless router, so it 404'd in
 * full (Next.js) mode — callers fell back to the generic [id] PATCH, which shallow-
 * replaces lastSeenPerPlatform and clobbers other platforms. This handler closes
 * that gap so full-mode hosts get the merge-safe path.
 */
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const body = await request.json()
    if (!body.platform || typeof body.platform !== 'string') {
      return NextResponse.json({ error: 'platform is required' }, { status: 400 })
    }
    const result = updateLastSeen(id, body.platform, {
      platformUserId: body.platformUserId,
      context: body.context,
    })
    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json(result.data, { status: result.status })
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
}
