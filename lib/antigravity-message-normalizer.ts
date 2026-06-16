/**
 * Antigravity (agy) history.jsonl → Claude-shape normalizer for ChatView.
 *
 * Antigravity does NOT write a JSONL conversation transcript. Empirically
 * verified against a real logged-in cloud agent (han, #219):
 *
 *   ~/.gemini/antigravity-cli/conversations/<conversationId>.pb   ← protobuf blob
 *   ~/.gemini/antigravity-cli/conversations/<conversationId>.db   ← sqlite (+ -wal/-shm)
 *   ~/.gemini/antigravity-cli/history.jsonl                       ← THE only JSONL
 *
 * The full user+assistant conversation lives ONLY in the .pb/.db blobs — a
 * binary black box with no public protobuf schema and an internal,
 * version-fragile sqlite schema. We deliberately do NOT parse those (see #219:
 * Option B/C rejected — not worth the fragility for a chat preview).
 *
 * history.jsonl is a flat append-only log of USER prompts:
 *
 *   {display: "<the typed/injected user input>", timestamp: <ms epoch>,
 *    workspace: "/workspace", conversationId?: "<uuid>"}
 *
 * Every line is a user turn — there are no assistant/role/type fields. So this
 * normalizer maps each line to a USER message. KNOWN LIMITATION: assistant
 * responses are not rendered (they're in the .pb/.db black box). The chat
 * window shows the user's prompt history rather than a blank "No messages yet"
 * state; live assistant output remains visible in the terminal pane.
 *
 * Sister of lib/gemini-message-normalizer.ts / lib/codex-message-normalizer.ts;
 * signature kept identical so the chat dispatch (services/agents-chat-service.ts
 * + server.mjs parseJsonlLines) treats all runtimes uniformly.
 */

import type { NormalizedMessage } from './gemini-message-normalizer'

/**
 * Normalize one parsed Antigravity history.jsonl line into a Claude-shaped
 * USER message, or return null to skip (missing/blank `display`, or a
 * non-object line). Assistant turns are intentionally unrepresented — see the
 * file header (known protobuf-blackbox limitation, #219).
 */
export function normalizeAntigravityLine(raw: any): NormalizedMessage | null {
  if (!raw || typeof raw !== 'object') return null

  const text = typeof raw.display === 'string' ? raw.display.trim() : ''
  if (!text) return null

  // history.jsonl timestamps are ms-epoch numbers; normalize to an ISO string
  // to match the Claude shape ChatView renders (defensively pass through an
  // already-string timestamp, or omit when absent/invalid).
  let timestamp: string | undefined
  if (typeof raw.timestamp === 'number' && Number.isFinite(raw.timestamp)) {
    timestamp = new Date(raw.timestamp).toISOString()
  } else if (typeof raw.timestamp === 'string' && raw.timestamp) {
    timestamp = raw.timestamp
  }

  return {
    type: 'user',
    message: { content: [{ type: 'text', text }] },
    timestamp,
    // Synthesize a stable-ish render key: conversationId scopes the turn,
    // timestamp disambiguates within it. uuid is optional (ChatView key only).
    uuid: `${raw.conversationId || 'antigravity'}-${raw.timestamp ?? ''}`,
  }
}
