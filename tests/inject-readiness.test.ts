import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { sessionActivity } from '@/services/shared-state'
import {
  isInteractivePrompt,
  isBlockingPrompt,
  isTerminalIdle,
  readHookState,
  paneShowsBusyFooter,
  isPaneBusy,
  getInjectReadiness,
  getInjectReadinessAsync,
  TERMINAL_IDLE_SECONDS,
  type PaneProbe,
} from '@/lib/inject-readiness'

const CHAT_STATE_DIR = path.join(os.homedir(), '.aimaestro', 'chat-state')
const NOW = 1_780_000_000_000

function stateFileFor(workingDir: string): string {
  const h = crypto.createHash('md5').update(workingDir).digest('hex').substring(0, 16)
  return path.join(CHAT_STATE_DIR, `${h}.json`)
}

const createdFiles: string[] = []
let wd: string
let sess: string

function writeState(workingDir: string, state: Record<string, unknown>): void {
  fs.mkdirSync(CHAT_STATE_DIR, { recursive: true })
  const file = stateFileFor(workingDir)
  fs.writeFileSync(file, JSON.stringify(state))
  createdFiles.push(file)
}

// Hermetic capture-pane probe: returns scripted snapshots, never shells out to
// tmux. `sleep` is a no-op so the 400ms inter-snapshot wait doesn't slow tests.
function fakeProbe(snapshots: Array<string | null>): PaneProbe & { calls: number } {
  let i = 0
  const probe = {
    calls: 0,
    capturePane: async () => {
      probe.calls++
      const snap = snapshots[Math.min(i, snapshots.length - 1)]
      i++
      return snap
    },
    sleep: async () => { /* no-op */ },
  }
  return probe
}

beforeEach(() => {
  // Unique keys per test so we never read/clobber a real agent's live state.
  const uniq = crypto.randomBytes(8).toString('hex')
  wd = `/tmp/inject-readiness-test/${uniq}`
  sess = `inject-readiness-test-${uniq}`
})

afterEach(() => {
  for (const f of createdFiles) {
    try { fs.unlinkSync(f) } catch { /* ignore */ }
  }
  createdFiles.length = 0
  sessionActivity.delete(sess)
})

// isInteractivePrompt is the STATUS-LEVEL staleness-exemption predicate (used by
// readHookState:66 so a live prompt is never aged out as stale). It is NOT the
// inject gate — that is isBlockingPrompt, which additionally discriminates
// waiting_for_input by notificationType. waiting_for_input stays exempt here so a
// real permission_prompt waiting_for_input open >60s is never staled→auto-approved.
describe('isInteractivePrompt (staleness-exemption, status-level)', () => {
  it('is true for any status that could carry a live prompt (never age these out)', () => {
    expect(isInteractivePrompt('question_prompt')).toBe(true)
    expect(isInteractivePrompt('permission_request')).toBe(true)
    // waiting_for_input stays exempt so a permission_prompt variant is never staled.
    expect(isInteractivePrompt('waiting_for_input')).toBe(true)
  })

  it('is false for non-prompt / absent statuses', () => {
    expect(isInteractivePrompt('idle')).toBe(false)
    expect(isInteractivePrompt('active')).toBe(false)
    expect(isInteractivePrompt(undefined)).toBe(false)
    expect(isInteractivePrompt(null)).toBe(false)
    expect(isInteractivePrompt('')).toBe(false)
  })
})

// isBlockingPrompt is THE inject gate's prompt check (#239 BUG2 fix): it
// discriminates waiting_for_input by notificationType.
describe('isBlockingPrompt (the inject gate discriminator)', () => {
  it('always blocks the unambiguous prompt statuses', () => {
    expect(isBlockingPrompt({ status: 'question_prompt' })).toBe(true)
    expect(isBlockingPrompt({ status: 'permission_request' })).toBe(true)
  })

  it('BUG2: waiting_for_input + idle_prompt is NOT blocking (the benign inject moment)', () => {
    expect(isBlockingPrompt({ status: 'waiting_for_input', notificationType: 'idle_prompt' })).toBe(false)
  })

  it('waiting_for_input + permission_prompt IS blocking (a bare Enter would auto-approve)', () => {
    expect(isBlockingPrompt({ status: 'waiting_for_input', notificationType: 'permission_prompt' })).toBe(true)
  })

  it('waiting_for_input with MISSING notificationType leans ALLOW (idle is the common case)', () => {
    expect(isBlockingPrompt({ status: 'waiting_for_input' })).toBe(false)
  })

  it('is false for non-prompt / absent states', () => {
    expect(isBlockingPrompt({ status: 'idle' })).toBe(false)
    expect(isBlockingPrompt({ status: 'active' })).toBe(false)
    expect(isBlockingPrompt(null)).toBe(false)
    expect(isBlockingPrompt(undefined)).toBe(false)
    expect(isBlockingPrompt({})).toBe(false)
  })
})

