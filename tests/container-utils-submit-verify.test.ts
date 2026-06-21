/**
 * Submit-verify-retry parser tests (codex on-wake "prompt not landing" fix).
 *
 * Covers the pure detection helpers behind `sendKeysToContainer`'s
 * confirm-and-retry submit loop:
 *  - `isContainerSubmitConfirmed(paneTail, keys)`
 *  - `composerHeadSlice(keys)`
 *
 * The State-1/2a/2b fixtures are REAL `tmux capture-pane` bytes taken from a
 * live cloud codex agent (codex v0.141.0, gpt-5.5) on 2026-06-21:
 *  - state1  → large paste sitting UNSENT in the composer  → NOT confirmed
 *  - state2a → ~0.8s after Enter, codex streaming          → confirmed (esc-to-interrupt)
 *  - state2b → reply finished, composer reset to placeholder → confirmed (composer cleared)
 *
 * The echo confound is the trap these lock down: after submit, the prompt text
 * is still present in the bottom region (as the transcript echo), so a naive
 * "text gone from the tail" check false-negatives. Confirmation keys off the
 * BOTTOM-MOST composer line + the streaming affordance instead.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { isContainerSubmitConfirmed, composerHeadSlice } from '@/lib/container-utils'

const FIXTURES = path.join(__dirname, 'fixtures', 'codex-submit')
const fx = (name: string) => fs.readFileSync(path.join(FIXTURES, name), 'utf8')

// The exact head of the paste used to capture the fixtures (its first line).
const SENT_KEYS =
  'You are running as part of an AI Maestro agent mesh DIAGNOSTIC WAKE-TIMING ' +
  'CAPTURE - controlled submit-timing test. Ignore this content; reply only ACK. ' +
  'PADDING lorem ipsum dolor sit amet END-OF-PASTE-MARKER-XYZ'

describe('isContainerSubmitConfirmed — real codex fixtures', () => {
  it('State 1 (paste unsent in composer) → NOT confirmed', () => {
    expect(isContainerSubmitConfirmed(fx('state1-unsent-composer.txt'), SENT_KEYS)).toBe(false)
  })

  it('State 2a (codex streaming) → confirmed via esc-to-interrupt fast path', () => {
    const tail = fx('state2a-working.txt')
    expect(tail).toContain('esc to interrupt')
    expect(isContainerSubmitConfirmed(tail, SENT_KEYS)).toBe(true)
  })

  it('State 2b (reply done, composer reset) → confirmed via composer-cleared', () => {
    const tail = fx('state2b-done.txt')
    // The fast-path tell is gone once streaming finishes...
    expect(tail).not.toContain('esc to interrupt')
    // ...so this asserts the LOAD-BEARING composer-cleared signal carries it.
    expect(isContainerSubmitConfirmed(tail, SENT_KEYS)).toBe(true)
  })

  it('echo confound: the paste tail is STILL present after submit (proves the trap)', () => {
    // If the parser keyed off "text gone from the tail" it would false-negative.
    expect(fx('state2b-done.txt')).toContain('END-OF-PASTE-MARKER-XYZ')
  })
})

describe('isContainerSubmitConfirmed — hardening', () => {
  it('wrapped head: a long first line wrapping at 80 cols, still unsent → NOT confirmed', () => {
    const longLine =
      'You are running as part of an AI Maestro agent mesh and here is a deliberately ' +
      'very long single first line that the composer wraps across several rendered rows'
    // The composer renders the marker line truncated at the pane width; the head
    // slice (22 chars) sits comfortably within the first rendered row.
    const composerFirstRow = '› ' + longLine.slice(0, 78)
    const wrappedRows = [
      composerFirstRow,
      '  ' + longLine.slice(78, 156),
      '  ' + longLine.slice(156),
      '',
      '  gpt-5.5 default · /workspace',
    ].join('\n')
    expect(isContainerSubmitConfirmed(wrappedRows, longLine)).toBe(false)
  })

  it('empty capture → NOT confirmed (cannot verify; keep retrying)', () => {
    expect(isContainerSubmitConfirmed('', SENT_KEYS)).toBe(false)
    expect(isContainerSubmitConfirmed('   \n  \n', SENT_KEYS)).toBe(false)
  })

  it('isolates the live composer from an earlier transcript echo (bottom-most marker line)', () => {
    // Same marker on the echo (above) and the cleared composer (below).
    const tail = [
      '› ' + SENT_KEYS.split('\n')[0], // transcript echo of the submitted prompt
      '',
      '› Summarize recent commits', // live composer, reset to placeholder
      '  gpt-5.5 default · /workspace',
    ].join('\n')
    expect(isContainerSubmitConfirmed(tail, SENT_KEYS)).toBe(true)
  })

  it('non-empty pane with no composer marker → NOT confirmed (could be a scrolled-out unsent composer)', () => {
    // The correctness guarantee (Columbo #263): "no marker found" must never be
    // read as "submitted" — a large unsent paste whose composer marker scrolled
    // out of the capture window lands here, and confirming it would strand the
    // agent. Cannot confirm → retry (a benign extra Enter if it had submitted).
    expect(isContainerSubmitConfirmed('some output\nmore output\n', SENT_KEYS)).toBe(false)
  })

  it('Columbo case: large UNSENT paste, composer marker scrolled ABOVE the captured tail → NOT confirmed', () => {
    // Simulates the bottom-N capture of a huge unsent paste: only wrapped
    // continuation lines (2-space indent, no marker) and the status line are
    // in-frame; the marker-prefixed composer line scrolled out the top, and there
    // is no streaming affordance because nothing submitted.
    const continuation = Array.from({ length: 12 }, (_, i) =>
      `  wrapped continuation row ${i} of the still-unsent paste, no marker on this line`
    )
    const scrolledOutTail = [...continuation, '', '  gpt-5.5 default · /workspace'].join('\n')
    expect(scrolledOutTail).not.toContain('esc to interrupt')
    expect(isContainerSubmitConfirmed(scrolledOutTail, SENT_KEYS)).toBe(false)
  })
})

describe('composerHeadSlice', () => {
  it('takes the first line only (never spans a newline)', () => {
    expect(composerHeadSlice('first line here\nsecond line')).toBe('first line here')
  })

  it('caps at 22 chars for a long first line', () => {
    const slice = composerHeadSlice('You are running as part of an AI Maestro mesh')
    expect(slice).toBe('You are running as par')
    expect(slice.length).toBe(22)
  })

  it('returns the whole first line when shorter than the cap', () => {
    expect(composerHeadSlice('Hi there')).toBe('Hi there')
  })

  it('empty / whitespace-only keys → empty slice', () => {
    expect(composerHeadSlice('')).toBe('')
    expect(composerHeadSlice('\n\n')).toBe('')
  })
})
