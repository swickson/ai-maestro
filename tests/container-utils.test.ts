/**
 * Container Utils Tests
 *
 * Coverage for the `cancelCopyModeInContainer` primitive added for
 * kanban 96d317df / GH issue #70. Mirrors the host-side
 * `runtime.cancelCopyMode` (lib/agent-runtime.ts:145) for cloud agents.
 *
 * Why the cloud-side mirror exists: cloud agents run tmux INSIDE the
 * container, so the host runtime's cancelCopyMode can't see/touch their
 * panes. The notify route's cloud branches need a `docker exec`-based
 * equivalent before sending keys to a copy-mode-stuck pane (which would
 * otherwise hang the request and drop the payload — verified empirically
 * 2026-04-28 on Holmes/Rollie).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// Mocks
// ============================================================================

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

import { cancelCopyModeInContainer } from '@/lib/container-utils'

describe('cancelCopyModeInContainer', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends q to exit copy-mode when pane_in_mode=1', async () => {
    const calls: string[] = []
    mockExec.mockImplementation((cmd: string, cb: Function) => {
      calls.push(cmd)
      if (cmd.includes('display-message')) {
        cb(null, '1\n', '')
      } else {
        cb(null, '', '')
      }
    })

    await cancelCopyModeInContainer('aim-test', 'test-session')

    expect(calls.length).toBe(2)
    expect(calls[0]).toContain('display-message')
    expect(calls[0]).toContain('pane_in_mode')
    expect(calls[0]).toContain("'aim-test'")
    expect(calls[0]).toContain("'test-session:0.0'")
    expect(calls[1]).toContain('send-keys')
    expect(calls[1]).toContain(' q')
  })

  it('does NOT send q when pane_in_mode=0', async () => {
    const calls: string[] = []
    mockExec.mockImplementation((cmd: string, cb: Function) => {
      calls.push(cmd)
      cb(null, '0\n', '')
    })

    await cancelCopyModeInContainer('aim-test', 'test-session')

    expect(calls.length).toBe(1)
    expect(calls[0]).toContain('display-message')
  })

  it('is non-fatal on probe failure (container down, session missing, daemon unreachable)', async () => {
    mockExec.mockImplementation((cmd: string, cb: Function) => {
      cb(new Error('No such container: aim-test'), '', '')
    })

    // Should not throw — caller's send-keys will surface the real error.
    await expect(cancelCopyModeInContainer('aim-test', 'test-session')).resolves.toBeUndefined()
  })

  it('escapes container and session names via single-quote shell-quoting', async () => {
    const calls: string[] = []
    mockExec.mockImplementation((cmd: string, cb: Function) => {
      calls.push(cmd)
      cb(null, '0\n', '')
    })

    await cancelCopyModeInContainer("aim-evil'; rm -rf /; echo '", 'normal-session')

    // Single quote in the container name must be escaped to '\\'' so the
    // command can't break out of the quoted shell argument.
    expect(calls[0]).toContain(`'aim-evil'\\''; rm -rf /; echo '\\'''`)
    // Probe still issued — the helper trusts shellQuote, doesn't reject.
    expect(calls[0]).toContain('display-message')
  })
})
