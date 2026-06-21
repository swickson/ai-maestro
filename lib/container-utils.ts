/**
 * Container utilities — thin wrappers around the `docker` CLI for the
 * cloud-agent wake path. Kept minimal and shell-out-based so the container
 * operations stay small and testable. A richer ContainerRuntime implementing
 * AgentRuntime can grow on top of this when sandbox.mounts work lands.
 */

import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// Cloud-agent container working directory — the host's working-directory bind
// is mounted at this path, so Claude Code (and any other in-container TUI)
// launches with cwd=/workspace regardless of the host workingDirectory string.
// Used by getConversationMessages cloud branch + the chat-state hook hash.
export const CONTAINER_CWD = '/workspace'

// Encoded form of CONTAINER_CWD as Claude Code writes its projects subdir
// (slashes → hyphens). Sibling const so the cloud-branch path lookup does not
// re-derive on every call. Invariant pinned by tests/container-utils.test.ts.
export const CONTAINER_CWD_ENCODED = '-workspace'

// Gemini CLI does NOT slash-encode the cwd — its per-project mapping
// (~/.gemini/projects.json) stores `'/workspace': 'workspace'` and the
// per-project chats dir is `<HOME>/.gemini/tmp/workspace/chats/`. Sibling
// const so the cloud-branch path lookup for cloud-Gemini agents has a
// single source of truth that does not drift from CONTAINER_CWD.
export const CONTAINER_CWD_GEMINI_PROJECT = 'workspace'

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
 * name already in use".
 *
 * Caller is responsible for stopping a running container first; `docker rm` on a
 * running container without `--force` is rejected by the daemon.
 */
export async function removeContainer(name: string): Promise<void> {
  await execAsync(`docker rm ${shellQuote(name)}`, { timeout: 10000 })
}

/**
 * Send keys to a tmux session running INSIDE a container, via `docker exec`.
 *
 * Mirrors the host-side `runtime.sendKeys` interface. Cloud agents have no host
 * tmux session — their tmux runs inside `containerName` — so the host send-keys
 * path returns "session not found". This helper closes that gap by doing the
 * equivalent send inside the container.
 *
 * `opts.enter` submits the typed text. When text was sent, the Enter goes
 * through `submitEnterWithVerifyInContainer` — a confirm-and-retry loop that
 * defeats the fixed-gap race: a large on-wake paste (e.g. codex with a mesh
 * primer + instructions prepended) can still be ingesting when a single
 * fixed-delay Enter fires, so the Enter no-ops and the prompt sits unsent in
 * the composer (the agent idles, never acting on its dispatch). The loop sends
 * Enter, confirms the submit landed (see `isContainerSubmitConfirmed`), and
 * retries with growing backoff. Fast submitters (Claude, agy) confirm on the
 * first capture and early-exit with no retry.
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
    await execAsync(
      `docker exec ${shellQuote(containerName)} tmux send-keys -t ${shellQuote(target)} ${flag}${shellQuote(keys)}`,
      { timeout: 5000 }
    )
  }
  if (opts.enter) {
    if (keys.length > 0) {
      // Text was sent — submit it with confirm-and-retry.
      await submitEnterWithVerifyInContainer(containerName, sessionName, keys)
    } else {
      // No text accompanied this Enter (e.g. the notification echo's standalone
      // Enter) — there is nothing to confirm, so send a single plain Enter.
      await execAsync(
        `docker exec ${shellQuote(containerName)} tmux send-keys -t ${shellQuote(target)} Enter`,
        { timeout: 5000 }
      )
    }
  }
}

// Pre-Enter settle gaps (ms), growing per attempt: paste-ingest time scales with
// payload size + host load, so a fixed gap that works for a small paste is too
// short for a large one. The first gap covers the common fast case; later gaps
// give a stuck composer progressively longer to finish ingesting before re-Enter.
const SUBMIT_BACKOFFS_MS = [150, 300, 600, 1200]
// After each Enter, let the TUI transition (accept → stream / clear composer)
// before we read the pane to judge whether the submit landed.
const SUBMIT_REACT_MS = 150
// Hard wall-clock ceiling for the whole confirm-and-retry loop. This runs in the
// orchestrator wake path, so a genuinely-wedged agent must not hang the wake.
const SUBMIT_DEADLINE_MS = 3000

/**
 * Send Enter to an in-container tmux pane and confirm the typed text actually
 * submitted, retrying Enter with growing backoff until confirmed or the deadline
 * is hit. Bias by design: a missed confirmation costs one extra Enter on an
 * already-empty composer (a benign no-op newline), whereas giving up early
 * leaves the prompt unsent and the agent idle (the bug this fixes) — so the loop
 * retries-until-confirmed rather than testing for "still unsent".
 */