describe('isTerminalIdle (sync fast-path — POSITIVE/busy is trustworthy, idle is not)', () => {
  // NOTE: untracked⇒idle here is BY DESIGN. sessionActivity is only populated
  // while a dashboard client streams the pane, so an UNWATCHED busy pane reads
  // idle by this signal alone (the Bishop blind spot). The fix lives one layer up
  // in isPaneBusy, which PROBES via capture-pane on apparent-idle — see below.
  it('treats an untracked session as idle (fast-path only; isPaneBusy then probes)', () => {
    expect(isTerminalIdle(sess, NOW)).toBe(true)
  })

  it('is busy while terminal output is recent', () => {
    sessionActivity.set(sess, NOW)
    expect(isTerminalIdle(sess, NOW)).toBe(false)
  })

  it('is idle once output is older than the threshold', () => {
    sessionActivity.set(sess, NOW - (TERMINAL_IDLE_SECONDS + 1) * 1000)
    expect(isTerminalIdle(sess, NOW)).toBe(true)
  })
})

describe('paneShowsBusyFooter (KAI-validated Claude busy signals)', () => {
  it('matches a live generating footer (spinner gerund + token-timer)', () => {
    expect(paneShowsBusyFooter('  · Vibing… (2m 6s · ↓ 7.9k tokens)')).toBe(true)
    expect(paneShowsBusyFooter('✳ Forming…')).toBe(true)
    expect(paneShowsBusyFooter('· Thinking…')).toBe(true)
  })

  it('matches the esc-to-interrupt hint, step markers, token-timer, and Running…', () => {
    expect(paneShowsBusyFooter('press esc to interrupt')).toBe(true)
    expect(paneShowsBusyFooter('thinking [12/418]')).toBe(true)
    expect(paneShowsBusyFooter('  ↑ 1.2k tokens')).toBe(true)
    expect(paneShowsBusyFooter('  ⎿  Running…')).toBe(true)
  })

  it('does NOT match an idle Claude status bar (false-positive guard)', () => {
    expect(paneShowsBusyFooter('dev-aimaestrogw-holmes | 1 unread')).toBe(false)
    expect(paneShowsBusyFooter('Opus 4.8 (1M context) | ctx 31% | $31.36')).toBe(false)
    expect(paneShowsBusyFooter('⏵⏵ bypass permissions on (shift+tab to cycle)')).toBe(false)
    expect(paneShowsBusyFooter('❯ ')).toBe(false)
  })

  it('region-scoped: busy patterns in the BODY do NOT match when the FOOTER is idle', () => {
    // An agent pane whose scrollback/body quotes the busy patterns (·…ing, ↓N
    // tokens, [N/N]) but is actually idle-at-prompt. Full-pane matching would
    // false-positive → over-defer/strand; footer-region scoping must ignore body.
    const idleFooterBusyBody = [
      '● discussing the gate: "· Vibing…", "↓ 7.9k tokens", step [1/418]', // busy-like BODY
      'more body', 'more body', 'more body', 'more body',
      'more body', 'more body', 'more body', 'more body',
      '────────────────────',
      '❯ ',
      '────────────────────',
      '  dev-aimaestrogw-holmes | 0 unread',
      '  Opus 4.8 (1M context) | ctx 31% | $31.36',
      '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
    ].join('\n')
    expect(paneShowsBusyFooter(idleFooterBusyBody)).toBe(false)
  })

  it('region-scoped: a real footer padded down by trailing blank lines still matches', () => {
    const paddedBusy = [
      'some streamed response text',
      '· Vibing… (1m 2s · ↓ 3.1k tokens)',
      '', '', '', '',
    ].join('\n')
    expect(paneShowsBusyFooter(paddedBusy)).toBe(true)
  })
})

