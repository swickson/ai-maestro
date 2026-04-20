/**
 * Meeting Inject Queue — in-memory per-session buffer of pending meeting
 * messages for the agent to pick up via its hook's additionalContext on the
 * next turn.
 *
 * Rationale: today the meeting server types full messages into an agent's tmux
 * pane via send-keys. That works but routes text through the agent's own
 * readline/bash layer, where characters like `!` get eaten by history
 * expansion (Gemini CLI) and break the message. The alternative is to deliver
 * the message as structured context through the agent's hook
 * (hookSpecificOutput.additionalContext for Claude, systemMessage for
 * Codex/Gemini) — in-process JSON, no shell interpretation.
 *
 * The queue is intentionally per-Node-process and non-persistent: meeting
 * messages are already durably appended to
 * ~/.aimaestro/teams/meetings/{id}/chat.jsonl by lib/meeting-chat-service.
 * This queue is only the ephemeral handoff between the meeting server and
 * the next hook invocation.
 *
 * Feature flag: MAESTRO_MEETING_CONTEXT_KINDS selects which agent kinds
 * take the new path. Unset / empty = everyone keeps legacy send-keys.
 * Values: comma-separated kinds (e.g. "claude", "claude,gemini") or "all".
 */

export interface QueuedMeetingMessage {
  text: string
  enqueuedAt: string
}

const queue: Map<string, QueuedMeetingMessage[]> = new Map()

export function enqueueForSession(sessionName: string, text: string): void {
  if (!sessionName || !text) return
  const list = queue.get(sessionName) ?? []
  list.push({ text, enqueuedAt: new Date().toISOString() })
  queue.set(sessionName, list)
}

export function drainForSession(sessionName: string): QueuedMeetingMessage[] {
  const list = queue.get(sessionName) ?? []
  queue.delete(sessionName)
  return list
}

export function peekForSession(sessionName: string): QueuedMeetingMessage[] {
  return [...(queue.get(sessionName) ?? [])]
}

export function clearAll(): void {
  queue.clear()
}

// ─── Agent kind + feature flag ──────────────────────────────────────────────

export type AgentKind = 'claude' | 'codex' | 'gemini' | 'unknown'

export function inferKindFromProgram(program: string | undefined): AgentKind {
  if (!program) return 'unknown'
  const p = program.toLowerCase()
  if (p.includes('claude')) return 'claude'
  if (p.includes('codex') || p.includes('gpt')) return 'codex'
  if (p.includes('gemini')) return 'gemini'
  return 'unknown'
}

export function shouldUseAdditionalContext(program: string | undefined): boolean {
  const raw = process.env.MAESTRO_MEETING_CONTEXT_KINDS?.trim()
  if (!raw) return false
  const kind = inferKindFromProgram(program)
  if (kind === 'unknown') return false
  const list = raw.toLowerCase().split(',').map(s => s.trim()).filter(Boolean)
  if (list.includes('all')) return true
  return list.includes(kind)
}
