'use client'

import { useState, useEffect, useCallback, useRef } from 'react'

/**
 * Chat message from the shared meeting timeline.
 * Matches the ChatMessage shape from lib/meeting-chat-service.ts.
 */
export interface MeetingMessage {
  id: string
  from: string
  fromAlias: string
  fromType: 'human' | 'agent'
  message: string
  timestamp: string
  mentions: string[]
  mentionAll: boolean
  // Computed by the hook
  isMine: boolean
  displayFrom: string
  // Legacy compat fields for MeetingChatPanel
  preview: string
  to: string
  toAlias?: string
  subject: string
  status: string
  priority: string
  type: string
  fromLabel?: string
}

interface UseMeetingMessagesOptions {
  meetingId: string | null
  participantIds: string[]
  teamName: string
  isActive: boolean
  operatorId?: string
  operatorName?: string
}

interface UseMeetingMessagesResult {
  messages: MeetingMessage[]
  unreadCount: number
  sendToAgent: (agentId: string, message: string) => Promise<void>
  broadcastToAll: (message: string) => Promise<void>
  continueMeeting: () => Promise<void>
  markAsRead: () => void
  loading: boolean
}

export function useMeetingMessages({
  meetingId,
  participantIds,
  teamName,
  isActive,
  operatorId,
  operatorName,
}: UseMeetingMessagesOptions): UseMeetingMessagesResult {
  const opId = operatorId || 'maestro'
  const opName = operatorName || 'Maestro'

  const [messages, setMessages] = useState<MeetingMessage[]>([])
  const [loading, setLoading] = useState(false)
  const wsRef = useRef<WebSocket | null>(null)
  const seenCountRef = useRef(0)
  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null)

  // Convert a raw chat message from the API into a MeetingMessage
  const toMeetingMessage = useCallback((msg: any): MeetingMessage => ({
    id: msg.id,
    from: msg.from,
    fromAlias: msg.fromAlias || msg.from,
    fromType: msg.fromType || 'agent',
    message: msg.message,
    timestamp: msg.timestamp,
    mentions: msg.mentions || [],
    mentionAll: msg.mentionAll || false,
    isMine: msg.from === opId || msg.fromAlias === opName,
    displayFrom: msg.fromAlias || msg.from,
    // Legacy compat
    preview: msg.message,
    to: 'all',
    subject: `[MEETING:${meetingId}]`,
    status: 'read',
    priority: 'normal',
    type: 'notification',
    fromLabel: msg.fromAlias,
  }), [meetingId, opId, opName])

  // Fetch full history from the shared timeline API
  const fetchHistory = useCallback(async () => {
    if (!meetingId || !isActive) return

    try {
      const res = await fetch(`/api/meetings/${meetingId}/chat`)
      if (!res.ok) return

      const data = await res.json()
      const msgs = (data.messages || []).map(toMeetingMessage)
      setMessages(msgs)
      seenCountRef.current = msgs.length
    } catch {
      // Silently fail
    }
  }, [meetingId, isActive, toMeetingMessage])

  // Connect WebSocket for real-time updates
  useEffect(() => {
    if (!meetingId || !isActive) return

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:'
    const wsUrl = `${protocol}//${window.location.host}/meeting-chat?meetingId=${meetingId}`

    try {
      const ws = new WebSocket(wsUrl)
      wsRef.current = ws

      ws.onopen = () => {
        // Subscribe to this meeting's chat
        ws.send(JSON.stringify({ type: 'subscribe', meetingId }))
      }

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data)

          if (data.type === 'message' && data.data) {
            const msg = toMeetingMessage(data.data)
            setMessages(prev => {
              // Dedupe by ID (in case we get both WS + poll)
              if (prev.some(m => m.id === msg.id)) return prev
              // Replace optimistic message if it exists
              const withoutOptimistic = prev.filter(m => !m.id.startsWith('optimistic-'))
              return [...withoutOptimistic, msg]
            })
          }
          // loopGuard events handled by MeetingChatPanel via its own polling
        } catch {
          // Ignore malformed messages
        }
      }

      ws.onclose = () => {
        wsRef.current = null
        // Fall back to polling if WS disconnects
        if (isActive && meetingId) {
          pollIntervalRef.current = setInterval(fetchHistory, 5000)
        }
      }

      ws.onerror = () => {
        // Will trigger onclose
      }
    } catch {
      // WebSocket not available — fall back to polling
      pollIntervalRef.current = setInterval(fetchHistory, 5000)
    }

    return () => {
      if (wsRef.current) {
        wsRef.current.close()
        wsRef.current = null
      }
      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current)
        pollIntervalRef.current = null
      }
    }
  }, [meetingId, isActive, toMeetingMessage, fetchHistory])

  // Initial fetch
  useEffect(() => {
    if (!meetingId || !isActive) {
      setMessages([])
      seenCountRef.current = 0
      return
    }
    setLoading(true)
    fetchHistory().finally(() => setLoading(false))
  }, [meetingId, isActive, fetchHistory])

  // Optimistic message helper
  const addOptimistic = useCallback((text: string) => {
    const optimistic: MeetingMessage = {
      id: `optimistic-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      from: opId,
      fromAlias: opName,
      fromType: 'human',
      message: text,
      timestamp: new Date().toISOString(),
      mentions: [],
      mentionAll: false,
      isMine: true,
      displayFrom: opName,
      preview: text,
      to: 'all',
      subject: `[MEETING:${meetingId}]`,
      status: 'unread',
      priority: 'normal',
      type: 'notification',
      fromLabel: opName,
    }
    setMessages(prev => [...prev, optimistic])
  }, [meetingId, opId, opName])

  // Post to the shared timeline (not AMP)
  const postToTimeline = useCallback(async (message: string) => {
    if (!meetingId) return

    await fetch(`/api/meetings/${meetingId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: opId,
        fromAlias: opName,
        fromType: 'human',
        message,
      }),
    })
  }, [meetingId, opId, opName])

  const sendToAgent = useCallback(async (_agentId: string, message: string) => {
    // With the shared timeline, all messages go to the same log.
    // The @mention in the message text handles targeting.
    addOptimistic(message)
    try {
      await postToTimeline(message)
    } catch (err) {
      console.error('Failed to send message:', err)
    }
  }, [addOptimistic, postToTimeline])

  const broadcastToAll = useCallback(async (message: string) => {
    addOptimistic(message)
    try {
      await postToTimeline(message)
    } catch (err) {
      console.error('Failed to broadcast:', err)
    }
  }, [addOptimistic, postToTimeline])

  const continueMeeting = useCallback(async () => {
    if (!meetingId) return
    try {
      await fetch(`/api/meetings/${meetingId}/loop-guard`, { method: 'POST' })
      // Post a system message so everyone sees the continue
      await postToTimeline('/continue')
    } catch (err) {
      console.error('Failed to continue meeting:', err)
    }
  }, [meetingId, postToTimeline])

  const markAsRead = useCallback(() => {
    seenCountRef.current = messages.length
  }, [messages.length])

  const unreadCount = Math.max(0, messages.length - seenCountRef.current)

  return {
    messages,
    unreadCount,
    sendToAgent,
    broadcastToAll,
    continueMeeting,
    markAsRead,
    loading,
  }
}
