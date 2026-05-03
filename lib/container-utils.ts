/**
 * Container utilities — thin wrappers around the `docker` CLI for the
 * cloud-agent wake path. Kept minimal and shell-out-based for now so the
 * fix to swickson/ai-maestro#6 stays small. A richer ContainerRuntime
 * implementing AgentRuntime can grow on top of this when CelestIA's
 * sandbox.mounts work lands.
 */

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

export type ContainerStatus =
  | 'running'
  | 'paused'
  | 'created'
  | 'stopped'   // exited / dead / restarting
  | 'missing'   // container does not exist
  | 'docker_down' // daemon unreachable / not installed

export async function inspectContainerStatus(name: string): Promise<ContainerStatus> {
  try {
    const { stdout } = await execAsync(
      `docker container inspect ${shellQuote(name)} --format '{{.State.Status}}'`,
      { timeout: 5000 }
    )
    const status = stdout.trim()
    if (status === 'running' || status === 'paused' || status === 'created') {
      return status
    }
    // exited, dead, restarting, removing — all "not running but exists"
    return 'stopped'
  } catch (err) {
    const msg = (err as Error)?.message || ''
    if (/no such container|not found|No such object/i.test(msg)) return 'missing'
    if (/cannot connect to the docker daemon|daemon (is )?not running|command not found|docker: not found/i.test(msg)) {
      return 'docker_down'
    }
    // Unknown error from docker — treat as docker_down so we hit the loud-failure branch
    return 'docker_down'
  }
}

export async function startContainer(name: string): Promise<void> {
  await execAsync(`docker start ${shellQuote(name)}`, { timeout: 10000 })
}

/**
 * Stop a container gracefully via SIGTERM (then SIGKILL after `timeoutSec`).
 * Mirrors `docker stop`'s default 10s graceful window. Used by the hibernate
 * cloud-agent branch — without it, hibernate of a cloud agent silently no-ops
 * the host tmux check and leaves the docker container running.
 */
export async function stopContainer(name: string, timeoutSec: number = 10): Promise<void> {
  await execAsync(
    `docker stop -t ${timeoutSec} ${shellQuote(name)}`,
    { timeout: (timeoutSec + 5) * 1000 }
  )
}

/**
 * Remove a container by name. Used by the hard-delete cloud-agent branch — without
 * it, the `aim-<name>` slot stays occupied even after the registry record is gone,
 * and recreating an agent with the same name fails at `docker run` with "container
 * name already in use" (issue #84).
 *
 * Caller is responsible for stopping a running container first; `docker rm` on a
 * running container without `--force` is rejected by the daemon. The delete path
 * inspects + stops before calling this helper.
 */
export async function removeContainer(name: string): Promise<void> {
  await execAsync(`docker rm ${shellQuote(name)}`, { timeout: 10000 })
}

/**
 * Send keys to a tmux session running INSIDE a container, via `docker exec`.
 *
 * Mirrors the host-side `runtime.sendKeys` interface used by the notify route
 * and notification-service. Cloud agents have no host tmux session — their
 * tmux runs inside `containerName` — so the host send-keys path returns
 * "session not found" and short-circuits any wake-prompt or notification.
 * This helper closes that gap by doing the equivalent send inside the
 * container.
 *
 * `keys` is the literal text to send. `opts.literal` controls whether tmux
 * interprets the input literally (-l flag, default true here) or as named keys
 * (e.g. `Enter`). `opts.enter` appends a trailing Enter as a separate
 * send-keys call (matches the two-step pattern used elsewhere — text first,
 * then Enter — to defeat TUI batching).
 */
export async function sendKeysToContainer(
  containerName: string,
  sessionName: string,
  keys: string,
  opts: { literal?: boolean; enter?: boolean } = {}
): Promise<void> {
  const literal = opts.literal !== false
  const target = `${sessionName}:0.0`
  if (keys.length > 0) {
    const flag = literal ? '-l ' : ''
    // shellQuote handles the keys (may contain quotes/backticks); container
    // name and session name are operator-controlled, so shellQuote them too.
    await execAsync(
      `docker exec ${shellQuote(containerName)} tmux send-keys -t ${shellQuote(target)} ${flag}${shellQuote(keys)}`,
      { timeout: 5000 }
    )
  }
  if (opts.enter) {
    await execAsync(
      `docker exec ${shellQuote(containerName)} tmux send-keys -t ${shellQuote(target)} Enter`,
      { timeout: 5000 }
    )
  }
}

