/**
 * Memory Retrieval Middleware — Unit Tests
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock dependencies
vi.mock('@/lib/agent-registry', () => ({
  loadAgents: vi.fn(() => []),
}))

vi.mock('@/lib/memory/search', () => ({
  searchMemories: vi.fn(async () => []),
}))

import {
  shouldTriggerSearch,
  formatMemoryContext,
  clearAllCaches,
} from '@/lib/memory/retrieval-middleware'
import type { MemorySearchResult } from '@/lib/memory/types'

// Helper to create a minimal RetrievalContext
function makeContext(overrides: Record<string, any> = {}) {
  return {
    agentId: 'agent-1',
    agentDb: {} as any,
    message: {
      messageText: 'What is the deployment process?',
      isNewConversation: false,
      threadId: 'thread-1',
      ...overrides,
    },
  }
}

describe('retrieval-middleware', () => {
  beforeEach(() => {
    clearAllCaches()
  })

  describe('shouldTriggerSearch', () => {
    it('triggers on new conversation', () => {
      const ctx = makeContext({ isNewConversation: true })
      expect(shouldTriggerSearch(ctx)).toBe(true)
    })

    it('skips very short messages', () => {
      const ctx = makeContext({ messageText: 'ok' })
      expect(shouldTriggerSearch(ctx)).toBe(false)
    })

    it('skips empty messages', () => {
      const ctx = makeContext({ messageText: '' })
      expect(shouldTriggerSearch(ctx)).toBe(false)
    })

    it('triggers on first message in a thread (no previous keywords)', () => {
      const ctx = makeContext({
        messageText: 'How does the authentication system work?',
        threadId: 'new-thread',
      })
      expect(shouldTriggerSearch(ctx)).toBe(true)
    })
  })

  describe('formatMemoryContext', () => {
    it('returns null for empty memories', () => {
      expect(formatMemoryContext([])).toBeNull()
    })

    it('formats a single memory', () => {
      const memories: MemorySearchResult[] = [
        {
          memory_id: 'mem-1',
          category: 'fact',
          content: 'The production database is PostgreSQL',
          context: null,
          confidence: 0.92,
          reinforcement_count: 4,
          similarity: 0.85,
        },
      ]

      const result = formatMemoryContext(memories)
      expect(result).not.toBeNull()
      expect(result).toContain('<memory-context>')
      expect(result).toContain('</memory-context>')
      expect(result).toContain('[fact]')
      expect(result).toContain('production database is PostgreSQL')
      expect(result).toContain('confidence: 0.92')
      expect(result).toContain('reinforced 4 times')
    })

    it('formats multiple memories with numbering', () => {
      const memories: MemorySearchResult[] = [
        {
          memory_id: 'mem-1',
          category: 'fact',
          content: 'First memory',
          context: null,
          confidence: 0.9,
          reinforcement_count: 2,
          similarity: 0.85,
        },
        {
          memory_id: 'mem-2',
          category: 'pattern',
          content: 'Second memory',
          context: null,
          confidence: 0.8,
          reinforcement_count: 0,
          similarity: 0.75,
        },
      ]

      const result = formatMemoryContext(memories)!
      expect(result).toContain('1. [fact] First memory')
      expect(result).toContain('2. [pattern] Second memory')
      // No reinforcement note for 0 reinforcements
      expect(result).not.toContain('reinforced 0')
    })

    it('includes the warning about verification', () => {
      const memories: MemorySearchResult[] = [
        {
          memory_id: 'mem-1',
          category: 'insight',
          content: 'Test',
          context: null,
          confidence: 0.9,
          reinforcement_count: 0,
          similarity: 0.85,
        },
      ]

      const result = formatMemoryContext(memories)!
      expect(result).toContain('verify against current state before acting')
    })
  })
})
