import { NextRequest, NextResponse } from 'next/server'
import { notifyAgent } from '@/lib/notification-service'
import { getRuntime } from '@/lib/agent-runtime'
import { enqueueForSession, shouldUseAdditionalContext } from '@/lib/meeting-inject-queue'
import { getAgentBySession } from '@/lib/agent-registry'

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

    // Injection mode: send literal text into the agent's tmux session
    if (body.injection && body.agentName) {
      const runtime = getRuntime()
      const sessionName = body.agentName
      const exists = await runtime.sessionExists(sessionName)
      if (!exists) {
        return NextResponse.json({ error: `Session ${sessionName} not found` }, { status: 404 })
      }

      // Hybrid path (flag-gated per agent kind): enqueue as structured context
      // and wake-ping with "." + Enter (bare Enter was a no-op in Claude Code).
      // Hook drains on the resulting UserPromptSubmit.
      const agent = getAgentBySession(sessionName)
      if (agent && shouldUseAdditionalContext(agent.program)) {
        enqueueForSession(sessionName, body.injection)
        await runtime.sendKeys(sessionName, '.', { literal: true, enter: false })
        await new Promise(r => setTimeout(r, 100))
        await runtime.sendKeys(sessionName, '', { literal: false, enter: true })
        console.log(`[API] /api/agents/notify: queued + wake-pinged ${sessionName} (${agent.program})`)
        return NextResponse.json({ success: true, queued: true })
      }

      // Legacy path: send the injection text, then wait before sending Enter.
      // Long injections (1000+ chars with conversation context) need time
      // to finish writing to tmux before Enter fires, especially over network hops.
      await runtime.sendKeys(sessionName, body.injection, { literal: true, enter: false })
      await new Promise(r => setTimeout(r, 500))
      await runtime.sendKeys(sessionName, '', { literal: false, enter: true })
      console.log(`[API] /api/agents/notify: injected meeting prompt into ${sessionName}`)
      return NextResponse.json({ success: true, injected: true })
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
