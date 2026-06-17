/**
 * inject-readiness — decide whether it is SAFE to inject keystrokes (a wake /
 * notification "echo + Enter") into an agent's terminal pane.
 *
 * Injecting a trailing Enter into a pane that is NOT idle-and-clear is the root
 * of two safety bugs the message-delivery notification path could trigger:
 *
 *   1. AUTO-PICK / AUTO-APPROVE — if an AskUserQuestion (`question_prompt`) or a
 *      `permission_request` prompt is open, the bare Enter auto-selects option 1.
 *      i.e. ANY inbound AMP silently answers a pending question or, worse,
 *      APPROVES a pending permission request.
 *   2. TOOL-CALL CORRUPTION (the "court" / literal-<invoke> leak) — injecting
 *      keystrokes while the model is mid-generation at the think->tool-call seam
 *      desyncs the harness, so the model's own tool call renders as literal text
 *      in the pane instead of executing.
 *
 * Both collapse to one rule: only inject-and-submit when the pane is genuinely
 * idle AND no interactive prompt is pending.
 *
 * The busy signal is terminal-OUTPUT activity (`sessionActivity`), NOT the hook
 * state file: the hook state goes stale for SECONDS after a new prompt starts
 * generating (see services/sessions-service.ts `getActivity`, which for the same
 * reason treats terminal output as the source of truth for busy/idle and only
 * trusts a `waiting_*` hook status when the terminal is already idle).
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { sessionActivity } from '@/services/shared-state'

// A hook status is "interactive/pending" when the hook captured an
// AskUserQuestion or a permission request, or the generic waiting_for_input that
// follows them. A bare Enter into any of these auto-confirms — never auto-submit
// while one is pending. (Mirrors the predicate previously inlined in server.mjs,
// widened to include waiting_for_input which is also a live prompt.)
const INTERACTIVE_PROMPT_STATUSES = new Set(['question_prompt', 'permission_request', 'waiting_for_input'])

export function isInteractivePrompt(status?: string | null): boolean {
  return !!status && INTERACTIVE_PROMPT_STATUSES.has(status)
}

export interface AgentHookState {
  status?: string
  notificationType?: string
  updatedAt?: string
  [key: string]: unknown
}

/**
 * Read the per-cwd hook state file the Claude Code hook writes to
 * `~/.aimaestro/chat-state/<md5(cwd)>.json`. Mirrors server.mjs `readHookState`:
 * a non-waiting state older than 60s is treated as absent (stale). Never throws.
 */
export function readHookState(workingDir?: string | null): AgentHookState | null {
  if (!workingDir) return null
  const stateDir = path.join(os.homedir(), '.aimaestro', 'chat-state')
  const cwdHash = crypto.createHash('md5').update(workingDir).digest('hex').substring(0, 16)
  const stateFile = path.join(stateDir, `${cwdHash}.json`)
  try {
    if (!fs.existsSync(stateFile)) return null
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as AgentHookState
    // A live prompt is always honored; a settled/active state older than 60s is
    // treated as absent so a long-dormant file never masks the real pane state.
    if (!isInteractivePrompt(state.status) && state.updatedAt) {
      const stateAge = Date.now() - new Date(state.updatedAt).getTime()
      if (stateAge > 60_000) return null
    }
    return state
  } catch {
    return null
  }
}

// Seconds of no terminal output after which the pane is considered idle. Matches
// the threshold services/sessions-service.ts `getActivity` uses for the status pill.
export const TERMINAL_IDLE_SECONDS = 3

/**
 * True when the agent's terminal has produced no output for at least
 * TERMINAL_IDLE_SECONDS. Absent activity (never tracked) is treated as idle so a
 * freshly-discovered session is still notifiable.
 *
 * NOTE (cloud agents): a cloud agent currently reads as fully safe-to-inject by
 * BOTH signals: (1) host-side `sessionActivity` is only updated while the host
 * PTY bridge is streaming the container's tmux, so an unwatched cloud agent reads
 * as idle here; and (2) `readHookState` reads the HOST chat-state file, which a
 * cloud agent does NOT write — its hook state flows via the pushed activity API
 * and its bind-mounted chat-state dir is empty on the host — so `promptPending`
 * is false too. So this never regresses cloud delivery, but it also adds NO new
 * protection for cloud yet (cloud auto-approve is NOT prevented here). Cloud-aware
 * readiness (pushed hookState + a cloud activity signal) is a scoped follow-up.
 */
export function isTerminalIdle(sessionName: string, now: number = Date.now()): boolean {
  const last = sessionActivity.get(sessionName)
  if (last === undefined) return true
  return (now - last) / 1000 > TERMINAL_IDLE_SECONDS
}

export interface InjectReadiness {
  terminalIdle: boolean
  hookStatus?: string
  promptPending: boolean
  /** Safe to inject text AND submit it with a trailing Enter. */
  safeToSubmit: boolean
  /** Human-readable reason, for the [Notify] log line. */
  reason: string
}

/**
 * Decide whether a notification/wake may be injected-and-submitted into a pane.
 *
 *   terminal BUSY (recent output)  -> defer; injecting now risks the tool-call
 *                                     serialization corruption ("court" leak).
 *   prompt PENDING (question/perm) -> defer; a bare Enter would auto-pick/approve.
 *   idle AND clear                 -> safe to submit.
 *
 * A deferred message is NOT lost: it stays unread in the inbox and the hook
 * surfaces it on the next genuine idle (idle_prompt / UserPromptSubmit drain).
 */
export function getInjectReadiness(
  sessionName: string,
  workingDir?: string | null,
  now: number = Date.now()
): InjectReadiness {
  const terminalIdle = isTerminalIdle(sessionName, now)
  const hookState = readHookState(workingDir)
  const promptPending = isInteractivePrompt(hookState?.status)

  let safeToSubmit = true
  let reason = 'idle and clear'
  if (!terminalIdle) {
    safeToSubmit = false
    reason = 'terminal busy (mid-generation)'
  } else if (promptPending) {
    safeToSubmit = false
    reason = `interactive prompt pending (${hookState?.status})`
  }

  return { terminalIdle, hookStatus: hookState?.status, promptPending, safeToSubmit, reason }
}
