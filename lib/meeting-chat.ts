/**
 * Meeting Chat — Shared Timeline Storage
 *
 * STUB: Stream A (Watson) will implement the full JSONL-backed storage.
 * This stub provides the interface so Stream B (WebSocket) and
 * Stream C (frontend) can build against it.
 */

export interface ChatMessageInput {
  from: string
  fromAlias?: string
  fromLabel?: string
  fromType: string       // 'human' | 'agent'
  message: string
  mentions?: string[]
}

export interface ChatMessage {
  id: string
  from: string
  fromAlias?: string
  fromLabel?: string
  fromType: string
  message: string
  mentions: string[]
  timestamp: string
  meetingId: string
}

/**
 * Append a message to a meeting's shared chat log.
 * Returns the stored message with generated id and timestamp.
 */
export function appendChatMessage(meetingId: string, input: ChatMessageInput): ChatMessage {
  const message: ChatMessage = {
    id: `chat-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    from: input.from,
    fromAlias: input.fromAlias,
    fromLabel: input.fromLabel,
    fromType: input.fromType || 'agent',
    message: input.message,
    mentions: input.mentions || [],
    timestamp: new Date().toISOString(),
    meetingId,
  }

  // TODO: Stream A will persist to JSONL at ~/.aimaestro/teams/meetings/<id>/chat.jsonl
  console.log(`[MeetingChat] Message from ${message.fromAlias || message.from} in meeting ${meetingId}: ${message.message.slice(0, 80)}`)

  return message
}

/**
 * Get chat messages for a meeting, optionally since a timestamp.
 */
export function getChatMessages(meetingId: string, since?: string): ChatMessage[] {
  // TODO: Stream A will read from JSONL storage
  console.log(`[MeetingChat] getChatMessages(${meetingId}, since=${since || 'all'}) — stub, returning empty`)
  return []
}
