import { NextRequest, NextResponse } from 'next/server'
import { isSelf, getHostById } from '@/lib/hosts-config'
import { getMeeting } from '@/lib/meeting-registry'
import { routeMessage } from '@/lib/meeting-router'
import { getRuntime } from '@/lib/agent-runtime'
import { getAgent } from '@/lib/agent-registry'

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
        const runtime = getRuntime()
        const { isSelf: isSelfHost, getHostById, getSelfHost } = await import('@/lib/hosts-config')
        const selfHost = getSelfHost()
        const meetingHostUrl = selfHost?.url || `http://localhost:23000`

        // Fetch sessions list to resolve remote agents not in local registry
        let remoteSessions: Array<{ name: string; agentId?: string; hostId?: string }> = []
        try {
          const sessRes = await fetch(`http://localhost:23000/api/sessions`)
          if (sessRes.ok) {
            const sessData = await sessRes.json()
            remoteSessions = sessData.sessions || []
          }
        } catch { /* ignore */ }

        for (const agentId of routing.targetAgentIds) {
          // Try local registry first, fall back to sessions API for remote agents
          let agent = getAgent(agentId)
          let agentName = agent?.name
          let agentLabel = agent?.label || agent?.name
          let agentHostId = agent?.hostId
          let agentHostUrl = agent?.hostUrl

          if (!agent) {
            // Look up in sessions (remote agents)
            const session = remoteSessions.find(s => s.agentId === agentId)
            if (session) {
              agentName = session.name
              agentLabel = session.name
              agentHostId = session.hostId
              // Resolve hostUrl from hosts config
              if (agentHostId) {
                const hostRecord = getHostById(agentHostId)
                agentHostUrl = hostRecord?.url
              }
            }
          }

          if (!agentName) continue

          const senderName = (body.fromAlias as string) || fromStr
          const prompt = [
            `[Meeting: ${meeting.name}]`,
            `${senderName} says: ${body.message}`,
            '',
            `Reply by running: curl -s -X POST ${meetingHostUrl}/api/meetings/${meetingId}/chat -H 'Content-Type: application/json' -d '{"from":"${agentId}","fromAlias":"${agentLabel}","fromType":"agent","message":"YOUR_REPLY"}'`,
          ].join('\n')

          // Check if agent is local or remote
          const isLocal = !agentHostId || isSelfHost(agentHostId)

          if (isLocal) {
            // Local agent: inject directly via tmux
            const sessionName = agentName
            runtime.sessionExists(sessionName).then(async (exists) => {
              if (!exists) return
              try {
                await runtime.sendKeys(sessionName, prompt, { literal: true, enter: true })
                console.log(`[MeetingChat] Injected prompt into ${agentName} (local)`)
              } catch (err) {
                console.warn(`[MeetingChat] Failed to inject into ${agentName}:`, err)
              }
            }).catch(() => {})
          } else if (agentHostUrl) {
            // Remote agent: proxy injection via the agent's host
            fetch(`${agentHostUrl}/api/agents/notify`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                agentName: agentName,
                fromName: senderName,
                subject: `[Meeting: ${meeting.name}] ${senderName} mentioned you`,
                messageType: 'notification',
              }),
            }).then(() => {
              console.log(`[MeetingChat] Notified remote agent ${agentName} at ${agentHostUrl}`)
            }).catch(err => {
              console.warn(`[MeetingChat] Failed to notify remote ${agentName}:`, err)
            })
          }
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
