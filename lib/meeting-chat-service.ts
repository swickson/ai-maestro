/**
 * Meeting Chat Service — Shared timeline message log
 *
 * Replaces AMP fan-out with a single shared JSONL log per meeting.
 * All participants (human + agents) read and write to the same log.
 * This is the "shared room" model inspired by agentchattr.
 *
 * Storage: ~/.aimaestro/teams/meetings/{meetingId}/chat.jsonl
 * Format: One JSON object per line, append-only
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { v4 as uuidv4 } from 'uuid'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ChatMessage {
  id: string                    // UUID
  meetingId: string             // Meeting this message belongs to
  from: string                  // Sender identifier (agent ID, operator ID)
  fromAlias: string             // Display name for the sender
  fromType: 'human' | 'agent'  // Distinguish operator from agents
  message: string               // Message content
  mentions: string[]            // Parsed @mentions (agent names)
  mentionAll: boolean           // Whether @all was used
  timestamp: string             // ISO 8601
}

export interface PostChatMessageParams {
  meetingId: string
  from: string
  fromAlias: string
  fromType: 'human' | 'agent'
  message: string
  mentions?: string[]
  mentionAll?: boolean
}

export interface GetChatMessagesParams {
  meetingId: string
  since?: string               // ISO timestamp — return messages after this
  limit?: number               // Max messages to return (default: 200)
}

export interface ChatMessagesResult {
  messages: ChatMessage[]
  count: number
  meetingId: string
}

// ─── Storage ────────────────────────────────────────────────────────────────

const AIMAESTRO_DIR = path.join(os.homedir(), '.aimaestro')
const MEETINGS_DIR = path.join(AIMAESTRO_DIR, 'teams', 'meetings')

function getChatLogPath(meetingId: string): string {
  return path.join(MEETINGS_DIR, meetingId, 'chat.jsonl')
}

function ensureMeetingDir(meetingId: string): void {
  const dir = path.join(MEETINGS_DIR, meetingId)
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Append a message to the shared chat log.
 * Returns the created message with generated ID and timestamp.
 */
export function postChatMessage(params: PostChatMessageParams): ChatMessage {
  const { meetingId, from, fromAlias, fromType, message, mentions, mentionAll } = params

  const chatMessage: ChatMessage = {
    id: uuidv4(),
    meetingId,
    from,
    fromAlias,
    fromType,
    message,
    mentions: mentions || [],
    mentionAll: mentionAll || false,
    timestamp: new Date().toISOString(),
  }

  ensureMeetingDir(meetingId)
  const logPath = getChatLogPath(meetingId)
  fs.appendFileSync(logPath, JSON.stringify(chatMessage) + '\n', 'utf-8')

  return chatMessage
}

/**
 * Read messages from the shared chat log.
 * Supports cursor-based pagination via `since` timestamp.
 */
export function getChatMessages(params: GetChatMessagesParams): ChatMessagesResult {
  const { meetingId, since, limit = 200 } = params
  const logPath = getChatLogPath(meetingId)

  if (!fs.existsSync(logPath)) {
    return { messages: [], count: 0, meetingId }
  }

  const lines = fs.readFileSync(logPath, 'utf-8').split('\n').filter(Boolean)
  let messages: ChatMessage[] = []

  for (const line of lines) {
    try {
      messages.push(JSON.parse(line))
    } catch {
      // Skip malformed lines
    }
  }

  // Apply cursor filter
  if (since) {
    const sinceTime = new Date(since).getTime()
    messages = messages.filter(m => new Date(m.timestamp).getTime() > sinceTime)
  }

  // Apply limit (take latest N)
  if (messages.length > limit) {
    messages = messages.slice(-limit)
  }

  return { messages, count: messages.length, meetingId }
}

/**
 * Delete the chat log for a meeting (cleanup).
 */
export function deleteChatLog(meetingId: string): boolean {
  const logPath = getChatLogPath(meetingId)
  try {
    if (fs.existsSync(logPath)) {
      fs.unlinkSync(logPath)
    }
    return true
  } catch {
    return false
  }
}
