/**
 * Antigravity (agy) history.jsonl → Claude-shape normalizer for ChatView.
 *
 * Antigravity's conversation files (verified host + cloud):
 *
 *   ~/.gemini/antigravity-cli/conversations/<id>.pb   ← OLD: ENCRYPTED, opaque
 *   ~/.gemini/antigravity-cli/conversations/<id>.db   ← NEW: SQLite (plaintext
 *                                                        protobuf) — DECODABLE
 *   ~/.gemini/antigravity-cli/history.jsonl           ← flat log of USER prompts
 *
 * The full user+assistant conversation lives in the per-conversation files, not
 * history.jsonl. As of ~2026-06-10 those are SQLite `.db` files whose
 * `steps.step_payload` is plaintext protobuf and IS decodable — handled by the
 * dedicated lib/antigravity-db-decoder.ts (#232), which supersedes the earlier
 * "protobuf black box" conclusion (#219/#222). Only the OLD `.pb` files are
 * genuinely encrypted/opaque.
 *
 * THIS normalizer is the FALLBACK for agents with only old `.pb` conversations
 * (no decodable `.db`). history.jsonl is a flat append-only log of USER prompts:
 *
 *   {display: "<the typed/injected user input>", timestamp: <ms epoch>,
 *    workspace: "/workspace", conversationId?: "<uuid>"}
 *
 * Every line is a user turn — no assistant/role/type fields — so each maps to a
 * USER message. For `.pb`-only agents the chat shows the user's prompt history
 * rather than a blank state; live assistant output stays visible in the terminal
 * pane. Current `.db` agents render both sides via the db decoder.
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
