import { NextRequest, NextResponse } from 'next/server'
import { notifyAgent } from '@/lib/notification-service'

/**
 * POST /api/agents/notify
 *
 * Trigger a tmux push notification for a local agent.
 * Used by amp-send.sh after local filesystem delivery to notify
 * the recipient that a new message has arrived.
 *
 * Body: { agentName, fromName, subject, priority?, messageType? }
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()
    const { agentName, fromName, subject, priority, messageType, messageId } = body

    if (!agentName || !fromName || !subject) {
      return NextResponse.json(
        { error: 'Missing required fields: agentName, fromName, subject' },
        { status: 400 }
      )
    }

    const result = await notifyAgent({
      agentName,
      fromName,
      subject,
      messageId: messageId || 'local-delivery',
      priority: priority || 'normal',
      messageType: messageType || 'notification',
    })

    return NextResponse.json(result)
  } catch (error) {
    console.error('[API] /api/agents/notify error:', error)
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    )
  }
}
