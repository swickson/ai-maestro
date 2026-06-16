import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { sessionActivity } from '@/services/shared-state'
import {
  isInteractivePrompt,
  isTerminalIdle,
  readHookState,
  getInjectReadiness,
  TERMINAL_IDLE_SECONDS,
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

describe('isInteractivePrompt', () => {
  it('is true for the prompt-pending statuses (a bare Enter would auto-confirm)', () => {
    expect(isInteractivePrompt('question_prompt')).toBe(true)
    expect(isInteractivePrompt('permission_request')).toBe(true)
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

describe('isTerminalIdle', () => {
  it('treats an untracked session as idle (so a fresh session is still notifiable)', () => {
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

describe('getInjectReadiness', () => {
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

  it('defers while an interactive prompt is open (auto-pick / auto-approve guard)', () => {
    writeState(wd, { status: 'question_prompt', updatedAt: new Date(NOW).toISOString() })
    const r = getInjectReadiness(sess, wd, NOW)
    expect(r.safeToSubmit).toBe(false)
    expect(r.promptPending).toBe(true)
    expect(r.reason).toMatch(/prompt/)
  })

  it('reports busy (not prompt) when both apply — busy takes precedence', () => {
    sessionActivity.set(sess, NOW)
    writeState(wd, { status: 'permission_request', updatedAt: new Date(NOW).toISOString() })
    const r = getInjectReadiness(sess, wd, NOW)
    expect(r.safeToSubmit).toBe(false)
    expect(r.reason).toMatch(/busy/)
  })
})
