import { describe, it, expect } from 'vitest'
import { asciiNormalizeNotification } from '@/lib/notification-service'

/**
 * Guards the wake-injection ASCII normalizer.
 *
 * The notification line is injected verbatim via `echo '<msg>'` send-keys, so any
 * non-ASCII (the 🟠/🔴 priority prefix, em-dashes/smart-quotes/emoji from raw AMP
 * subjects) rides into the model's context on the turn it generates its first tool
 * call — a suspected trigger for the cross-host "court"/literal-<invoke> tool-call
 * serialization stall. This guard pins that the normalizer produces plain printable
 * ASCII while staying readable.
 */
describe('asciiNormalizeNotification', () => {
  it('strips the emoji priority prefix and leaves clean ASCII', () => {
    const out = asciiNormalizeNotification('🟠 [HIGH] [MESSAGE] From: alice - deployed - check your inbox')
    expect(out).toBe('[HIGH] [MESSAGE] From: alice - deployed - check your inbox')
    expect(/[^\x20-\x7E]/.test(out)).toBe(false)
  })

  it('maps em/en dashes to hyphens (peer subject style)', () => {
    expect(asciiNormalizeNotification('KNOB LIVE — host deployed 0.31.29')).toBe('KNOB LIVE - host deployed 0.31.29')
    expect(asciiNormalizeNotification('a–b')).toBe('a-b')
  })

  it('maps smart quotes and ellipsis to ASCII', () => {
    expect(asciiNormalizeNotification('“quote” ‘x’ and more…')).toBe('"quote" \'x\' and more...')
  })

  it('strips arbitrary emoji from a raw subject and collapses the gap', () => {
    const out = asciiNormalizeNotification('[MESSAGE] From: a - 🔴 done ✅ now - check your inbox')
    expect(/[^\x20-\x7E]/.test(out)).toBe(false)
    expect(out).toContain('[MESSAGE] From: a -')
    expect(out).toContain('done')
    expect(out).not.toMatch(/ {2,}/)
  })

  it('leaves already-ASCII text unchanged (minus trim)', () => {
    const s = '[MESSAGE] From: alice - M2 follow-up ready (both guards) - check your inbox'
    expect(asciiNormalizeNotification(s)).toBe(s)
  })
})
