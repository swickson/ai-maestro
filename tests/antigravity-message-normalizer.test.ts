/**
 * Antigravity (agy) history.jsonl normalizer (#219).
 *
 * Antigravity has no JSONL conversation transcript — the full convo is in
 * protobuf/sqlite blobs (black box). The only JSONL is history.jsonl, a flat
 * log of USER prompts: {display, timestamp, workspace, conversationId?}. These
 * tests pin the display→user mapping, the ms-epoch→ISO timestamp conversion,
 * and the skip rules (missing/blank display, non-object lines). Assistant turns
 * are intentionally unrepresented (documented limitation).
 */

import { describe, it, expect } from 'vitest'
import { normalizeAntigravityLine } from '@/lib/antigravity-message-normalizer'

describe('normalizeAntigravityLine (#219)', () => {
  it('maps a history.jsonl line (display + ms timestamp) to a USER message', () => {
    const msg = normalizeAntigravityLine({
      display: 'You are dev-allianceos-han, read GEMINI.md',
      timestamp: 1779482879705,
      workspace: '/workspace',
      conversationId: '57d9416c-dede-4ea5-b71d-694b426eb76a',
    })
    expect(msg).not.toBeNull()
    expect(msg!.type).toBe('user')
    expect(msg!.message.content).toEqual([{ type: 'text', text: 'You are dev-allianceos-han, read GEMINI.md' }])
    // ms-epoch → ISO string (1779482879705 = 2026-05-22T…Z)
    expect(msg!.timestamp).toBe(new Date(1779482879705).toISOString())
    expect(msg!.timestamp).toMatch(/^2026-/)
    // uuid scopes by conversationId + timestamp for a stable render key
    expect(msg!.uuid).toBe('57d9416c-dede-4ea5-b71d-694b426eb76a-1779482879705')
  })

  it('handles a line with no conversationId (early/system prompts)', () => {
    const msg = normalizeAntigravityLine({
      display: 'echo \'[MESSAGE] From: luke\'',
      timestamp: 1779482925044,
      workspace: '/workspace',
    })
    expect(msg!.type).toBe('user')
    expect(msg!.message.content[0].text).toContain('[MESSAGE] From: luke')
    expect(msg!.uuid).toBe('antigravity-1779482925044')
  })

  it('trims whitespace and skips a blank/whitespace-only display', () => {
    expect(normalizeAntigravityLine({ display: '   spaced   ', timestamp: 1 })!.message.content[0].text).toBe('spaced')
    expect(normalizeAntigravityLine({ display: '   ', timestamp: 1 })).toBeNull()
    expect(normalizeAntigravityLine({ display: '', timestamp: 1 })).toBeNull()
  })

  it('skips lines with no display field (e.g. a stray non-prompt record)', () => {
    expect(normalizeAntigravityLine({ timestamp: 1779482879705, workspace: '/workspace' })).toBeNull()
    expect(normalizeAntigravityLine({ display: 42 })).toBeNull() // non-string display
  })

  it('passes through an already-string timestamp and omits an invalid one', () => {
    expect(normalizeAntigravityLine({ display: 'x', timestamp: '2026-05-22T19:00:00Z' })!.timestamp).toBe('2026-05-22T19:00:00Z')
    expect(normalizeAntigravityLine({ display: 'x' })!.timestamp).toBeUndefined()
    expect(normalizeAntigravityLine({ display: 'x', timestamp: NaN })!.timestamp).toBeUndefined()
  })

  it('returns null for null/undefined/empty/non-object — defensive', () => {
    expect(normalizeAntigravityLine(null)).toBeNull()
    expect(normalizeAntigravityLine(undefined)).toBeNull()
    expect(normalizeAntigravityLine({})).toBeNull()
    expect(normalizeAntigravityLine('not an object')).toBeNull()
    expect(normalizeAntigravityLine(42)).toBeNull()
  })
})
