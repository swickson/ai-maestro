import { describe, it, expect } from 'vitest'
import { chatReconnectDelay } from '@/lib/chat-utils'

describe('chatReconnectDelay', () => {
  it('grows exponentially from 1s', () => {
    expect(chatReconnectDelay(0)).toBe(1000)
    expect(chatReconnectDelay(1)).toBe(2000)
    expect(chatReconnectDelay(2)).toBe(4000)
    expect(chatReconnectDelay(3)).toBe(8000)
    expect(chatReconnectDelay(4)).toBe(16000)
    expect(chatReconnectDelay(5)).toBe(30000) // 2^5=32s capped to 30s
  })

  it('caps at 30s and never gives up (no Infinity / NaN for large attempts)', () => {
    expect(chatReconnectDelay(6)).toBe(30000)
    expect(chatReconnectDelay(50)).toBe(30000)
    expect(chatReconnectDelay(1000)).toBe(30000)
  })

  it('is finite and positive for every attempt — the reconnect loop must always retry', () => {
    for (let n = 0; n <= 100; n++) {
      const d = chatReconnectDelay(n)
      expect(Number.isFinite(d)).toBe(true)
      expect(d).toBeGreaterThan(0)
      expect(d).toBeLessThanOrEqual(30000)
    }
  })

  it('clamps invalid input defensively', () => {
    expect(chatReconnectDelay(-5)).toBe(1000)
    expect(chatReconnectDelay(2.9)).toBe(4000)
  })
})
