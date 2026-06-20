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
 *      in the pane instead of executing. NOTE: this is an UPSTREAM Claude Code
 *      harness bug (anthropics/claude-code #64108/#65248, open, no maintainer
 *      fix); we cannot cure it, but the AMP-injected Enter reliably PRECIPITATES
 *      it, so we remove the precipitant we control — never inject mid-generation.
 *
 * Both collapse to one rule: only inject-and-submit when the pane is genuinely
 * idle AND no interactive prompt is pending.
 *
 * Two signals, each with a known blind spot the #239 follow-up (this module)
 * closes:
 *
 *   - BUSY signal — terminal-OUTPUT activity (`sessionActivity`). This is only
 *     populated while a dashboard CLIENT is streaming the pane (server.mjs
 *     ptyProcess.onData). An UNWATCHED agent therefore reads as idle even when
 *     mid-generation — the over-permissive blind spot that precipitated the
 *     gateway agent's court. `isPaneBusy()` closes it with a client-independent `tmux
 *     capture-pane` probe (footer + 2-snapshot diff) that needs no client.
 *   - PROMPT signal — the hook state file. The hook writes `waiting_for_input`
 *     for BOTH a real permission prompt AND the BENIGN idle_prompt (Claude idle
 *     at the prompt — the IDEAL moment to deliver). Treating all
 *     `waiting_for_input` as blocking stranded notifications mesh-wide (an
 *     already-idle agent fires no new idle_prompt, so the defer never resurfaces).
 *     `isBlockingPrompt()` discriminates by `notificationType`.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { sessionActivity } from '@/services/shared-state'

const execFileAsync = promisify(execFile)

// A hook status is "interactive/pending" at the STATUS level when the hook
// captured an AskUserQuestion or a permission request, or the generic
// waiting_for_input that follows them. Kept for the readHookState staleness
// rule (a live prompt is never aged out) — the actual inject GATE uses
// isBlockingPrompt(), which additionally discriminates waiting_for_input by
// notificationType (see below).
const INTERACTIVE_PROMPT_STATUSES = new Set(['question_prompt', 'permission_request', 'waiting_for_input'])

export function isInteractivePrompt(status?: string | null): boolean {
  return !!status && INTERACTIVE_PROMPT_STATUSES.has(status)
}

export interface AgentHookState {
  status?: string
  notificationType?: string
  /** Harness that wrote this state ('claude' | 'gemini' | 'codex'). PR-B: only a
   *  Claude hook writes the authoritative busy/idle bracket, so the inject gate
   *  trusts hook-idle ONLY when agent === 'claude' and otherwise falls back to the
   *  capture-pane probe (a non-Claude hook never writes a busy edge). */
  agent?: string
  updatedAt?: string
  [key: string]: unknown
}

// Statuses that are ALWAYS a live, blocking prompt — a bare Enter would
// auto-answer/auto-approve. These are written directly by the hook's PreToolUse
// (question_prompt) and PermissionRequest (permission_request) handlers, so they
// are unambiguous.
const ALWAYS_BLOCKING_STATUSES = new Set(['question_prompt', 'permission_request'])

/**
 * Decide whether the hook state represents a PENDING interactive prompt that a
 * bare Enter would auto-confirm — i.e. a reason to DEFER injection.
 *
 * The subtlety (#239 BUG2): the hook writes `status: 'waiting_for_input'` for
 * TWO very different situations, distinguished only by `notificationType`
 * (ai-maestro-hook.cjs Notification handler):
 *   - notificationType === 'idle_prompt'       -> Claude is idle AT the prompt.
 *       This is the BENIGN case and the IDEAL moment to deliver. ALLOW.
 *   - notificationType === 'permission_prompt'  -> a real pending permission.
 *       A bare Enter would APPROVE it. BLOCK.
 *   - notificationType missing                  -> lean ALLOW: idle is the common
 *       case, and a real permission also writes status=permission_request first
 *       (caught by ALWAYS_BLOCKING_STATUSES), so we don't strand on an ambiguous
 *       waiting_for_input.
 */
export function isBlockingPrompt(state?: AgentHookState | null): boolean {
  const status = state?.status
  if (!status) return false
  if (ALWAYS_BLOCKING_STATUSES.has(status)) return true
  if (status === 'waiting_for_input') {
    return state?.notificationType === 'permission_prompt'
  }
  return false
}

/**
 * Read the per-cwd hook state file the Claude Code hook writes to
 * `~/.aimaestro/chat-state/<md5(cwd)>.json`. Mirrors server.mjs `readHookState`:
 * a non-prompt state older than 60s is treated as absent (stale). Never throws.
 */
export function readHookState(workingDir?: string | null): AgentHookState | null {
  if (!workingDir) return null
  const stateDir = path.join(os.homedir(), '.aimaestro', 'chat-state')
  const cwdHash = crypto.createHash('md5').update(workingDir).digest('hex').substring(0, 16)
  const stateFile = path.join(stateDir, `${cwdHash}.json`)
  try {
    if (!fs.existsSync(stateFile)) return null
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8')) as AgentHookState
    // A live prompt is always honored; so is the PR-B authoritative 'busy' state
    // (busy turns routinely exceed 60s — p50 ~60s — and its staleness is handled by
    // the N-minute guard in isAgentBusy, not aged out here). A settled/active state
    // older than 60s is treated as absent so a long-dormant file never masks the
    // real pane state.
    const honored = isInteractivePrompt(state.status) || state.status === 'busy'
    if (!honored && state.updatedAt) {
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
 * True when the agent's terminal has produced no TRACKED output for at least
 * TERMINAL_IDLE_SECONDS. Absent activity (never tracked) is treated as idle.
 *
 * IMPORTANT (#239 BUG1): `sessionActivity` is only updated while a dashboard
 * client streams the pane (server.mjs ptyProcess.onData). So a `false` here
 * (BUSY) is reliable, but a `true` here (idle) is NOT trustworthy for an
 * UNWATCHED pane — it reads idle even mid-generation. Use this only as the
 * fast-path POSITIVE for busy; confirm an apparent-idle verdict with
 * `isPaneBusy()`'s client-independent capture-pane probe before injecting.
 */
export function isTerminalIdle(sessionName: string, now: number = Date.now()): boolean {
  const last = sessionActivity.get(sessionName)
  if (last === undefined) return true
  return (now - last) / 1000 > TERMINAL_IDLE_SECONDS
}

// ---------------------------------------------------------------------------
// Client-independent busy probe (#239 BUG1 fix)
// ---------------------------------------------------------------------------

/** Interval between the two capture-pane snapshots used to detect live output. */
export const PANE_PROBE_INTERVAL_MS = 400

/**
 * Spinner-glyph class for the live Claude footer. EMPIRICALLY CAPTURED
 * 2026-06-17 from a real generating agent (think + tool-use seam): the spinner
 * animates through `* · ✢ ✶ ✻ ✽ …` every frame while the gerund word changes only
 * every few seconds — i.e. the leading glyph is NOT stable, so anchoring to a
 * narrow class (e.g. just `[✳·]`) would UNDER-match most frames → inject mid-gen →
 * court. This class is the Dingbat "sparkle" block U+2720–U+274F plus middle-dot
 * (U+00B7) and asterisk, which covers the whole animation. The "●" response
 * bullet (U+25CF) is deliberately OUTSIDE the class, so a BODY line like
 * "● discussing…" can never be read as a spinner.
 */
const SPINNER = '[\\u2720-\\u274F\\u00B7*]'

/**
 * Busy-footer patterns — the PRIMARY busy signal for Claude panes. Each is
 * LINE-ANCHORED (multiline `^`) to a real footer line, NOT a bare substring:
 * the live spinner/progress line STARTS (after indent) with a spinner glyph (or
 * the ⎿ run-indicator) and carries the gerund/timer/hint; the SAME tokens quoted
 * in BODY prose appear mid-line or after a "●" bullet. Anchoring separates them
 * structurally — the fix the PR-review agent requested (#244 review) — WITHOUT shrinking the
 * footer window, which would risk the dangerous UNDER-match/court direction.
 *
 * Discriminators that survive a body quote even within the footer region:
 *   - line-START spinner glyph (sparkle/·/*, NOT the "●" bullet)
 *   - gerund IMMEDIATELY followed by an ellipsis ("Frolicking…"), which body
 *     prose ("● discussing the gate") does not have.
 *
 * The footer is present THROUGHOUT generation incl. the think→tool-call seam (the
 * court moment) — the timer keeps ticking and the ⎿ run-indicator shows during the
 * tool call — so a single capture catches the exact failure window. The 2-snapshot
 * diff (below) is the harness-agnostic backstop for Codex/Gemini.
 */
const BUSY_FOOTER_PATTERNS: RegExp[] = [
  new RegExp(`^\\s*${SPINNER}\\s*\\w+ing[.…]`, 'm'),                // spinner gerund: "✶ Frolicking…", "· Vibing…", "* Thinking…"
  /^\s*⎿\s*Running[.…]/m,                                          // tool-run indicator (the seam): "⎿ Running…"
  new RegExp(`^\\s*${SPINNER}.*[↓↑]\\s*[\\d.]+k?\\s+tokens`, 'im'), // spinner line carrying the token-timer (glyph-variant safety net)
  new RegExp(`^\\s*${SPINNER}.*esc to interrupt`, 'im'),           // spinner line carrying the esc hint
  new RegExp(`^\\s*${SPINNER}.*\\[\\d+/\\d+\\]`, 'm'),             // spinner line carrying a [N/N] step marker
]

/**
/**
 * True when a line-anchored BUSY footer pattern appears ANYWHERE in the pane.
 *
 * We deliberately do NOT window to a fixed tail-N region. The live
 * spinner/progress line FLOATS: measured at offset -7, -9, and -11 across real
 * generating panes (a transient "How is Claude doing this session?" feedback
 * prompt, a Tip line, or interior blank rows push it up above a fixed window). Any
 * fixed tail-N risks slicing the spinner OUT → a genuinely-generating pane reads
 * idle → inject at the think→tool-call seam → court. So the window itself was the
 * defect (it traded the .54 court-safety for a court hole).
 *
 * Instead we rely on the line-ANCHORING in BUSY_FOOTER_PATTERNS (each requires a
 * spinner glyph / ⎿ run-indicator at LINE-START, with the "●" response bullet
 * excluded) to do the body-quote rejection a window was previously used for. So a
 * full-pane match is BOTH court-safe (catches the spinner at any offset) AND
 * body-safe (a quoted "· Vibing…" mid-line, or a "● …" bullet, does not match).
 *
 * Accepted residual (a peer dev (dev-host)'s edge): a pane that literally DISPLAYS a captured
 * footer line at line-start reads busy → over-defer. That is the SAFE direction
 * (no court / no auto-approve), cron-backstopped, and far rarer than the
 * floating-spinner court hole a fixed window would reintroduce.
 */
export function paneShowsBusyFooter(content: string): boolean {
  return BUSY_FOOTER_PATTERNS.some(re => re.test(content))
}

/** Normalize pane text so trailing-whitespace padding doesn't read as a diff. */
function normalizePane(content: string): string {
  return content.split('\n').map(line => line.replace(/\s+$/, '')).join('\n').trim()
}

/**
 * Capture an agent's tmux pane WITHOUT a dashboard client. Returns null when the
 * pane is not host-capturable — no such session, tmux absent/timeout, or a CLOUD
 * agent whose tmux runs inside its container (host has no matching session). A
 * null result yields NO new busy signal, so cloud delivery is never regressed
 * (cloud-aware probing via docker exec is the #241 follow-up, out of scope here).
 */
export async function tmuxCapturePane(sessionName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('tmux', ['capture-pane', '-p', '-t', `${sessionName}:0.0`], { timeout: 2000 })
    return stdout
  } catch {
    return null
  }
}

export interface PaneProbe {
  capturePane: (sessionName: string) => Promise<string | null>
  sleep?: (ms: number) => Promise<void>
}

const defaultSleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

const defaultProbe: PaneProbe = { capturePane: tmuxCapturePane }

/**
 * Client-independent busy check. Closes the unwatched-pane blind spot of
 * `isTerminalIdle` (#239 BUG1) so an unwatched mid-generation agent is no longer
 * mistaken for idle.
 *
 *   1. Fast path — if tracked output is recent (`!isTerminalIdle`), the pane is
 *      BUSY for certain (a watched pane); short-circuit. (We trust only the
 *      positive; an absent/idle activity reading is the untrustworthy case.)
 *   2. Apparent-idle — capture the pane with no client and decide:
 *        - busy footer present (esc to interrupt / spinner)  -> BUSY
 *        - two snapshots ~400ms apart that differ            -> BUSY (live output)
 *        - otherwise                                         -> idle
 *      A non-capturable pane (null) yields not-busy (no cloud regression).
 */
export async function isPaneBusy(
  sessionName: string,
  now: number = Date.now(),
  probe: PaneProbe = defaultProbe
): Promise<boolean> {
  if (!isTerminalIdle(sessionName, now)) return true

  const snap1 = await probe.capturePane(sessionName)
  if (snap1 == null) return false
  if (paneShowsBusyFooter(snap1)) return true

  const sleep = probe.sleep ?? defaultSleep
  await sleep(PANE_PROBE_INTERVAL_MS)

  const snap2 = await probe.capturePane(sessionName)
  if (snap2 == null) return false
  if (paneShowsBusyFooter(snap2)) return true

  return normalizePane(snap1) !== normalizePane(snap2)
}

/**
 * Staleness threshold (#PR-B): how long a hook-written 'busy' is trusted WITHOUT a
 * capture-pane re-verify. Beyond this, a 'busy' is treated as possibly-stuck (a
 * MISSED Stop — empirically ~2.2% of turns; without this guard a missed Stop would
 * strand all notifications forever) and verified via capture-pane so it self-heals
 * to idle. 5 min is above the p90 turn (~4.3 min from hook-debug.log), so ~92% of
 * turns hit the cheap fresh path; a stuck-busy self-heals within ~5 min.
 */
export const HOOK_BUSY_STALE_MS = 5 * 60_000

/**
 * Authoritative busy decision (#PR-B). The Claude hook writes status:'busy' at
 * UserPromptSubmit (turn START) and status:'idle' at Stop (turn END), so the HOOK
 * STATE is the primary, client-independent busy signal — no terminal scraping on
 * the hot path. Stop fires once per TURN (not per tool-round, empirically), so
 * busy=[UserPromptSubmit, Stop) brackets the whole turn including the
 * think→tool-call seam → court-safe by construction.
 *
 *   hook 'busy' & FRESH (<HOOK_BUSY_STALE_MS) -> busy (cheap; the common case)
 *   hook 'busy' & STALE                        -> capture-pane VERIFY (missed-Stop
 *                                                 self-heal: still-busy keeps
 *                                                 deferring, static-idle -> idle)
 *   hook present, agent==='claude', not busy   -> NOT busy (authoritative idle)
 *   non-Claude / no agent / hook MISSING       -> capture-pane FALLBACK
 *
 * Non-Claude harnesses (gemini/codex) never write a busy edge, so their hook-idle
 * is NOT trustworthy — fall back to capture-pane (else we'd inject mid-generation).
 */
export async function isAgentBusy(
  sessionName: string,
  hookState: AgentHookState | null,
  now: number = Date.now(),
  probe: PaneProbe = defaultProbe
): Promise<boolean> {
  if (hookState?.status === 'busy') {
    const age = hookState.updatedAt ? now - new Date(hookState.updatedAt).getTime() : Infinity
    if (age < HOOK_BUSY_STALE_MS) return true          // fresh hook-busy — trust it (no capture-pane)
    return await isPaneBusy(sessionName, now, probe)   // stale — verify, self-heal a missed Stop
  }
  if (hookState?.agent === 'claude') return false      // Claude + not 'busy' = authoritative idle
  return await isPaneBusy(sessionName, now, probe)     // non-Claude / no agent / hook missing — fallback
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

function promptReason(state: AgentHookState | null): string {
  if (!state?.status) return 'unknown'
  return state.notificationType ? `${state.status}/${state.notificationType}` : state.status
}

/**
 * SYNCHRONOUS readiness — the pure core (no capture-pane). The busy signal is the
 * `sessionActivity` fast-path ONLY, so it carries `isTerminalIdle`'s
 * unwatched-pane blind spot. Use this where shelling out to tmux is not possible;
 * the injection GATE should use `getInjectReadinessAsync`, which adds the
 * client-independent busy probe.
 */
export function getInjectReadiness(
  sessionName: string,
  workingDir?: string | null,
  now: number = Date.now()
): InjectReadiness {
  const terminalIdle = isTerminalIdle(sessionName, now)
  const hookState = readHookState(workingDir)
  const promptPending = isBlockingPrompt(hookState)

  let safeToSubmit = true
  let reason = 'idle and clear'
  if (!terminalIdle) {
    safeToSubmit = false
    reason = 'terminal busy (mid-generation)'
  } else if (promptPending) {
    safeToSubmit = false
    reason = `interactive prompt pending (${promptReason(hookState)})`
  }

  return { terminalIdle, hookStatus: hookState?.status, promptPending, safeToSubmit, reason }
}

/**
 * ASYNC readiness — THE injection gate. Decide whether a notification/wake may be
 * injected-and-submitted into a pane, using the client-independent capture-pane
 * busy probe so an UNWATCHED mid-generation pane is correctly deferred.
 *
 *   terminal BUSY (probe)          -> defer; injecting now risks the tool-call
 *                                     serialization corruption ("court" leak).
 *   prompt PENDING (real, by type) -> defer; a bare Enter would auto-pick/approve.
 *   idle AND clear                 -> safe to submit.
 *
 * A deferred message is NOT lost: it stays unread in the inbox and the hook
 * surfaces it on the next genuine idle (idle_prompt / UserPromptSubmit drain).
 */
export async function getInjectReadinessAsync(
  sessionName: string,
  workingDir?: string | null,
  now: number = Date.now(),
  probe: PaneProbe = defaultProbe
): Promise<InjectReadiness> {
  const hookState = readHookState(workingDir)
  const busy = await isAgentBusy(sessionName, hookState, now, probe)
  const terminalIdle = !busy
  const promptPending = isBlockingPrompt(hookState)

  let safeToSubmit = true
  let reason = 'idle and clear'
  if (busy) {
    safeToSubmit = false
    reason = hookState?.status === 'busy'
      ? 'agent busy (hook: mid-turn)'
      : 'terminal busy (mid-generation)'
  } else if (promptPending) {
    safeToSubmit = false
    reason = `interactive prompt pending (${promptReason(hookState)})`
  }

  return { terminalIdle, hookStatus: hookState?.status, promptPending, safeToSubmit, reason }
}