describe('isPaneBusy (client-independent probe — closes the unwatched-pane blind spot)', () => {
  const BUSY_PANE = ['❯ run it\n● court\n· Vibing… (1m 2s · ↑ 3.1k tokens)']
  const IDLE_PANE = ['❯ \nOpus 4.8 (1M context) | ctx 31% | $31.36\n⏵⏵ bypass permissions on']

  it('fast-path: recent tracked output is busy WITHOUT a capture-pane call', async () => {
    sessionActivity.set(sess, NOW)
    const probe = fakeProbe(IDLE_PANE)
    expect(await isPaneBusy(sess, NOW, probe)).toBe(true)
    expect(probe.calls).toBe(0) // short-circuited, no probe
  })

  it('BISHOP CASE: untracked (apparent-idle) but capture shows busy footer -> BUSY', async () => {
    const probe = fakeProbe(BUSY_PANE)
    expect(await isPaneBusy(sess, NOW, probe)).toBe(true)
    expect(probe.calls).toBe(1) // footer match on first capture, no second capture/delay
  })

  it('harness-agnostic: footer-less but two snapshots differ -> BUSY (live output)', async () => {
    const probe = fakeProbe(['frame one of output', 'frame two of output'])
    expect(await isPaneBusy(sess, NOW, probe)).toBe(true)
    expect(probe.calls).toBe(2)
  })

  it('genuine idle: footer-less and two identical snapshots -> NOT busy', async () => {
    const probe = fakeProbe([IDLE_PANE[0], IDLE_PANE[0]])
    expect(await isPaneBusy(sess, NOW, probe)).toBe(false)
  })

  it('non-capturable pane (cloud/gone) -> degrade to NOT busy (no regression)', async () => {
    const probe = fakeProbe([null])
    expect(await isPaneBusy(sess, NOW, probe)).toBe(false)
  })
})

describe('readHookState', () => {
  it('returns null when there is no state file', () => {
    expect(readHookState(wd)).toBeNull()
  })

  it('returns null for a missing/empty workingDir', () => {
    expect(readHookState(undefined)).toBeNull()
    expect(readHookState('')).toBeNull()
  })

  it('returns a live prompt state', () => {
    writeState(wd, { status: 'question_prompt', updatedAt: new Date(NOW).toISOString() })
    expect(readHookState(wd)?.status).toBe('question_prompt')
  })

  it('honors a live prompt even when old (a pending question never goes stale)', () => {
    writeState(wd, { status: 'permission_request', updatedAt: new Date(NOW - 600_000).toISOString() })
    expect(readHookState(wd)?.status).toBe('permission_request')
  })

  it('never stales a permission waiting_for_input (CelestIA edge: must not auto-approve)', () => {
    writeState(wd, { status: 'waiting_for_input', notificationType: 'permission_prompt', updatedAt: new Date(Date.now() - 600_000).toISOString() })
    const state = readHookState(wd)
    expect(state?.status).toBe('waiting_for_input')
    expect(isBlockingPrompt(state)).toBe(true)
  })

  it('drops a non-prompt state older than 60s as stale', () => {
    writeState(wd, { status: 'idle', updatedAt: new Date(Date.now() - 120_000).toISOString() })
    expect(readHookState(wd)).toBeNull()
  })

  it('keeps a fresh non-prompt state', () => {
    writeState(wd, { status: 'active', updatedAt: new Date().toISOString() })
    expect(readHookState(wd)?.status).toBe('active')
  })

  it('returns null on malformed JSON', () => {
    fs.mkdirSync(CHAT_STATE_DIR, { recursive: true })
    const file = stateFileFor(wd)
    fs.writeFileSync(file, '{not json')
    createdFiles.push(file)
    expect(readHookState(wd)).toBeNull()
  })
})

