import { describe, it, expect } from 'vitest'
import { generateMessageId } from '@/lib/types/amp-message'

/**
 * Guards the crypto-strong message-ID generator (kanban 4bee9be0).
 *
 * Regression target: the suffix was previously `Math.random().toString(36).substring(2, 9)`
 * — non-crypto AND variable-length (could yield fewer than 7 chars when low-order
 * base36 digits were zero). A short/weak suffix raises silent ID-collision risk, and a
 * collision is rendered SILENTLY by amp-helper.sh `find_message_file` (returns the
 * alphabetically-first sender folder with no warning), causing a wrong-sender display.
 * The fix uses `crypto.randomBytes(8).toString('hex')` — fixed 16-char hex, 64 bits.
 */
describe('generateMessageId', () => {
  // Must satisfy amp-helper.sh validate_message_id: ^msg[_-][0-9]+[_-][a-zA-Z0-9]+$
  const VALIDATOR = /^msg[_-][0-9]+[_-][a-zA-Z0-9]+$/

  it('matches the AMP message-id format (passes amp-helper validate_message_id)', () => {
    expect(generateMessageId()).toMatch(VALIDATOR)
  })

  it('uses an ms timestamp and a FIXED-LENGTH 16-char hex suffix (no variable-length regression)', () => {
    const id = generateMessageId()
    const m = id.match(/^msg_(\d+)_([0-9a-f]+)$/)
    expect(m).not.toBeNull()
    const [, ts, suffix] = m!
    // ms timestamp (13 digits in this era), not 10-digit seconds
    expect(ts.length).toBe(13)
    // crypto.randomBytes(8) → always exactly 16 hex chars
    expect(suffix).toHaveLength(16)
  })

  it('produces hex-only suffixes (guards against reverting to base36 Math.random)', () => {
    for (let i = 0; i < 200; i++) {
      const suffix = generateMessageId().split('_')[2]
      expect(suffix).toMatch(/^[0-9a-f]{16}$/)
    }
  })

  it('is collision-free across a large batch (entropy guard)', () => {
    const ids = new Set<string>()
    const N = 5000
    for (let i = 0; i < N; i++) ids.add(generateMessageId())
    expect(ids.size).toBe(N)
  })
})
