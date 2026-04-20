import { NextRequest, NextResponse } from 'next/server'
import { drainForSession } from '@/lib/meeting-inject-queue'

/**
 * GET /api/meetings/inject-queue?session=<tmuxSessionName>
 *
 * Called by the ai-maestro hook (ai-maestro-hook.cjs) on SessionStart and
 * Notification(idle_prompt) to drain any queued meeting messages for that
 * session. Returned text is merged into the hook's additionalContext for the
 * next turn.
 *
 * Shape: { messages: [{ text, enqueuedAt }], count }
 * Draining is destructive — messages are removed on read.
 */
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const session = searchParams.get('session')

  if (!session) {
    return NextResponse.json({ error: 'session param required' }, { status: 400 })
  }

  const messages = drainForSession(session)
  return NextResponse.json({ messages, count: messages.length })
}
