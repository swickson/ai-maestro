import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  enqueueForSession,
  drainForSession,
  peekForSession,
  clearAll,
  inferKindFromProgram,
  shouldUseAdditionalContext,
  sanitizeForRawInject,
} from '@/lib/meeting-inject-queue'

describe('meeting-inject-queue', () => {
  beforeEach(() => {
    clearAll()
  })

  describe('enqueue / drain', () => {
    it('drains empty queue as []', () => {
      expect(drainForSession('nobody')).toEqual([])
    })

    it('returns enqueued items in FIFO order', () => {
      enqueueForSession('watson', 'one')
      enqueueForSession('watson', 'two')
      enqueueForSession('watson', 'three')
      const drained = drainForSession('watson')
      expect(drained.map(m => m.text)).toEqual(['one', 'two', 'three'])
    })

    it('drain is destructive — second call returns []', () => {
      enqueueForSession('watson', 'x')
      drainForSession('watson')
      expect(drainForSession('watson')).toEqual([])
    })

    it('peek is non-destructive', () => {
      enqueueForSession('watson', 'x')
      expect(peekForSession('watson').map(m => m.text)).toEqual(['x'])
      expect(peekForSession('watson').map(m => m.text)).toEqual(['x'])
    })

    it('keys are per-session — no cross-talk', () => {
      enqueueForSession('watson', 'for-watson')
      enqueueForSession('kai', 'for-kai')
      expect(drainForSession('watson').map(m => m.text)).toEqual(['for-watson'])
      expect(drainForSession('kai').map(m => m.text)).toEqual(['for-kai'])
    })

    it('rejects empty session or empty text', () => {
      enqueueForSession('', 'body')
      enqueueForSession('watson', '')
      expect(drainForSession('watson')).toEqual([])
      expect(drainForSession('')).toEqual([])
    })

    it('stamps each entry with an ISO timestamp', () => {
      enqueueForSession('watson', 'x')
      const [item] = drainForSession('watson')
      expect(item.enqueuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    })
  })

  describe('inferKindFromProgram', () => {
    it('recognizes Claude variants', () => {
      expect(inferKindFromProgram('Claude Code')).toBe('claude')
      expect(inferKindFromProgram('claude-code')).toBe('claude')
    })

    it('recognizes Codex / GPT', () => {
      expect(inferKindFromProgram('Codex CLI')).toBe('codex')
      expect(inferKindFromProgram('gpt-5-codex')).toBe('codex')
    })

    it('recognizes Gemini', () => {
      expect(inferKindFromProgram('Gemini CLI')).toBe('gemini')
    })

    it('falls back to unknown', () => {
      expect(inferKindFromProgram('Aider')).toBe('unknown')
      expect(inferKindFromProgram(undefined)).toBe('unknown')
    })
  })

  describe('shouldUseAdditionalContext flag', () => {
    const ORIGINAL = process.env.MAESTRO_MEETING_CONTEXT_KINDS

    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.MAESTRO_MEETING_CONTEXT_KINDS
      else process.env.MAESTRO_MEETING_CONTEXT_KINDS = ORIGINAL
    })

    it('defaults to false when flag unset', () => {
      delete process.env.MAESTRO_MEETING_CONTEXT_KINDS
      expect(shouldUseAdditionalContext('Claude Code')).toBe(false)
    })

    it('opts in a single kind', () => {
      process.env.MAESTRO_MEETING_CONTEXT_KINDS = 'claude'
      expect(shouldUseAdditionalContext('Claude Code')).toBe(true)
      expect(shouldUseAdditionalContext('Gemini CLI')).toBe(false)
    })

    it('opts in multiple kinds via comma list', () => {
      process.env.MAESTRO_MEETING_CONTEXT_KINDS = 'claude,gemini'
      expect(shouldUseAdditionalContext('Claude Code')).toBe(true)
      expect(shouldUseAdditionalContext('Gemini CLI')).toBe(true)
      expect(shouldUseAdditionalContext('Codex CLI')).toBe(false)
    })

    it('"all" opts in every known kind', () => {
      process.env.MAESTRO_MEETING_CONTEXT_KINDS = 'all'
      expect(shouldUseAdditionalContext('Claude Code')).toBe(true)
      expect(shouldUseAdditionalContext('Gemini CLI')).toBe(true)
      expect(shouldUseAdditionalContext('Codex CLI')).toBe(true)
    })

    it('never opts in unknown kinds', () => {
      process.env.MAESTRO_MEETING_CONTEXT_KINDS = 'all'
      expect(shouldUseAdditionalContext('Aider')).toBe(false)
      expect(shouldUseAdditionalContext(undefined)).toBe(false)
    })
  })

  describe('sanitizeForRawInject', () => {
    it('prefixes a leading `!` at string start with a space', () => {
      expect(sanitizeForRawInject('!cmd')).toBe(' !cmd')
    })

    it('prefixes `!` at line-start after a newline', () => {
      expect(sanitizeForRawInject('line one\n!trigger')).toBe('line one\n !trigger')
    })

    it('handles multiple line-start triggers', () => {
      const input = '!one\nsafe\n!two\nalso safe\n!three'
      const expected = ' !one\nsafe\n !two\nalso safe\n !three'
      expect(sanitizeForRawInject(input)).toBe(expected)
    })

    it('leaves mid-line `!` alone', () => {
      expect(sanitizeForRawInject('what is this!?')).toBe('what is this!?')
      expect(sanitizeForRawInject('no change here')).toBe('no change here')
    })

    it('is a no-op on empty input', () => {
      expect(sanitizeForRawInject('')).toBe('')
    })
  })
})
