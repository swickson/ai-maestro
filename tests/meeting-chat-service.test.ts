import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

// Mock uuid
vi.mock('uuid', () => ({
  v4: () => 'test-uuid-' + Math.random().toString(36).slice(2, 8),
}))

import {
  postChatMessage,
  getChatMessages,
  deleteChatLog,
} from '@/lib/meeting-chat-service'

const TEST_MEETING_ID = 'test-meeting-001'
const CHAT_DIR = path.join(os.homedir(), '.aimaestro', 'teams', 'meetings', TEST_MEETING_ID)
const CHAT_LOG = path.join(CHAT_DIR, 'chat.jsonl')

describe('meeting-chat-service', () => {
  beforeEach(() => {
    // Clean up test data
    if (fs.existsSync(CHAT_LOG)) {
      fs.unlinkSync(CHAT_LOG)
    }
  })

  afterEach(() => {
    // Clean up test data
    if (fs.existsSync(CHAT_LOG)) {
      fs.unlinkSync(CHAT_LOG)
    }
    if (fs.existsSync(CHAT_DIR)) {
      fs.rmdirSync(CHAT_DIR)
    }
  })

  describe('postChatMessage', () => {
    it('creates a message with all required fields', () => {
      const msg = postChatMessage({
        meetingId: TEST_MEETING_ID,
        from: 'shane',
        fromAlias: 'Shane',
        fromType: 'human',
        message: 'Hello team!',
      })

      expect(msg.id).toBeTruthy()
      expect(msg.meetingId).toBe(TEST_MEETING_ID)
      expect(msg.from).toBe('shane')
      expect(msg.fromAlias).toBe('Shane')
      expect(msg.fromType).toBe('human')
      expect(msg.message).toBe('Hello team!')
      expect(msg.mentions).toEqual([])
      expect(msg.mentionAll).toBe(false)
      expect(msg.timestamp).toBeTruthy()
    })

    it('stores mentions and mentionAll', () => {
      const msg = postChatMessage({
        meetingId: TEST_MEETING_ID,
        from: 'shane',
        fromAlias: 'Shane',
        fromType: 'human',
        message: '@kai @celestia review this',
        mentions: ['kai', 'celestia'],
        mentionAll: false,
      })

      expect(msg.mentions).toEqual(['kai', 'celestia'])
      expect(msg.mentionAll).toBe(false)
    })

    it('appends to JSONL file', () => {
      postChatMessage({
        meetingId: TEST_MEETING_ID,
        from: 'shane',
        fromAlias: 'Shane',
        fromType: 'human',
        message: 'First message',
      })

      postChatMessage({
        meetingId: TEST_MEETING_ID,
        from: 'agent-1',
        fromAlias: 'Kai',
        fromType: 'agent',
        message: 'Second message',
      })

      const lines = fs.readFileSync(CHAT_LOG, 'utf-8').split('\n').filter(Boolean)
      expect(lines.length).toBe(2)

      const msg1 = JSON.parse(lines[0])
      const msg2 = JSON.parse(lines[1])
      expect(msg1.message).toBe('First message')
      expect(msg2.message).toBe('Second message')
      expect(msg2.fromType).toBe('agent')
    })
  })

  describe('getChatMessages', () => {
    it('returns empty for nonexistent meeting', () => {
      const result = getChatMessages({ meetingId: 'nonexistent' })
      expect(result.messages).toEqual([])
      expect(result.count).toBe(0)
    })

    it('returns all messages', () => {
      postChatMessage({ meetingId: TEST_MEETING_ID, from: 'a', fromAlias: 'A', fromType: 'human', message: 'msg1' })
      postChatMessage({ meetingId: TEST_MEETING_ID, from: 'b', fromAlias: 'B', fromType: 'agent', message: 'msg2' })
      postChatMessage({ meetingId: TEST_MEETING_ID, from: 'a', fromAlias: 'A', fromType: 'human', message: 'msg3' })

      const result = getChatMessages({ meetingId: TEST_MEETING_ID })
      expect(result.count).toBe(3)
      expect(result.messages[0].message).toBe('msg1')
      expect(result.messages[2].message).toBe('msg3')
    })

    it('supports since cursor', () => {
      const msg1 = postChatMessage({ meetingId: TEST_MEETING_ID, from: 'a', fromAlias: 'A', fromType: 'human', message: 'old' })

      // Small delay to ensure different timestamps
      const sinceTs = new Date().toISOString()

      // Need a tiny delay for timestamp ordering
      const msg2 = postChatMessage({ meetingId: TEST_MEETING_ID, from: 'b', fromAlias: 'B', fromType: 'agent', message: 'new' })

      const result = getChatMessages({ meetingId: TEST_MEETING_ID, since: msg1.timestamp })
      // msg2 should be after msg1's timestamp
      expect(result.messages.every(m => m.message !== 'old' || new Date(m.timestamp).getTime() > new Date(msg1.timestamp).getTime())).toBe(true)
    })

    it('respects limit', () => {
      for (let i = 0; i < 10; i++) {
        postChatMessage({ meetingId: TEST_MEETING_ID, from: 'a', fromAlias: 'A', fromType: 'human', message: `msg${i}` })
      }

      const result = getChatMessages({ meetingId: TEST_MEETING_ID, limit: 3 })
      expect(result.count).toBe(3)
      // Should return the LATEST 3
      expect(result.messages[0].message).toBe('msg7')
      expect(result.messages[2].message).toBe('msg9')
    })
  })

  describe('deleteChatLog', () => {
    it('deletes existing log', () => {
      postChatMessage({ meetingId: TEST_MEETING_ID, from: 'a', fromAlias: 'A', fromType: 'human', message: 'test' })
      expect(fs.existsSync(CHAT_LOG)).toBe(true)

      const result = deleteChatLog(TEST_MEETING_ID)
      expect(result).toBe(true)
      expect(fs.existsSync(CHAT_LOG)).toBe(false)
    })

    it('returns true for nonexistent log', () => {
      const result = deleteChatLog('nonexistent')
      expect(result).toBe(true)
    })
  })
})
