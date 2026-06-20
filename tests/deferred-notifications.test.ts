import { describe, it, expect, beforeEach, vi } from 'vitest'

import {
  recordDeferred,
  peekDeferred,
  clearDeferred,
  hasDeferred,
  listPendingSessions,
  _deferredSessionCount,
  DEFERRED_TTL_MS,
  DEFERRED_MAX_PER_SESSION,
} from '@/lib/deferred-notifications'

// Minimal NotificationOptions factory (only the fields the queue/flush touch).
function opts(messageId: string, over: Record<string, unknown> = {}) {
  return {
    agentName: 'worker-agent',
    agentId: 'worker-agent-id',
    fromName: 'orchestrator',
    subject: 'task #334',
    messageId,
    ...over,
  } as any
}

const SESS = 'dev-team-engineer'

beforeEach(() => {
  clearDeferred(SESS)
  clearDeferred('other')
})

// ---------------------------------------------------------------------------
// Pure queue — the resurface bookkeeping (encodes the worker-agent strand at unit level).
// ---------------------------------------------------------------------------
describe('deferred-notifications queue', () => {
  it('records a busy-deferred wake and reports it pending', () => {
    expect(hasDeferred(SESS)).toBe(false)
    recordDeferred(SESS, opts('m1'))
    expect(hasDeferred(SESS)).toBe(true)
    expect(peekDeferred(SESS).map(e => e.messageId)).toEqual(['m1'])
  })

  it('dedups by messageId (a re-defer of the same message does not duplicate)', () => {
    recordDeferred(SESS, opts('m1'))
    recordDeferred(SESS, opts('m1'))
    expect(peekDeferred(SESS)).toHaveLength(1)
  })

  it('preserves arrival order across distinct messages', () => {
    recordDeferred(SESS, opts('m1'))
    recordDeferred(SESS, opts('m2'))
    recordDeferred(SESS, opts('m3'))
    expect(peekDeferred(SESS).map(e => e.messageId)).toEqual(['m1', 'm2', 'm3'])
  })

  it('caps the queue, dropping the OLDEST on overflow', () => {
    for (let i = 0; i < DEFERRED_MAX_PER_SESSION + 5; i++) {
      recordDeferred(SESS, opts(`m${i}`))
    }
    const ids = peekDeferred(SESS).map(e => e.messageId)
    expect(ids).toHaveLength(DEFERRED_MAX_PER_SESSION)
    expect(ids[0]).toBe('m5') // first 5 dropped
    expect(ids.at(-1)).toBe(`m${DEFERRED_MAX_PER_SESSION + 4}`)
  })

  it('expires entries older than the TTL (peek prunes, hasDeferred reflects it)', () => {
    const t0 = 1_000_000_000_000
    recordDeferred(SESS, opts('stale'), t0)
    const later = t0 + DEFERRED_TTL_MS + 1
    expect(hasDeferred(SESS, later)).toBe(false)
    expect(peekDeferred(SESS, later)).toHaveLength(0)
    expect(_deferredSessionCount()).toBe(0) // pruned empty session removed
  })

  it('keeps non-expired entries while pruning expired ones', () => {
    const t0 = 1_000_000_000_000
    recordDeferred(SESS, opts('old'), t0)
    recordDeferred(SESS, opts('fresh'), t0 + DEFERRED_TTL_MS) // within TTL at probe time
    const probe = t0 + DEFERRED_TTL_MS + 1
    expect(peekDeferred(SESS, probe).map(e => e.messageId)).toEqual(['fresh'])
  })

  it('clearDeferred removes the session entirely', () => {
    recordDeferred(SESS, opts('m1'))
    clearDeferred(SESS)
    expect(hasDeferred(SESS)).toBe(false)
    expect(peekDeferred(SESS)).toHaveLength(0)
  })

  it('ignores a record with no sessionName or no messageId', () => {
    recordDeferred('', opts('m1'))
    recordDeferred(SESS, opts(undefined as any))
    expect(hasDeferred(SESS)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// flushDeferredNotifications — resurface on idle (the worker-agent fix end-to-end).
// Mocks notifyAgent's send path + the unread query so we can drive each branch.
// ---------------------------------------------------------------------------
const sendKeys = vi.fn()
vi.mock('@/lib/agent-runtime', () => ({
  getRuntime: () => ({
    sendKeys: (...a: unknown[]) => {
      sendKeys(...a)
      return Promise.resolve()
    },
    sessionExists: () => Promise.resolve(true),
  }),
}))
vi.mock('@/lib/agent-registry', () => ({
  getAgent: () => ({ name: 'worker-agent', sessions: [{ index: 0 }], workingDirectory: '/wd' }),
  getAgentByName: () => ({ name: 'worker-agent', sessions: [{ index: 0 }], workingDirectory: '/wd' }),
}))
vi.mock('@/lib/hosts-config-server.mjs', () => ({
  getSelfHostId: () => 'the-dev-host',
  isSelf: () => true,
}))
vi.mock('@/lib/container-utils', () => ({ sendKeysToContainer: vi.fn() }))
const getInjectReadinessAsync = vi.fn()
vi.mock('@/lib/inject-readiness', () => ({
  getInjectReadinessAsync: (...a: unknown[]) => getInjectReadinessAsync(...a),
}))
const getAgentUnreadCount = vi.fn()
vi.mock('@/lib/agent-messaging', () => ({
  getAgentUnreadCount: (...a: unknown[]) => getAgentUnreadCount(...a),
}))

import {
  flushDeferredNotifications,
  sweepDeferredNotifications,
  ensureDeferredSweep,
  stopDeferredSweep,
} from '@/lib/notification-service'

describe('flushDeferredNotifications (resurface on idle)', () => {
  beforeEach(() => {
    sendKeys.mockClear()
    getInjectReadinessAsync.mockReset()
    getAgentUnreadCount.mockReset()
    clearDeferred('worker-agent')
  })

  it('no-op when nothing is queued', async () => {
    await flushDeferredNotifications('worker-agent')
    expect(sendKeys).not.toHaveBeenCalled()
  })

  it('WORKER-AGENT REGRESSION: a busy-deferred wake resurfaces (sends) once the agent is idle + has unread', async () => {
    recordDeferred('worker-agent', opts('m1'))
    getAgentUnreadCount.mockResolvedValue(1)
    getInjectReadinessAsync.mockResolvedValue({ safeToSubmit: true, terminalIdle: true, reason: 'idle and clear' })

    await flushDeferredNotifications('worker-agent')

    expect(sendKeys).toHaveBeenCalled() // re-pushed the wake into the now-idle pane
    expect(hasDeferred('worker-agent')).toBe(false) // cleared on successful resurface
  })

  it('DEDUP edge: skips + clears (no re-wake) when the agent already drained (unread == 0)', async () => {
    recordDeferred('worker-agent', opts('m1'))
    getAgentUnreadCount.mockResolvedValue(0)

    await flushDeferredNotifications('worker-agent')

    expect(sendKeys).not.toHaveBeenCalled() // no spurious wake
    expect(hasDeferred('worker-agent')).toBe(false) // cleared (drained meanwhile)
  })

  it('stays queued when the pane went BUSY again at flush time (re-defers, retries next idle)', async () => {
    recordDeferred('worker-agent', opts('m1'))
    getAgentUnreadCount.mockResolvedValue(1)
    getInjectReadinessAsync.mockResolvedValue({ safeToSubmit: false, terminalIdle: false, reason: 'terminal busy (mid-generation)' })

    await flushDeferredNotifications('worker-agent')

    expect(sendKeys).not.toHaveBeenCalled()
    expect(hasDeferred('worker-agent')).toBe(true) // survives for the next idle transition
  })
})

// ---------------------------------------------------------------------------
// listPendingSessions + the reliability SWEEP — the fix for the broadcast being
// cut by the hook's process.exit (the prod host .57 resurface miss). The sweep re-flushes
// pending sessions on a timer, independent of the (racy) idle broadcast.
// ---------------------------------------------------------------------------
describe('listPendingSessions', () => {
  beforeEach(() => {
    clearDeferred('a')
    clearDeferred('b')
    clearDeferred('worker-agent') // a prior describe may leave 'worker-agent' queued (busy-requeue case)
  })

  it('lists sessions with at least one non-expired deferred entry', () => {
    expect(listPendingSessions()).toEqual([])
    recordDeferred('a', opts('m1'))
    recordDeferred('b', opts('m2'))
    expect(listPendingSessions().sort()).toEqual(['a', 'b'])
  })

  it('omits a session whose only entry has expired', () => {
    const t0 = 1_000_000_000_000
    recordDeferred('a', opts('m1'), t0)
    expect(listPendingSessions(t0 + DEFERRED_TTL_MS + 1)).toEqual([])
  })
})

describe('sweepDeferredNotifications (reliable trigger, broadcast-independent)', () => {
  beforeEach(() => {
    sendKeys.mockClear()
    getInjectReadinessAsync.mockReset()
    getAgentUnreadCount.mockReset()
    clearDeferred('worker-agent')
    stopDeferredSweep()
  })

  it('re-flushes a pending session WITHOUT any broadcast (the prod-host fix): idle + unread -> resurface', async () => {
    recordDeferred('worker-agent', opts('m1'))
    getAgentUnreadCount.mockResolvedValue(1)
    getInjectReadinessAsync.mockResolvedValue({ safeToSubmit: true, terminalIdle: true, reason: 'idle and clear' })

    await sweepDeferredNotifications() // no broadcastActivityUpdate involved

    expect(sendKeys).toHaveBeenCalled() // resurfaced purely from the timer-driven sweep
    expect(hasDeferred('worker-agent')).toBe(false)
  })

  it('leaves a still-busy session queued (re-defers), so a later sweep retries', async () => {
    recordDeferred('worker-agent', opts('m1'))
    getAgentUnreadCount.mockResolvedValue(1)
    getInjectReadinessAsync.mockResolvedValue({ safeToSubmit: false, terminalIdle: false, reason: 'agent busy (hook: mid-turn)' })

    await sweepDeferredNotifications()

    expect(sendKeys).not.toHaveBeenCalled()
    expect(hasDeferred('worker-agent')).toBe(true)
  })

  it('is a no-op when nothing is pending', async () => {
    await sweepDeferredNotifications()
    expect(sendKeys).not.toHaveBeenCalled()
  })

  it('ensureDeferredSweep is idempotent and stopDeferredSweep tears it down', () => {
    expect(() => {
      ensureDeferredSweep()
      ensureDeferredSweep() // second call must not start a second timer
      stopDeferredSweep()
    }).not.toThrow()
  })
})
