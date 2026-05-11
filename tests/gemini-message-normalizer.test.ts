/**
 * Gemini Message Normalizer Tests
 *
 * Pins the Gemini-JSONL → Claude-shape transform so cloud-Gemini chat-panel
 * rendering stays provider-agnostic in ChatView. Sample shapes are
 * empirically grounded from Watson's 2026-05-11 Holmes Mason/Optic probe
 * (kanban d937c33d).
 */

import { describe, it, expect } from 'vitest'

import { normalizeGeminiLine } from '@/lib/gemini-message-normalizer'

describe('normalizeGeminiLine', () => {
  it('returns null for the metadata header line (kind + sessionId + startTime)', () => {
    const raw = {
      sessionId: 'abc123',
      projectHash: 'def456',
      startTime: '2026-05-11T15:00:00Z',
      lastUpdated: '2026-05-11T15:01:00Z',
      kind: 'session',
    }
    expect(normalizeGeminiLine(raw)).toBeNull()
  })

  it('returns null for $set state-update sidecar lines', () => {
    expect(normalizeGeminiLine({ $set: { lastUpdated: '2026-05-11T15:02:00Z' } })).toBeNull()
  })

  it('returns null for type=info system events', () => {
    expect(normalizeGeminiLine({ id: 'evt-1', type: 'info', content: 'Gemini CLI update available' })).toBeNull()
  })

  it('normalizes type=user with content array [{text}] to Claude-shape user message', () => {
    const raw = {
      id: 'evt-2',
      timestamp: '2026-05-11T15:03:00Z',
      type: 'user',
      content: [{ text: 'hello gemini' }],
    }
    const out = normalizeGeminiLine(raw)
    expect(out).toEqual({
      type: 'user',
      message: { content: [{ type: 'text', text: 'hello gemini' }] },
      timestamp: '2026-05-11T15:03:00Z',
      uuid: 'evt-2',
    })
  })

  it('normalizes type=gemini with plain string content to Claude-shape assistant message', () => {
    const raw = {
      id: 'evt-3',
      timestamp: '2026-05-11T15:03:05Z',
      type: 'gemini',
      content: 'OK',
    }
    const out = normalizeGeminiLine(raw)
    expect(out).toEqual({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'OK' }] },
      timestamp: '2026-05-11T15:03:05Z',
      uuid: 'evt-3',
    })
  })

  it('joins multiple text blocks in a content array with double-newline (mirrors ChatView getMessageContent)', () => {
    const raw = {
      id: 'evt-4',
      type: 'user',
      content: [{ text: 'first paragraph' }, { text: 'second paragraph' }],
    }
    const out = normalizeGeminiLine(raw)
    expect(out?.message.content[0].text).toBe('first paragraph\n\nsecond paragraph')
  })

  it('returns null for empty content (no renderable text)', () => {
    expect(normalizeGeminiLine({ id: 'x', type: 'user', content: [] })).toBeNull()
    expect(normalizeGeminiLine({ id: 'y', type: 'gemini', content: '' })).toBeNull()
  })

  it('returns null for unrecognized types (defensive — Gemini may add new event types)', () => {
    expect(normalizeGeminiLine({ id: 'z', type: 'tool', content: 'whatever' })).toBeNull()
  })

  it('returns null for non-object inputs', () => {
    expect(normalizeGeminiLine(null)).toBeNull()
    expect(normalizeGeminiLine('not-an-object')).toBeNull()
    expect(normalizeGeminiLine(42)).toBeNull()
  })
})
