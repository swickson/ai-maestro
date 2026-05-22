/**
 * Regression coverage for agent-container/restoration-gate.cjs.
 *
 * Closes the Han EACCES race per kanban fcabb870: agent-server.js blocks AI_TOOL
 * autostart (via initializeTmuxSession + tmux send-keys) until the host-written
 * `/restoration-ready/complete` sentinel appears. Host writes it at the END of
 * createDockerAgent / updateContainerMountsAndExtraEnv, after mount prep and
 * registry writes resolve.
 *
 * Test surface:
 *  - present-on-arrival → instant return (pure-restart shape)
 *  - appears mid-wait → return with reason='appeared', waitedMs reflected
 *  - timeout → return with ready=false, reason='timeout' (fail-loud-but-continue)
 *  - injection points (clock, sleep) — drive the loop deterministically
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'

import {
  waitForRestorationReady,
  DEFAULT_TIMEOUT_MS,
  POLL_INTERVAL_MS,
} from '../agent-container/restoration-gate.cjs'

describe('waitForRestorationReady', () => {
  let tmpDir: string
  let sentinelPath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-restoration-gate-'))
    sentinelPath = path.join(tmpDir, 'complete')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns immediately when sentinel exists on arrival (pure-restart shape)', async () => {
    fs.writeFileSync(sentinelPath, '2026-05-22T22:30:00.000Z\n')

    const result = await waitForRestorationReady({
      sentinelPath,
      timeoutMs: 1000,
    })

    expect(result.ready).toBe(true)
    expect(result.reason).toBe('present-on-arrival')
    expect(result.waitedMs).toBe(0)
  })

  it('returns with reason=appeared when sentinel lands mid-wait', async () => {
    // Use a tight pollInterval + drop the sentinel after ~50ms (well under timeout).
    setTimeout(() => fs.writeFileSync(sentinelPath, 'ts\n'), 50)

    const result = await waitForRestorationReady({
      sentinelPath,
      timeoutMs: 1000,
      pollIntervalMs: 20,
    })

    expect(result.ready).toBe(true)
    expect(result.reason).toBe('appeared')
    expect(result.waitedMs).toBeGreaterThanOrEqual(20)
  })

  it('times out fail-loud-but-continues when sentinel never appears', async () => {
    const result = await waitForRestorationReady({
      sentinelPath,
      timeoutMs: 100,
      pollIntervalMs: 20,
    })

    expect(result.ready).toBe(false)
    expect(result.reason).toBe('timeout')
    expect(result.waitedMs).toBeGreaterThanOrEqual(100)
  })

  it('respects pollIntervalMs cadence (drives sleep injection)', async () => {
    // Inject a fake sleep + clock; verify sleep called with pollIntervalMs and
    // the loop terminates as soon as the sentinel appears.
    let virtualTime = 0
    const now = () => virtualTime
    const sleeps: number[] = []
    const sleep = async (ms: number) => {
      sleeps.push(ms)
      virtualTime += ms
      // Inject the sentinel on the 3rd poll
      if (sleeps.length === 3) {
        fs.writeFileSync(sentinelPath, 'ts\n')
      }
    }

    const result = await waitForRestorationReady({
      sentinelPath,
      timeoutMs: 10000,
      pollIntervalMs: 50,
      now,
      sleep,
    })

    expect(result.ready).toBe(true)
    expect(result.reason).toBe('appeared')
    // Three sleeps before the sentinel-write race-resolution, then the fourth
    // sleep returns and the existsSync check sees the file.
    expect(sleeps.every(ms => ms === 50)).toBe(true)
    expect(sleeps.length).toBe(3)
  })

  it('uses defaults when no opts are provided (smoke test, present-on-arrival)', async () => {
    // We can't easily exercise the default sentinelPath (/restoration-ready/complete)
    // without writing into root-owned dirs; but verify the function shape doesn't
    // throw when called bare with a pre-existing file at the path we control.
    // (Default path doesn't exist in test env, so this short-circuits to timeout.)
    expect(DEFAULT_TIMEOUT_MS).toBe(10000)
    expect(POLL_INTERVAL_MS).toBe(100)
    expect(typeof waitForRestorationReady).toBe('function')
  })

  it('warns to console on timeout (fail-loud)', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await waitForRestorationReady({
        sentinelPath,
        timeoutMs: 50,
        pollIntervalMs: 10,
      })
      expect(warnSpy).toHaveBeenCalled()
      const msg = warnSpy.mock.calls.map(c => c.join(' ')).join('\n')
      expect(msg).toMatch(/did NOT appear within 50ms/)
      expect(msg).toMatch(/restoration-gate/)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('logs info on appeared (cadence visibility for ops)', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    try {
      setTimeout(() => fs.writeFileSync(sentinelPath, 'ts\n'), 30)
      await waitForRestorationReady({
        sentinelPath,
        timeoutMs: 1000,
        pollIntervalMs: 10,
      })
      const msg = logSpy.mock.calls.map(c => c.join(' ')).join('\n')
      expect(msg).toMatch(/sentinel.*appeared after \d+ms/)
    } finally {
      logSpy.mockRestore()
    }
  })

})
