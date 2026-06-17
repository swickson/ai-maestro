/**
 * deferred-notifications — server-side resurface queue for busy-deferred wakes (#245).
 *
 * WHY: `notifyAgent` correctly DEFERS a wake when the target pane is terminal-BUSY
 * (injecting mid-generation desyncs the harness → the "court" tool-call leak). The
 * message stays unread, but a PASSIVELY-WAITING agent (no heartbeat / no further
 * prompt) never resurfaces it: the `idle_prompt` Notification hook can only attach
 * `additionalContext` to a *new* user turn, so it cannot inject into an already-
 * waiting session. Only a real `UserPromptSubmit` drain, or a fresh send-keys push,
 * delivers. Result: the message strands (the Zach↔Reed regression — Reed had no
 * heartbeat and stranded; Zach's 14-min self-heartbeat re-prompted him and drained).
 *
 * FIX: when a wake is deferred FOR BUSY, record it here keyed by session. When the
 * agent next transitions to idle (`waiting_for_input` — see broadcastActivityUpdate),
 * flush: re-attempt the send-keys push, which CAN inject into a now-idle waiting pane.
 * The court-safe busy gate is untouched — this only RE-tries AFTER the agent is idle.
 *
 * This module is the pure queue (record / peek / clear, with TTL + cap + arrival-order
 * + messageId dedup). The flush itself lives in notification-service.ts (it owns the
 * send path + the readiness re-gate), so there is no runtime import cycle here — the
 * only dependency below is a TYPE-only import.
 */

import type { NotificationOptions } from '@/lib/notification-service'

export interface DeferredEntry {
  options: NotificationOptions
  messageId: string
  deferredAt: number
}

// Don't retry a deferral forever — a session that never idles again (dead/hung) must
// not accumulate or wake on a stale message. 30 min comfortably covers a long
// generation while bounding the queue.
export const DEFERRED_TTL_MS = 30 * 60_000

// Per-session cap so a flood of deferrals (or a misbehaving sender) can't grow the
// queue unboundedly. One idle flush drains ALL unread via a single wake, so a deep
// queue is never needed; we keep the most RECENT on overflow (oldest dropped).
export const DEFERRED_MAX_PER_SESSION = 25

// key: sessionName (the send-keys target identity)
const pending = new Map<string, DeferredEntry[]>()

/**
 * Record a busy-deferred wake for `sessionName`. Idempotent per messageId (a re-defer
 * of the same message does not duplicate). Arrival order is preserved; on overflow the
 * oldest entry is dropped (cap).
 */
export function recordDeferred(
  sessionName: string,
  options: NotificationOptions,
  now: number = Date.now()
): void {
  if (!sessionName || !options?.messageId) return
  const list = pending.get(sessionName) ?? []
  if (list.some(e => e.messageId === options.messageId)) return // dedup
  list.push({ options, messageId: options.messageId, deferredAt: now })
  while (list.length > DEFERRED_MAX_PER_SESSION) list.shift() // cap: drop oldest
  pending.set(sessionName, list)
}

/** True when `sessionName` has at least one non-expired deferred wake. */
export function hasDeferred(sessionName: string, now: number = Date.now()): boolean {
  const list = pending.get(sessionName)
  if (!list || list.length === 0) return false
  return list.some(e => now - e.deferredAt <= DEFERRED_TTL_MS)
}

/**
 * Return the non-expired deferred entries for `sessionName` in arrival order WITHOUT
 * removing them (the flush decides whether to clear, based on the re-attempt result).
 * Expired entries are pruned as a side effect.
 */
export function peekDeferred(sessionName: string, now: number = Date.now()): DeferredEntry[] {
  const list = pending.get(sessionName)
  if (!list) return []
  const live = list.filter(e => now - e.deferredAt <= DEFERRED_TTL_MS)
  if (live.length === 0) {
    pending.delete(sessionName)
    return []
  }
  if (live.length !== list.length) pending.set(sessionName, live) // prune expired
  return live.slice()
}

/** Drop all deferred wakes for `sessionName` (delivered, or drained meanwhile). */
export function clearDeferred(sessionName: string): void {
  pending.delete(sessionName)
}

/** Test/diagnostic helper — total queued sessions. */
export function _deferredSessionCount(): number {
  return pending.size
}
