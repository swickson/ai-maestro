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
