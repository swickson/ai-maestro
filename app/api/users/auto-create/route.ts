import { NextRequest, NextResponse } from 'next/server'
import { autoCreateExternalUser } from '@/services/users-service'

/**
 * POST /api/users/auto-create
 *
 * Auto-create an external user from gateway first-contact.
 * If user already exists by platform+platformUserId, returns existing record.
 *
 * Body: { platform, platformUserId, handle?, context? }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const result = autoCreateExternalUser(body)
    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json(result.data, { status: result.status })
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
}