async function submitEnterWithVerifyInContainer(
  containerName: string,
  sessionName: string,
  keys: string
): Promise<void> {
  const target = `${sessionName}:0.0`
  const deadline = Date.now() + SUBMIT_DEADLINE_MS
  for (let attempt = 0; attempt < SUBMIT_BACKOFFS_MS.length; attempt++) {
    const remaining = deadline - Date.now()
    if (remaining <= 0) break
    // Settle: let any in-flight paste finish ingesting before this Enter.
    await new Promise(r => setTimeout(r, Math.min(SUBMIT_BACKOFFS_MS[attempt], remaining)))
    await execAsync(
      `docker exec ${shellQuote(containerName)} tmux send-keys -t ${shellQuote(target)} Enter`,
      { timeout: 5000 }
    )
    await new Promise(r => setTimeout(r, SUBMIT_REACT_MS))
    const tail = await capturePaneFromContainer(containerName, sessionName, 10)
    if (isContainerSubmitConfirmed(tail, keys)) {
      if (attempt > 0) {
        console.warn(
          `[sendKeysToContainer] submit confirmed for ${target} after ${attempt + 1} Enter attempt(s)`
        )
      }
      return
    }
    console.warn(
      `[sendKeysToContainer] submit not confirmed for ${target} ` +
        `(attempt ${attempt + 1}/${SUBMIT_BACKOFFS_MS.length}); composer still holds unsent text, retrying Enter`
    )
  }
  // Exhausted: surface loudly with a manual-recovery breadcrumb. Do not throw —
  // the wake flow should continue; the operator (or a later poll) can re-send.
  console.error(
    `[sendKeysToContainer] SUBMIT UNCONFIRMED for ${target} after ${SUBMIT_BACKOFFS_MS.length} attempt(s)/` +
      `${SUBMIT_DEADLINE_MS}ms — the prompt may still be sitting unsent in the composer. ` +
      `Manual recovery: docker exec ${containerName} tmux send-keys -t ${target} Enter`
  )
}

// Prompt-marker glyphs that begin a TUI input/echo line. Codex renders its
// composer (and the transcript echo of a submitted prompt) with U+203A '›';
// '❯' covers other AI-CLI composers. Kept deliberately narrow so a stray
// transcript line can't be misread as the live composer.
const PROMPT_MARKERS = ['›', '❯']

/**
 * The slice of `keys` we expect to see on the live composer line while the text
 * is still unsent. First line only — a newline never lands on one rendered
 * composer line, so a slice spanning newlines could never match (= a false
 * "submitted" = stuck agent). Short enough (< minimum plausible composer width)
 * that composer wrapping / a narrow pane can't truncate it before the match.
 */
export function composerHeadSlice(keys: string): string {
  const firstLine = (keys.split('\n')[0] ?? '').trim()
  const SLICE = 22
  return firstLine.length <= SLICE ? firstLine : firstLine.slice(0, SLICE)
}

/** Strip a leading prompt marker from a line; null if the line has none. */
function stripPromptMarker(line: string): string | null {
  const t = line.trimStart()
  for (const marker of PROMPT_MARKERS) {
    if (t.startsWith(marker)) return t.slice(marker.length).trimStart()
  }
  return null
}

/**
 * Decide whether a typed prompt actually submitted, from a captured pane tail.
 *
 * Two signals, ORed — biased toward confirmation (see the loop's rationale):
 *  - POSITIVE (fast path): "esc to interrupt" — the streaming/interrupt
 *    affordance shown only AFTER a submit is accepted. Immune to the transcript
 *    echo of the just-submitted prompt.
 *  - LOAD-BEARING: the composer cleared. The live composer input line is the
 *    BOTTOM-MOST marker-prefixed line (the transcript echo uses the same marker
 *    but always renders above it, so scanning bottom-up isolates the input
 *    line). If it no longer holds the head of what we sent, the text submitted
 *    and the composer reset to its placeholder.
 *
 * Returns false on an empty capture (cannot confirm → keep retrying; the extra
 * Enter is benign).
 */
export function isContainerSubmitConfirmed(paneTail: string, keys: string): boolean {
  if (!paneTail || !paneTail.trim()) return false
  if (paneTail.includes('esc to interrupt')) return true
  const head = composerHeadSlice(keys)
  if (!head) return true
  const lines = paneTail.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const content = stripPromptMarker(lines[i])
    if (content === null) continue
    // Bottom-most marker line = the live composer input line.
    return !content.includes(head)
  }
  // Non-empty pane but no composer marker found — the TUI advanced past the input
  // box. Treat as submitted; a stray Enter on a cleared composer is benign.
  return true
}

/**
 * Check whether a tmux session exists INSIDE a container.
 *
 * Used by the cloud-wake path to gate sendKeysToContainer on the in-container
 * tmux server actually being up. Returns false on any error (missing session,
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
 * in copy-mode. Mirror of the host-side `runtime.cancelCopyMode`.
 *
 * Two-stage exit: probe `pane_in_mode`, then Escape to dismiss any active
 * command-prompt overlay, re-probe, and fall back to `q` for plain copy-mode.
 *
 * Non-fatal on any error — let the caller's send-keys surface the real error.
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

    // Stage 1: Escape clears any command-prompt overlay AND exits plain copy-mode
    await execAsync(
      `docker exec ${shellQuote(containerName)} tmux send-keys -t ${shellQuote(target)} Escape`,
      { timeout: 5000 }
    )
    await new Promise(resolve => setTimeout(resolve, 30))

    // Stage 2: if still in copy-mode, force-exit with q
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
 * container. Mirrors the host-side `runtime.capturePane` interface.
 *
 * Returns the empty string on any error so the caller can keep polling
 * rather than crashing the wake flow.
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
