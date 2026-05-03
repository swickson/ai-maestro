import { NextRequest, NextResponse } from 'next/server'
import { notifyAgent } from '@/lib/notification-service'
import { injectMeetingPrompt } from '@/services/agents-chat-service'
import { toResponse } from '@/app/api/_helpers'

/**
 * POST /api/agents/notify
 *
 * Trigger a tmux push notification or prompt injection for a local agent.
 *
 * Notification mode (default):
 *   Body: { agentName, fromName, subject, priority?, messageType? }
 *   Sends a tmux display-message notification.
 *
 * Injection mode (for meeting chat):
 *   Body: { agentName, injection }
 *   Sends literal text into the agent's tmux session via send-keys.
 *   Used by cross-host meeting chat to inject prompts into remote agents.
 */
export async function POST(request: NextRequest) {
  try {
    const body = await request.json()

    // Injection mode: delegate to agents-chat-service (handles host/cloud
    // dispatch + cancelCopyMode→sendKeys ordering across hybrid + legacy paths).
    if (body.injection && body.agentName) {
      const result = await injectMeetingPrompt({
        agentName: body.agentName,
        injection: body.injection,
      })
      return toResponse(result)
    }

    // Notification mode: tmux display-message
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