/**
 * Check whether a tmux session exists INSIDE a container.
 *
 * Used by the cloud-wake path to gate sendKeysToContainer on the in-container
 * tmux server actually being up — agent-server.js boots fresh on `docker start`
 * and creates the session within ~1s, but pushing keys before that races and
 * silently drops the input. Returns false on any error (missing session,
 * docker exec failure, container not running).
 */
export async function tmuxHasSessionInContainer(
  containerName: string,
  sessionName: string
): Promise<boolean> {
  try {
    await execAsync(
      `docker exec ${shellQuote(containerName)} tmux has-session -t ${shellQuote(sessionName)}`,
      { timeout: 5000 }
    )
    return true
  } catch {
    return false
  }
}

/**
 * Exit copy-mode on a tmux pane running INSIDE a container, if it's currently
 * in copy-mode. Mirror of the host-side `runtime.cancelCopyMode` at
 * `lib/agent-runtime.ts:145` for cloud agents.
 *
 * Why this exists: when a pane is in copy-mode, `tmux send-keys -l` against
 * it hangs the calling process indefinitely AND drops the payload on copy-
 * mode exit (verified empirically 2026-04-28 on Holmes/Rollie controlled
 * repro per kanban `96d317df`). Every cloud-agent send-keys callsite that
 * doesn't first ensure the pane is out of copy-mode risks tying up the
 * maestro request handler.
 *
 * Two-stage exit: probe `pane_in_mode`, then Escape to dismiss any active
 * command-prompt overlay (e.g. (jump backward) from F, (search forward) from
 * /, (paste buffer) from =), re-probe, and only then fall back to `q` for
 * plain copy-mode without an overlay. A bare `q` against a copy-mode pane
 * with an active command-prompt is consumed as the prompt's argument
 * character, leaving the pane in copy-mode and silently dropping the next
 * sendKeys (verified 2026-04-29 on Holmes/Rollie — Shane's "I have to hit
 * Escape a bunch and Enter" recovery confirms the overlay state).
 *
 * Non-fatal on any error — if the probe fails (container down, session
 * missing, daemon unreachable), let the caller's send-keys hit the same
 * condition and surface a clearer error there.
 */
export async function cancelCopyModeInContainer(
  containerName: string,
  sessionName: string
): Promise<void> {
  const target = `${sessionName}:0.0`
  try {
    const { stdout } = await execAsync(
      `docker exec ${shellQuote(containerName)} tmux display-message -t ${shellQuote(target)} -p '#{pane_in_mode}'`,
      { timeout: 5000 }
    )
    if (stdout.trim() !== '1') return

    // Stage 1: Escape clears any command-prompt overlay AND exits plain
    // copy-mode via the default vi/emacs key bindings.
    await execAsync(
      `docker exec ${shellQuote(containerName)} tmux send-keys -t ${shellQuote(target)} Escape`,
      { timeout: 5000 }
    )
    await new Promise(resolve => setTimeout(resolve, 30))

    // Stage 2: belt-and-suspenders. If only the overlay closed and the pane
    // is still in copy-mode, force-exit with q.
    const { stdout: stillInMode } = await execAsync(
      `docker exec ${shellQuote(containerName)} tmux display-message -t ${shellQuote(target)} -p '#{pane_in_mode}'`,
      { timeout: 5000 }
    )
    if (stillInMode.trim() === '1') {
      await execAsync(
        `docker exec ${shellQuote(containerName)} tmux send-keys -t ${shellQuote(target)} q`,
        { timeout: 5000 }
      )
      await new Promise(resolve => setTimeout(resolve, 50))
    }
  } catch {
    // Non-fatal: caller's send-keys will report the real error
  }
}

/**
 * Capture the visible pane content from a tmux session running INSIDE a
 * container, via `docker exec`. Mirrors the host-side `runtime.capturePane`
 * interface used by the wake-prompt readiness poll.
 *
 * `lines` controls how many lines of scrollback to include (the host runtime
 * accepts the same parameter). Returns the empty string on any error so the
 * caller can keep polling rather than crashing the wake flow.
 */
export async function capturePaneFromContainer(
  containerName: string,
  sessionName: string,
  lines: number = 50
): Promise<string> {
  const target = `${sessionName}:0.0`
  const startLine = Math.max(1, Math.floor(lines))
  try {
    const { stdout } = await execAsync(
      `docker exec ${shellQuote(containerName)} tmux capture-pane -t ${shellQuote(target)} -p -S -${startLine}`,
      { timeout: 5000 }
    )
    return stdout
  } catch {
    return ''
  }
}

/** Single-quote a string for safe interpolation into a shell command. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
