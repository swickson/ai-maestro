import { NextRequest, NextResponse } from 'next/server'
import { notifyUser } from '@/services/users-service'

/**
 * POST /api/users/[id]/notify
 *
 * Send a notification to a user via their preferred platform.
 * Routes through the appropriate gateway DM endpoint.
 *
 * Body: { message, platform?, subject?, botSlug? }
 * botSlug targets a specific multi-bot-platform bot (e.g. send as a named bot);
 * omitted → forwarded as absent and the gateway decides (409 for an ambiguous
 * multi-bot user, reuse the lone bot for a single-bot user). (#13, multi-bot fix)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const body = await request.json()
    if (!body.message || typeof body.message !== 'string') {
      return NextResponse.json({ error: 'message is required' }, { status: 400 })
    }
    const result = await notifyUser(id, body.message, {
      platform: body.platform,
      subject: body.subject,
      botSlug: body.botSlug,
    })
    if (result.error) {
      return NextResponse.json({ error: result.error }, { status: result.status })
    }
    return NextResponse.json(result.data, { status: result.status })
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }
}
