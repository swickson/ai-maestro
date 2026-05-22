/**
 * Pre-tmux restoration-ready gate (container side).
 *
 * Closes the Han EACCES race surfaced 2026-05-21 during the AllianceOS cohort
 * migration (kanban fcabb870). Race shape:
 *   1. /update-runtime issues `docker stop && docker rm && docker run -d`
 *   2. agent-server.js boots inside the new container, fires `tmux new-session`
 *      and `tmux send-keys "unset CI && AI_TOOL"` essentially immediately
 *   3. host code is still finalizing the per-agent mount sources — registry
 *      writes, sentinel cleanup, post-run chowns — when the AI tool's first
 *      reads land on a workspace dir that's momentarily root-owned, files
 *      that haven't been bind-populated yet, etc. → EACCES → tool crashes
 *
 * This module gates the tmux-init step behind a host-written sentinel file
 * (`/restoration-ready/complete`) bind-mounted from the per-agent
 * `${agentDir}/restoration/complete`. The host writes the sentinel AT THE END
 * of createDockerAgent / updateContainerMountsAndExtraEnv, after all mount
 * prep + registry writes resolve. The container polls until the sentinel
 * appears (bounded timeout) and then proceeds with `initializeTmuxSession()`.
 *
 * Fail-loud-but-continue: timeout logs a warning and returns — the AI tool
 * still launches, just risks the original race window. This keeps the gate
 * from blocking startup indefinitely if the sentinel writer dies (host crash,
 * bug in the host side). Operator sees the warning in `docker logs`.
 *
 * Idempotent across container restarts: the sentinel persists in the bind-
 * mounted host dir across container recycles. Pure-restart paths (no
 * docker rm) see the existing sentinel immediately and proceed instantly,
 * which is correct — mounts are already in place from the prior run.
 * /update-runtime rebuilds DELETE the sentinel before `docker rm` so the
 * fresh container observes only fresh sentinel writes (no stale-signal
 * false-positive).
 *
 * Self-contained CommonJS so agent-server.js (COPYed standalone into /app
 * by agent-container/Dockerfile, no access to repo lib/) can require it.
 */

'use strict'

const fs = require('fs')

const DEFAULT_SENTINEL_PATH = '/restoration-ready/complete'
const DEFAULT_TIMEOUT_MS = 10000
const POLL_INTERVAL_MS = 100

/**
 * Block until the sentinel file exists or the timeout elapses.
 *
 * @param {object} [opts]
 * @param {string} [opts.sentinelPath]  Override the sentinel path (test injection).
 * @param {number} [opts.timeoutMs]     Override the max wait. Default 10s.
 * @param {number} [opts.pollIntervalMs] Override poll cadence. Default 100ms.
 * @param {() => number} [opts.now]     Clock injection for tests (Date.now equiv).
 * @param {(ms: number) => Promise<void>} [opts.sleep]  Sleep injection for tests.
 * @returns {Promise<{ready: boolean, waitedMs: number, reason: 'present-on-arrival' | 'appeared' | 'timeout'}>}
 */
async function waitForRestorationReady(opts) {
  const sentinelPath = (opts && opts.sentinelPath) || DEFAULT_SENTINEL_PATH
  const timeoutMs = (opts && opts.timeoutMs !== undefined) ? opts.timeoutMs : DEFAULT_TIMEOUT_MS
  const pollIntervalMs = (opts && opts.pollIntervalMs !== undefined) ? opts.pollIntervalMs : POLL_INTERVAL_MS
  const now = (opts && opts.now) || Date.now
  const sleep = (opts && opts.sleep) || ((ms) => new Promise(r => setTimeout(r, ms)))

  const startedAt = now()

  // Fast path: already present on arrival (pure-restart shape, second-pass
  // after host already wrote the sentinel).
  if (fs.existsSync(sentinelPath)) {
    return { ready: true, waitedMs: 0, reason: 'present-on-arrival' }
  }

  while (now() - startedAt < timeoutMs) {
    await sleep(pollIntervalMs)
    if (fs.existsSync(sentinelPath)) {
      const waitedMs = now() - startedAt
      console.log(`[restoration-gate] sentinel ${sentinelPath} appeared after ${waitedMs}ms`)
      return { ready: true, waitedMs, reason: 'appeared' }
    }
  }

  const waitedMs = now() - startedAt
  console.warn(
    `[restoration-gate] sentinel ${sentinelPath} did NOT appear within ${timeoutMs}ms — proceeding anyway. ` +
    `AI tool may hit EACCES on restoration-pending files. ` +
    `Check that the host-side writeRestorationSentinel call ran for this agent.`
  )
  return { ready: false, waitedMs, reason: 'timeout' }
}

module.exports = {
  waitForRestorationReady,
  DEFAULT_SENTINEL_PATH,
  DEFAULT_TIMEOUT_MS,
  POLL_INTERVAL_MS,
}
