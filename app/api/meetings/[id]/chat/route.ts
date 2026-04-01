import { NextRequest, NextResponse } from 'next/server'
import {
  postChatMessage,
  getChatMessages,
} from '@/lib/meeting-chat-service'
import { getMeeting } from '@/lib/meeting-registry'
import { parseMentions } from '@/lib/meeting-router'
import { routeMessage } from '@/lib/meeting-router'
import { getRuntime } from '@/lib/agent-runtime'
import { getAgent } from '@/lib/agent-registry'

/**
 * GET /api/meetings/[id]/chat?since=<ISO>&limit=<number>
 * Read messages from the shared chat timeline.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: meetingId } = await params
  const since = request.nextUrl.searchParams.get('since') || undefined
  const limitStr = request.nextUrl.searchParams.get('limit')
  const limit = limitStr ? parseInt(limitStr, 10) : undefined

  const meeting = getMeeting(meetingId)
  if (!meeting) {
    return NextResponse.json({ error: 'Meeting not found' }, { status: 404 })
  }

  const result = getChatMessages({ meetingId, since, limit })
  return NextResponse.json(result)
}

/**
 * POST /api/meetings/[id]/chat
 * Append a message to the shared chat timeline.
 *
 * Body: { from, fromAlias, fromType, message, mentions? }
 *
 * After storing, triggers agent injection via the Phase 1 router
 * for any @mentioned agents.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: meetingId } = await params
  const body = await request.json()

  const meeting = getMeeting(meetingId)
  if (!meeting) {
    return NextResponse.json({ error: 'Meeting not found' }, { status: 404 })
  }

  const { from, fromAlias, fromType, message } = body

  if (!from || !message) {
    return NextResponse.json(
      { error: 'from and message are required' },
      { status: 400 }
    )
  }

  // Parse @mentions from the message text
  const parsed = parseMentions(message)

  // Store the message in the shared log
  const chatMessage = postChatMessage({
    meetingId,
    from: from || 'unknown',
    fromAlias: fromAlias || from || 'Unknown',
    fromType: fromType || 'agent',
    message,
    mentions: parsed.mentionedNames,
    mentionAll: parsed.isAll,
  })

  // Route via Phase 1 router for agent injection (fire-and-forget)
  const isHuman = fromType === 'human'
  triggerAgents({
    meetingId,
    senderId: from,
    senderName: fromAlias || from,
    isHuman,
    messageText: message,
    meeting,
  }).catch(err => console.warn('[MeetingChat] Agent triggering failed:', err))

  return NextResponse.json({ message: chatMessage }, { status: 201 })
}

// ─── Agent Injection (reuses Phase 1 router) ────────────────────────────────

async function triggerAgents(params: {
  meetingId: string
  senderId: string
  senderName: string
  isHuman: boolean
  messageText: string
  meeting: ReturnType<typeof getMeeting>
}): Promise<void> {
  const { meetingId, senderId, senderName, isHuman, messageText, meeting } = params
  if (!meeting) return

  const result = routeMessage({
    meetingId,
    senderId,
    senderName,
    isHuman,
    messageText,
  })

  if (result.blocked) {
    console.log(`[MeetingChat] Message blocked: ${result.reason}`)
    return
  }

  if (result.targetAgentIds.length === 0) return

  const runtime = getRuntime()
  const teamName = meeting.name

  for (const agentId of result.targetAgentIds) {
    const agent = getAgent(agentId)
    if (!agent) continue

    const sessionName = agent.name
    const sessionExists = await runtime.sessionExists(sessionName)
    if (!sessionExists) {
      console.log(`[MeetingChat] Skipping ${agent.name} — no active session`)
      continue
    }

    const prompt = [
      `[Meeting: ${teamName}]`,
      `${senderName} says: ${messageText}`,
      '',
      `Reply by running: curl -s -X POST http://localhost:23000/api/meetings/${meetingId}/chat -H "Content-Type: application/json" -d '{"from":"${agent.id}","fromAlias":"${agent.label || agent.name}","fromType":"agent","message":"your reply here"}'`,
    ].join('\n')

    try {
      await runtime.sendKeys(sessionName, prompt, { literal: true, enter: true })
      console.log(`[MeetingChat] Injected prompt into ${agent.name}`)
    } catch (err) {
      console.warn(`[MeetingChat] Failed to inject into ${agent.name}:`, err)
    }
  }
}
