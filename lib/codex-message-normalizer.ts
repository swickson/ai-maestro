/**
 * Codex CLI rollout JSONL → Claude-shape normalizer for ChatView consumption.
 *
 * Codex writes its conversation transcript as rollout-*.jsonl under
 * ~/.codex/sessions/<YYYY>/<MM>/<DD>/ (bind-mounted single-source via the
 * OPT-B ~/.codex dir mount, kanban 01e11bf9 / commit 32866ee). Each line is:
 *
 *   {timestamp, type:"session_meta",  payload:{...}}          ← skip
 *   {timestamp, type:"turn_context",  payload:{...}}          ← skip
 *   {timestamp, type:"event_msg",     payload:{type:"task_started", ...}}  ← skip
 *   {timestamp, type:"response_item", payload:{type:"message", role, content:[...]}}
 *   {timestamp, type:"response_item", payload:{type:"reasoning"|"function_call"|
 *                                              "function_call_output", ...}}  ← skip
 *
 * Only `response_item` lines whose `payload.type === 'message'` carry user-
 * facing conversation. Within those, `role` is 'developer' (system/permissions
 * + injected AGENTS.md context), 'user', or 'assistant'. `content` is an array
 * of `{type:'input_text'|'output_text', text}` blocks. We surface user +
 * assistant turns and skip 'developer' (system noise), mirroring how the Gemini
 * normalizer skips 'info' lines.
 *
 * ChatView expects the Claude shape: `{type, message:{content:[blocks]},
 * timestamp, uuid}` where content blocks are `{type:'text', text:'...'}`.
 * Normalizing in the service layer (per the Gemini/Antigravity precedent)
 * keeps ChatView provider-agnostic — no client-side branching on `program`.
 *
 * Empirically pinned from live cloud-Codex rollouts (Gushie ca9d97c2,
 * Holmes 2026-06-15, issue #159). Reasoning/tool-call items are intentionally
 * out of scope for this first pass (a follow-up can map `reasoning` → a
 * thinking block, mirroring the Claude path, once it's worth the surface).
 */

export interface NormalizedMessage {
  type: 'user' | 'assistant'
  message: { content: Array<{ type: 'text'; text: string }> }
  timestamp?: string
  uuid?: string
}

/**
 * Normalize one parsed Codex rollout JSONL line into a Claude-shaped message,
 * or return null if the line should be skipped (session/turn/event metadata,
 * reasoning/tool items, system 'developer' turns, or empty content).
 */
export function normalizeCodexLine(raw: any): NormalizedMessage | null {
  if (!raw || typeof raw !== 'object') return null
  if (raw.type !== 'response_item') return null

  const payload = raw.payload
  if (!payload || typeof payload !== 'object') return null
  if (payload.type !== 'message') return null

  const role = payload.role
  // Surface only the conversation turns. 'developer' carries injected
  // system/permissions context, not user-facing chat — skip it.
  if (role !== 'user' && role !== 'assistant') return null

  const text = extractCodexText(payload.content)
  if (!text) return null

  return {
    type: role,
    message: { content: [{ type: 'text', text }] },
    timestamp: raw.timestamp,
  }
}

/**
 * Extract plain text from a Codex message `content` array of
 * `{type:'input_text'|'output_text', text}` blocks (or a bare string, defensively).
 * Multiple blocks are joined with blank lines so ChatView's text-block joiner
 * renders cleanly.
 */
function extractCodexText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block: any) => (typeof block?.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n\n')
  }
  return ''
}
