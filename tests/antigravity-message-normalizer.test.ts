/**
 * Antigravity (agy) message normalizer — stub spec for v0.30.87.
 *
 * Real conversation-file shape is unknown until a logged-in cloud agent
 * generates samples post-migration (kanban 49cc27d7). Until then, the
 * normalizer returns null for every line so ChatView shows the empty-state
 * for antigravity agents without rendering garbage.
 *
 * These tests pin the stub behavior so future real-implementation PRs
 * cannot accidentally regress the empty-state branch.
 */

import { describe, it, expect } from 'vitest'
import { normalizeAntigravityLine } from '@/lib/antigravity-message-normalizer'

describe('normalizeAntigravityLine (stub)', () => {
  it('returns null for any shape — user-like', () => {
    expect(
      normalizeAntigravityLine({
        id: 'a',
        timestamp: '2026-05-22T19:00:00Z',
        type: 'user',
        content: [{ text: 'hi' }],
      }),
    ).toBeNull()
  })

  it('returns null for any shape — assistant-like', () => {
    expect(
      normalizeAntigravityLine({
        id: 'b',
        timestamp: '2026-05-22T19:00:01Z',
        type: 'assistant',
        content: 'hello back',
      }),
    ).toBeNull()
  })

  it('returns null for null/undefined/empty', () => {
    expect(normalizeAntigravityLine(null)).toBeNull()
    expect(normalizeAntigravityLine(undefined)).toBeNull()
    expect(normalizeAntigravityLine({})).toBeNull()
  })

  it('returns null for strings, numbers, arrays — defensive', () => {
    expect(normalizeAntigravityLine('not an object')).toBeNull()
    expect(normalizeAntigravityLine(42)).toBeNull()
    expect(normalizeAntigravityLine(['array', 'not', 'object'])).toBeNull()
  })
})
