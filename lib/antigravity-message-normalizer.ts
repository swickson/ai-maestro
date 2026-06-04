/**
 * Antigravity (agy) JSONL → Claude-shape normalizer for ChatView consumption.
 *
 * Stub for v0.30.87 — the conversations directory at
 * ~/.gemini/antigravity-cli/conversations/ is OAuth-gated and was empty on
 * every host during the investigation window. Real shape will be specced
 * once a logged-in cloud antigravity agent generates sample files post-
 * migration (kanban 49cc27d7 / scoped follow-up after PR-1 lands).
 *
 * Returning null for every line means ChatView shows the "No messages yet"
 * empty state for antigravity agents until the real implementation lands —
 * known degradation, narrow window. Run-time output captured by tmux scroll-
 * back / the on-wake hook is still visible in the terminal pane.
 *
 * Sister of lib/gemini-message-normalizer.ts; signature kept identical so
 * the chat-service dispatch (services/agents-chat-service.ts) treats both
 * branches uniformly.
 */

import type { NormalizedMessage } from './gemini-message-normalizer'

/**
 * Normalize one parsed Antigravity JSONL line into a Claude-shaped message,
 * or return null to skip. Stub: always returns null.
 */
export function normalizeAntigravityLine(_raw: any): NormalizedMessage | null {
  return null
}
