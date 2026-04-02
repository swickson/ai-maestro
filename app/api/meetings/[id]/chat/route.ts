import { NextRequest, NextResponse } from 'next/server'
import { isSelf, getHostById, getSelfHost } from '@/lib/hosts-config'
import { getMeeting } from '@/lib/meeting-registry'
import { getChatMessages } from '@/lib/meeting-chat-service'
import { routeMessage } from '@/lib/meeting-router'
import { getRuntime } from '@/lib/agent-runtime'
import { getAgent } from '@/lib/agent-registry'

/**
 * Inject a meeting chat prompt into an agent's tmux session.
 * For local agents: uses the local runtime directly.
 * For remote agents: POSTs to the agent's host notify endpoint.
 */
async function injectMeetingPrompt(
  agentId: string,
  prompt: string,
): Promise<void> {
  // Try local registry first, fall back to sessions API for remote agents
  let agent = getAgent(agentId)
  let agentName: string | undefined = agent?.name
  let agentHostId: string | undefined = agent?.hostId
  let agentHostUrl: string | undefined = agent?.hostUrl

  if (!agent) {
    // Remote agent: look up in sessions API
    console.log(`[MeetingChat] Agent ${agentId.slice(0,8)} not in local registry, checking sessions API...`)
    try {
      const sessRes = await fetch('http://localhost:23000/api/sessions')
      if (sessRes.ok) {
        const sessData = await sessRes.json()
        const session = (sessData.sessions || []).find((s: any) => s.agentId === agentId)
        if (session) {
          agentName = session.name
          agentHostId = session.hostId
          if (agentHostId) {
            const hostRecord = getHostById(agentHostId)
            agentHostUrl = hostRecord?.url
            console.log(`[MeetingChat] Resolved remote agent: ${agentName} at ${agentHostUrl || 'no URL'} (host: ${agentHostId})`)
          }
        } else {
          console.warn(`[MeetingChat] Agent ${agentId.slice(0,8)} not found in sessions API either`)
        }
      }
    } catch (err) {
      console.warn(`[MeetingChat] Sessions API lookup failed:`, err)
    }
  }

  if (!agentName) {
    console.warn(`[MeetingChat] Cannot inject: agent ${agentId} not found in registry or sessions`)
    return
  }

  const sessionName = agentName

  // Local agent: inject directly via tmux
  if (!agentHostId || isSelf(agentHostId)) {
    const runtime = getRuntime()
    const exists = await runtime.sessionExists(sessionName)
    if (!exists) return
    await runtime.sendKeys(sessionName, prompt, { literal: true, enter: true })
    console.log(`[MeetingChat] Injected prompt into local agent ${agentName}`)
    return
  }

  // Remote agent: POST injection to the agent's host
  const remoteHost = agentHostUrl ? { url: agentHostUrl } : getHostById(agentHostId)
  if (!remoteHost) {
    console.warn(`[MeetingChat] Cannot inject into ${agentName}: host ${agentHostId} not found`)
    return
  }

  try {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), 8000)

    await fetch(`${remoteHost.url}/api/agents/notify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        agentName: sessionName,
        injection: prompt,
      }),
      signal: controller.signal,
    })
    clearTimeout(timeoutId)
    console.log(`[MeetingChat] Injected prompt into remote agent ${agentName} via ${remoteHost.url}`)
  } catch (err) {
    console.warn(`[MeetingChat] Failed to inject into remote agent ${agentName}:`, err)
  }
}

/**
 * POST /api/meetings/[id]/chat
 *
 * Post a message to a meeting's shared timeline.
 * If the meeting is hosted on a remote machine, proxies the request
 * to the meeting host via the mesh network.
 *
 * Body: { from, fromAlias?, fromLabel?, fromType, message, mentions? }
 * Response: { success, message: ChatMessage } or proxied response
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: meetingId } = await params

  let body: Record<string, unknown>
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const meeting = getMeeting(meetingId)

  // If the meeting exists locally, handle it here.
  // Watson's Stream A storage service will provide the actual write logic.
  // For now, write to the shared log and broadcast via WebSocket.
  if (meeting) {
    // Import the chat storage service dynamically (Stream A will provide this)
    try {
      const { postChatMessage } = await import('@/lib/meeting-chat-service')
      const chatMessage = postChatMessage({
        meetingId,
        from: body.from as string,
        fromAlias: (body.fromAlias as string) || (body.from as string),
        fromType: (body.fromType as 'human' | 'agent') || 'agent',
        message: body.message as string,
      })

      // Broadcast to WebSocket subscribers
      const g = globalThis as Record<string, unknown>
      if (typeof g.__meetingChatBroadcast === 'function') {
        (g.__meetingChatBroadcast as (id: string, msg: unknown) => void)(meetingId, chatMessage)
      }

      // Trigger @mentioned agents via Phase 1 router (fire-and-forget)
      const fromStr = body.from as string
      const isHuman = (body.fromType as string) === 'human'
      const routing = routeMessage({
        meetingId,
        senderId: fromStr,
        senderName: (body.fromAlias as string) || fromStr,
        isHuman,
        messageText: body.message as string,
      })

      if (!routing.blocked && routing.targetAgentIds.length > 0) {
        // Use the meeting host's public URL so remote agents can reply back
        const selfHost = getSelfHost()
        const meetingHostUrl = selfHost?.url || `http://localhost:23000`

        // Phase 3: Build conversation context for injection
        const recentMessages = getChatMessages({ meetingId, limit: 10 }).messages
        const contextMessages = recentMessages
          .filter(m => m.id !== chatMessage.id)
          .slice(-8)

        let contextBlock = ''
        if (contextMessages.length > 0) {
          const lines = contextMessages.map(m => {
            const role = m.fromType === 'human' ? '👤' : '🤖'
            return `  ${role} ${m.fromAlias}: ${m.message.slice(0, 200)}`
          })
          let contextText = lines.join('\n')
          if (contextText.length > 2000) {
            contextText = contextText.slice(-2000)
            contextText = '  ...\n' + contextText.slice(contextText.indexOf('\n') + 1)
          }
          contextBlock = `\nRecent conversation:\n${contextText}\n`
        }

        const senderName = (body.fromAlias as string) || fromStr

        // Fetch sessions for resolving remote agent names
        let remoteSessions: Array<{ name: string; agentId: string; hostId?: string }> = []
        try {
          const sessRes = await fetch('http://localhost:23000/api/sessions')
          if (sessRes.ok) {
            const sessData = await sessRes.json()
            remoteSessions = sessData.sessions || []
          }
        } catch { /* ignore */ }

        for (const agentId of routing.targetAgentIds) {
          // Resolve agent name from local registry or remote sessions
          const agent = getAgent(agentId)
          let agentLabel: string
          if (agent) {
            agentLabel = agent.label || agent.name
          } else {
            const session = remoteSessions.find(s => s.agentId === agentId)
            agentLabel = session?.name || agentId.slice(0, 8)
          }
          const prompt = [
            `[Meeting: ${meeting.name}]`,
            contextBlock,
            `${senderName} says: ${body.message}`,
            '',
            `Reply by running: meeting-send.sh ${meetingId} "YOUR_REPLY" --from "${agentId}" --alias "${agentLabel}" --host ${meetingHostUrl}`,
          ].join('\n')
          // Phase 4: Fire-and-forget — handles local + remote injection
          injectMeetingPrompt(agentId, prompt).catch(err => {
            console.error(`[MeetingChat] injectMeetingPrompt failed for ${agentId.slice(0,8)}:`, err)
          })
        }
      }

      return NextResponse.json({ success: true, message: chatMessage })
    } catch (error) {
      // Stream A not yet available — return 501
      const msg = error instanceof Error ? error.message : 'Chat storage not available'
      return NextResponse.json({ error: msg }, { status: 501 })
    }
  }

  // Meeting not found locally — check if it might be on a remote host.
  // The request may include a hostId hint from the frontend.
  const hostId = body.hostId as string | undefined
  if (hostId && !isSelf(hostId)) {
    const remoteHost = getHostById(hostId)
    if (remoteHost) {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 10000)

        const response = await fetch(`${remoteHost.url}/api/meetings/${meetingId}/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: controller.signal,
        })
        clearTimeout(timeoutId)

        const data = await response.json()
        return NextResponse.json(data, { status: response.status })
      } catch (error) {
        return NextResponse.json(
          { error: `Meeting host unreachable (${remoteHost.url})` },
          { status: 502 }
        )
      }
    }
  }

  return NextResponse.json({ error: 'Meeting not found' }, { status: 404 })
}

/**
 * GET /api/meetings/[id]/chat
 *
 * Retrieve chat history for a meeting.
 * Supports ?since=ISO timestamp for incremental fetches.
 * Proxies to remote host if meeting is not local.
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: meetingId } = await params
  const { searchParams } = new URL(request.url)
  const since = searchParams.get('since')

  const meeting = getMeeting(meetingId)

  if (meeting) {
    try {
      const { getChatMessages } = await import('@/lib/meeting-chat-service')
      const result = getChatMessages({ meetingId, since: since || undefined })
      const messages = result.messages
      return NextResponse.json({ messages })
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Chat storage not available'
      return NextResponse.json({ error: msg }, { status: 501 })
    }
  }

  // Try remote host
  const hostId = searchParams.get('hostId')
  if (hostId && !isSelf(hostId)) {
    const remoteHost = getHostById(hostId)
    if (remoteHost) {
      try {
        const controller = new AbortController()
        const timeoutId = setTimeout(() => controller.abort(), 10000)

        const url = new URL(`${remoteHost.url}/api/meetings/${meetingId}/chat`)
        if (since) url.searchParams.set('since', since)

        const response = await fetch(url.toString(), { signal: controller.signal })
        clearTimeout(timeoutId)

        const data = await response.json()
        return NextResponse.json(data, { status: response.status })
      } catch {
        return NextResponse.json(
          { error: 'Meeting host unreachable' },
          { status: 502 }
        )
      }
    }
  }

  return NextResponse.json({ error: 'Meeting not found' }, { status: 404 })
}
