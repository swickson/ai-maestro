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

/** Single-quote a string for safe interpolation into a shell command. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}
