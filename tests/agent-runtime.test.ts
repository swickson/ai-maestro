/**
 * Agent Runtime Tests
 *
 * Coverage for the TmuxRuntime `cancelCopyMode` host-side primitive at
 * `lib/agent-runtime.ts:145`. Two-stage exit: Escape (clears any
 * command-prompt overlay AND exits plain copy-mode via default key bindings)
 * then re-probe + fallback `q`.
 *
 * Why two stages: a bare `q` against a copy-mode pane with an active
 * command-prompt overlay (e.g. (jump backward) from F, (search forward) from
 * /, (paste buffer) from =) is consumed as the prompt's argument character.
 * The overlay closes, the pane stays in copy-mode, and the next sendKeys
 * silently lands in copy-mode key handling rather than the running program.
 * Verified 2026-04-29 via Shane's Rollie screenshot showing the (jump
 * backward) overlay during stuck AMP delivery.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockExec } = vi.hoisted(() => ({
  mockExec: vi.fn(),
}))

vi.mock('child_process', () => ({
  exec: mockExec,
}))

vi.mock('util', async () => {
  const actual = await vi.importActual<typeof import('util')>('util')
  return {
    ...actual,
    promisify: () => async (cmd: string, _opts?: unknown) => {
      const result = await new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
        mockExec(cmd, (err: unknown, stdout: string, stderr: string) => {
          if (err) reject(err)
          else resolve({ stdout, stderr })
        })
      })
      return result
    },
  }
})

import { TmuxRuntime } from '@/lib/agent-runtime'

describe('TmuxRuntime.cancelCopyMode', () => {
  let runtime: TmuxRuntime

  beforeEach(() => {
    vi.clearAllMocks()
    runtime = new TmuxRuntime()
  })

  it('Stage-1 Escape clears plain copy-mode — no q follow-up', async () => {
    // probe=1 → Escape → re-probe=0 → return.
    const calls: string[] = []
    let probeCount = 0
    mockExec.mockImplementation((cmd: string, cb: Function) => {
      calls.push(cmd)
      if (cmd.includes('display-message')) {
        probeCount += 1
        cb(null, probeCount === 1 ? '1\n' : '0\n', '')
      } else {
        cb(null, '', '')
      }
    })

    await runtime.cancelCopyMode('test-session')

    expect(calls.length).toBe(3)
    expect(calls[0]).toContain('display-message')
    expect(calls[0]).toContain('pane_in_mode')
    expect(calls[0]).toContain('"test-session"')
    expect(calls[1]).toContain('send-keys')
    expect(calls[1]).toContain('"test-session"')
    expect(calls[1]).toContain(' Escape')
    expect(calls[2]).toContain('display-message')
  })

  it('Stage-2 q fires when an overlay (jump-backward et al.) was on top of copy-mode', async () => {
    // probe=1 → Escape closes overlay → re-probe=1 → q forces exit.
    const calls: string[] = []
    mockExec.mockImplementation((cmd: string, cb: Function) => {
      calls.push(cmd)
      if (cmd.includes('display-message')) {
        cb(null, '1\n', '')
      } else {
        cb(null, '', '')
      }
    })

    await runtime.cancelCopyMode('test-session')

    expect(calls.length).toBe(4)
    expect(calls[0]).toContain('display-message')
    expect(calls[1]).toContain('send-keys')
    expect(calls[1]).toContain(' Escape')
    expect(calls[2]).toContain('display-message')
    expect(calls[3]).toContain('send-keys')
    expect(calls[3]).toContain(' q')
  })

  it('does NOT touch the pane when initial pane_in_mode=0', async () => {
    const calls: string[] = []
    mockExec.mockImplementation((cmd: string, cb: Function) => {
      calls.push(cmd)
      cb(null, '0\n', '')
    })

    await runtime.cancelCopyMode('test-session')

    expect(calls.length).toBe(1)
    expect(calls[0]).toContain('display-message')
  })

  it('is non-fatal on probe failure (session missing, tmux server unreachable)', async () => {
    mockExec.mockImplementation((cmd: string, cb: Function) => {
      cb(new Error("can't find session: missing-session"), '', '')
    })

    await expect(runtime.cancelCopyMode('missing-session')).resolves.toBeUndefined()
  })

  it('is non-fatal when Stage-2 re-probe fails after Escape', async () => {
    // probe=1 → Escape ok → re-probe throws → swallow, do not re-throw.
    let probeCount = 0
    mockExec.mockImplementation((cmd: string, cb: Function) => {
      if (cmd.includes('display-message')) {
        probeCount += 1
        if (probeCount === 1) cb(null, '1\n', '')
        else cb(new Error('session went away'), '', '')
      } else {
        cb(null, '', '')
      }
    })

    await expect(runtime.cancelCopyMode('test-session')).resolves.toBeUndefined()
  })
})
