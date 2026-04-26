import { NextRequest, NextResponse } from 'next/server'
import { notifyAgent } from '@/lib/notification-service'
import { getRuntime } from '@/lib/agent-runtime'
import { enqueueForSession, shouldUseAdditionalContext, sanitizeForRawInject, wrapAsBracketedPaste } from '@/lib/meeting-inject-queue'
import { getAgentBySession } from '@/lib/agent-registry'
import { sendKeysToContainer } from '@/lib/container-utils'

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
      const sessionName = body.agentName
      // Resolve agent up-front so we can dispatch on deployment.type. For
      // cloud agents, the host-tmux runtime has no session — sendKeys must
      // go via `docker exec aim-<name> tmux send-keys` against the in-
      // container tmux instead. Same shape as PR #56's cloud branch in
      // wakeAgent (closes #6) but for the injection path.
      const agent = getAgentBySession(sessionName)
      const isCloud = agent?.deployment?.type === 'cloud'
      const containerName = isCloud ? agent?.deployment?.cloud?.containerName : undefined

      if (isCloud) {
        if (!containerName) {
          return NextResponse.json(
            { error: `Cloud agent ${sessionName} has no containerName configured` },
            { status: 400 }
          )
        }
      } else {
        const runtime = getRuntime()
        const exists = await runtime.sessionExists(sessionName)
        if (!exists) {
          return NextResponse.json({ error: `Session ${sessionName} not found` }, { status: 404 })
        }
      }

      // Hybrid path (flag-gated per agent kind): enqueue as structured context
      // and wake-ping with "." + Enter (bare Enter was a no-op in Claude Code).
      // Hook drains on the resulting UserPromptSubmit.
      if (agent && shouldUseAdditionalContext(agent.program)) {
        enqueueForSession(sessionName, body.injection)
        if (isCloud && containerName) {
          await sendKeysToContainer(containerName, sessionName, '.', { literal: true, enter: false })
          await new Promise(r => setTimeout(r, 100))
          await sendKeysToContainer(containerName, sessionName, '', { literal: false, enter: true })
        } else {
          const runtime = getRuntime()
          await runtime.sendKeys(sessionName, '.', { literal: true, enter: false })
          await new Promise(r => setTimeout(r, 100))
          await runtime.sendKeys(sessionName, '', { literal: false, enter: true })
        }
        console.log(`[API] /api/agents/notify: queued + wake-pinged ${sessionName} (${agent.program}${isCloud ? ', cloud' : ''})`)
        return NextResponse.json({ success: true, queued: true })
      }

      // Legacy path: send the injection as an explicit bracketed-paste block
      // (ESC[200~…ESC[201~) so Codex/Gemini close their paste-receive window
      // on the 201~ marker before our trailing Enter lands. Without the
      // explicit wrap, tmux's auto-paste-wrap raced with the Enter on larger
      // payloads and the Enter got absorbed into the paste body. 500ms still
      // covers tmux write-flush for multi-KB payloads on slow hosts.
      const safeInjection = wrapAsBracketedPaste(sanitizeForRawInject(String(body.injection)))
      if (isCloud && containerName) {
        await sendKeysToContainer(containerName, sessionName, safeInjection, { literal: true, enter: false })
        await new Promise(r => setTimeout(r, 500))
        await sendKeysToContainer(containerName, sessionName, '', { literal: false, enter: true })
      } else {
        const runtime = getRuntime()
        await runtime.sendKeys(sessionName, safeInjection, { literal: true, enter: false })
        await new Promise(r => setTimeout(r, 500))
        await runtime.sendKeys(sessionName, '', { literal: false, enter: true })
      }
      console.log(`[API] /api/agents/notify: injected meeting prompt into ${sessionName}${isCloud ? ' (cloud)' : ''}`)
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