// Sync core (no capture-pane). promptPending now uses isBlockingPrompt.
describe('getInjectReadiness (sync core)', () => {
  it('is safe to submit when terminal is idle and no prompt is pending', () => {
    const r = getInjectReadiness(sess, wd, NOW)
    expect(r.safeToSubmit).toBe(true)
    expect(r.terminalIdle).toBe(true)
    expect(r.promptPending).toBe(false)
  })

  it('defers while the terminal is busy (court / tool-call-corruption guard)', () => {
    sessionActivity.set(sess, NOW)
    const r = getInjectReadiness(sess, wd, NOW)
    expect(r.safeToSubmit).toBe(false)
    expect(r.reason).toMatch(/busy/)
  })

  it('defers while a real interactive prompt is open (auto-pick / auto-approve guard)', () => {
    writeState(wd, { status: 'question_prompt', updatedAt: new Date(NOW).toISOString() })
    const r = getInjectReadiness(sess, wd, NOW)
    expect(r.safeToSubmit).toBe(false)
    expect(r.promptPending).toBe(true)
    expect(r.reason).toMatch(/prompt/)
  })

  it('BUG2: does NOT defer on a benign idle_prompt waiting_for_input', () => {
    writeState(wd, { status: 'waiting_for_input', notificationType: 'idle_prompt', updatedAt: new Date(NOW).toISOString() })
    const r = getInjectReadiness(sess, wd, NOW)
    expect(r.promptPending).toBe(false)
    expect(r.safeToSubmit).toBe(true)
  })

  it('reports busy (not prompt) when both apply — busy takes precedence', () => {
    sessionActivity.set(sess, NOW)
    writeState(wd, { status: 'permission_request', updatedAt: new Date(NOW).toISOString() })
    const r = getInjectReadiness(sess, wd, NOW)
    expect(r.safeToSubmit).toBe(false)
    expect(r.reason).toMatch(/busy/)
  })
})

// THE injection gate — both regression directions (#239 BUG1 + BUG2).
describe('getInjectReadinessAsync (the gate) — both regression directions', () => {
  const BUSY_FOOTER_PANE = ['❯ x\n● court\n· Vibing… (1m 2s · ↑ 3.1k tokens)']
  const IDLE_PANE = ['❯ \nOpus 4.8 (1M context) | ctx 31% | $31.36']

  it('BUG1 (over-permissive): unwatched + capture-shows-busy MUST defer', async () => {
    // sessionActivity untracked => apparent-idle by fast-path; probe catches busy.
    const probe = fakeProbe(BUSY_FOOTER_PANE)
    const r = await getInjectReadinessAsync(sess, wd, NOW, probe)
    expect(r.safeToSubmit).toBe(false)
    expect(r.terminalIdle).toBe(false)
    expect(r.reason).toMatch(/busy/)
  })

  it('BUG2 (over-aggressive): idle-at-prompt (waiting_for_input + idle_prompt) MUST inject', async () => {
    writeState(wd, { status: 'waiting_for_input', notificationType: 'idle_prompt', updatedAt: new Date(NOW).toISOString() })
    const probe = fakeProbe([IDLE_PANE[0], IDLE_PANE[0]]) // static idle pane
    const r = await getInjectReadinessAsync(sess, wd, NOW, probe)
    expect(r.safeToSubmit).toBe(true)
    expect(r.promptPending).toBe(false)
  })

  it('permission_prompt waiting_for_input on an idle pane MUST defer (no auto-approve)', async () => {
    writeState(wd, { status: 'waiting_for_input', notificationType: 'permission_prompt', updatedAt: new Date(NOW).toISOString() })
    const probe = fakeProbe([IDLE_PANE[0], IDLE_PANE[0]])
    const r = await getInjectReadinessAsync(sess, wd, NOW, probe)
    expect(r.safeToSubmit).toBe(false)
    expect(r.promptPending).toBe(true)
  })

  it('genuine idle + no prompt MUST inject', async () => {
    const probe = fakeProbe([IDLE_PANE[0], IDLE_PANE[0]])
    const r = await getInjectReadinessAsync(sess, wd, NOW, probe)
    expect(r.safeToSubmit).toBe(true)
  })

  it('non-capturable pane (cloud) + no prompt still injects (no cloud regression)', async () => {
    const probe = fakeProbe([null])
    const r = await getInjectReadinessAsync(sess, wd, NOW, probe)
    expect(r.safeToSubmit).toBe(true)
  })
})
