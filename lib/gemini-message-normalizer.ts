/**
 * Gemini CLI JSONL → Claude-shape normalizer for ChatView consumption.
 *
 * Gemini CLI writes its conversation transcript to
 * ~/.gemini/tmp/<project>/chats/session-*.jsonl with a different shape than
 * Claude Code:
 *
 *   {sessionId, projectHash, startTime, lastUpdated, kind}  ← first metadata line
 *   {id, timestamp, type:"user",   content:[{text:"..."}]}
 *   {id, timestamp, type:"gemini", content:"plain string"}
 *   {id, timestamp, type:"info",   content:"system message"}  ← skip in render
 *   {"$set":...}  ← interleaved state-update lines, skip in render
 *
 * ChatView expects the Claude shape: `{type, message:{content:[blocks]},
 * timestamp, uuid}` where content blocks are `{type:'text', text:'...'}`.
 * Normalizing in the service layer (per Watson 2026-05-11 spec) keeps
 * ChatView provider-agnostic — no client-side branching on `program`.
 *
 * Empirically pinned via Holmes Mason/Optic 2026-05-11 (kanban d937c33d).
 */

export interface NormalizedMessage {
  type: 'user' | 'assistant'
  message: { content: Array<{ type: 'text'; text: string }> }
  timestamp?: string
  uuid?: string
}

/**
 * Normalize one parsed Gemini JSONL line into a Claude-shaped message, or
 * return null if the line should be skipped (metadata header, info events,
 * state-update sidecar lines).
 */
export function normalizeGeminiLine(raw: any): NormalizedMessage | null {
  if (!raw || typeof raw !== 'object') return null

  // Metadata header line — first line of every Gemini session file.
  if (raw.kind && raw.sessionId && raw.startTime) return null

  // State-update sidecar lines emitted by Gemini's reactive store.
  if (raw.$set !== undefined) return null

  const type = raw.type
  if (type === 'info') return null
  if (type !== 'user' && type !== 'gemini') return null

  // Extract text content. Gemini user lines wrap content in [{text:'...'}],
  // Gemini agent lines emit a plain string; both normalize to a single
  // text block so ChatView's getMessageContent (which joins text blocks)
  // renders cleanly.
  const text = extractGeminiText(raw.content)
  if (!text) return null

  return {
    type: type === 'user' ? 'user' : 'assistant',
    message: { content: [{ type: 'text', text }] },
    timestamp: raw.timestamp,
    uuid: raw.id,
  }
}

function extractGeminiText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((block: any) => (typeof block?.text === 'string' ? block.text : ''))
      .filter(Boolean)
      .join('\n\n')
  }
  return ''
}
