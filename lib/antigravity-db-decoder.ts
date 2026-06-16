/**
 * Antigravity-CLI conversation `.db` → Claude-shape message decoder.
 *
 * antigravity-cli stores each conversation under its `conversations/` dir:
 *   - OLD (≤ ~2026-06-09): `<uuid>.pb`  — ENCRYPTED, opaque (no plaintext,
 *     no protobuf structure). Genuinely unrecoverable; the chat path falls
 *     back to history.jsonl (user prompts only) for these.
 *   - NEW (~2026-06-10+):  `<uuid>.db`  — SQLite, with PLAINTEXT protobuf in
 *     `steps.step_payload`. The FULL user+assistant+tool conversation lives
 *     here and IS decodable. This module decodes it (#232).
 *
 * This supersedes the earlier "protobuf black box, assistant side
 * unrecoverable" conclusion (#219/#222) — that held for the encrypted `.pb`
 * format, not the current SQLite one.
 *
 * No protoc / protobufjs needed: a generic protobuf wire-walk (varint +
 * length-delimited fields, recursing into sub-messages) collects string
 * leaves keyed by their nested field-path, then a small reverse-engineered
 * (step_type, field-path) map projects them onto user/assistant/tool turns.
 * We depend on ~6 field constants rather than a compiled schema, so a Google
 * format change degrades loudly (assistant text blanks) and is cheap to re-RE.
 *
 * SQLite schema (CLI `.db`):
 *   steps(idx, step_type, status, ..., step_payload BLOB, ...)  -- one row per
 *     turn-event, ordered by idx
 *   trajectory_meta(trajectory_id, cascade_id, trajectory_type, source)
 *
 * Reverse-engineered field map (verified on host + cloud, WAL-active convos):
 *   step_type 14 = USER prompt        → text at `.19.2`
 *   step_type 15 = ASSISTANT turn     → text `.20.1`/`.20.8` (always), thought
 *                                        summary `.20.3` (sometimes), tool name
 *                                        `.20.7.2`
 *   step_type 21 = tool RESULT        → action label `.5.30`
 *   step_type 8  = tool CALL          → action label `.5.30`
 *   (9/23/98/5/101 = infra/metadata, skipped)
 *
 * Tool steps are folded into the preceding assistant turn (NormalizedMessage
 * only models user/assistant), so the chat reads as a clean two-sided window.
 */

import type { NormalizedMessage } from './gemini-message-normalizer'

// ── protobuf wire-walk ───────────────────────────────────────────────────────

interface Leaf {
  path: string
  text: string
}

function readVarint(b: Buffer, i: number): [number, number] {
  let shift = 0
  let res = 0
  while (i < b.length) {
    const x = b[i++]
    res |= (x & 0x7f) << shift
    if (!(x & 0x80)) break
    shift += 7
  }
  return [res >>> 0, i]
}

/**
 * Decode a length-delimited region as UTF-8 text, or return null if it isn't
 * plausibly text (invalid UTF-8, or mostly control bytes → treat as a nested
 * sub-message / binary instead).
 */
function asText(buf: Buffer): string | null {
  if (buf.length === 0) return null
  const s = buf.toString('utf8')
  // Lossy round-trip ⇒ not valid UTF-8 ⇒ not a string field.
  if (Buffer.byteLength(s, 'utf8') !== buf.length) return null
  // Reject any raw control byte except common whitespace. Protobuf field tags
  // are themselves low bytes (0x08/0x12/0x1a/…), so a nested sub-message that
  // happens to be mostly ASCII (e.g. a short `{tool_name}` wrapper) would
  // otherwise be misread as a string and hide its inner fields. Real message
  // text (prose, JSON args) contains no control bytes beyond \n\t\r, so this is
  // both stricter and more correct than a printable-ratio threshold.
  for (let i = 0; i < s.length; i++) {
    const cp = s.charCodeAt(i)
    if (cp < 0x20 && cp !== 0x0a && cp !== 0x09 && cp !== 0x0d) return null
    if (cp === 0x7f) return null
  }
  return s
}

interface Field {
  field: number
  wireType: number
  bytes?: Buffer // present for length-delimited (wire type 2)
}

/**
 * Parse a buffer as a COMPLETE protobuf message: every byte must consume into a
 * valid field with a known wire type, with no truncation. Returns the field
 * list on success, or null if the bytes don't cleanly form a message (so the
 * caller can treat them as a scalar string/bytes instead). This "parse-as-
 * message-first, fall back to text" disambiguation is what schema-less protobuf
 * inspectors use — it correctly recurses nested `{1: "text"}` wrappers while
 * leaving natural-language / JSON leaves (which don't fully parse) as text.
 */
function tryParseMessage(b: Buffer): Field[] | null {
  const fields: Field[] = []
  let i = 0
  while (i < b.length) {
    const [tag, ni] = readVarint(b, i)
    if (ni > b.length) return null
    i = ni
    if (tag === 0) return null
    const field = tag >>> 3
    const wireType = tag & 7
    if (field === 0) return null
    if (wireType === 0) {
      const [, vi] = readVarint(b, i)
      if (vi > b.length) return null
      i = vi
      fields.push({ field, wireType })
    } else if (wireType === 2) {
      const [len, li] = readVarint(b, i)
      i = li
      if (len < 0 || i + len > b.length) return null
      fields.push({ field, wireType, bytes: b.subarray(i, i + len) })
      i += len
    } else if (wireType === 1) {
      if (i + 8 > b.length) return null
      i += 8
      fields.push({ field, wireType })
    } else if (wireType === 5) {
      if (i + 4 > b.length) return null
      i += 4
      fields.push({ field, wireType })
    } else {
      return null // wire types 3/4 (groups, deprecated) / 6/7 (invalid)
    }
  }
  return fields.length > 0 ? fields : null
}

/**
 * Walk a protobuf message, collecting string leaves keyed by their nested
 * field-path (e.g. ".20.1"). For each length-delimited value we prefer a
 * complete sub-message parse (recurse) and fall back to text — a best-effort
 * reader over an unversioned format that ends gracefully on malformed bytes.
 */
function walk(b: Buffer, prefix = '', out: Leaf[] = []): Leaf[] {
  const fields = tryParseMessage(b)
  if (!fields) return out
  for (const f of fields) {
    if (f.wireType !== 2 || !f.bytes) continue
    const sub = f.bytes
    const nested = tryParseMessage(sub)
    // Recurse only into a sub-message with real nested structure (at least one
    // length-delimited child). A buffer that "parses" as nothing but varints is
    // far more likely a short ASCII string (e.g. "hi" → tag+varint) that
    // coincidentally consumes, so prefer the text reading in that case.
    const structural = nested?.some((nf) => nf.wireType === 2) ?? false
    if (structural) {
      walk(sub, `${prefix}.${f.field}`, out)
    } else {
      const text = asText(sub)
      if (text !== null) out.push({ path: `${prefix}.${f.field}`, text })
    }
  }
  return out
}

function pick(leaves: Leaf[], targetPath: string): string | undefined {
  for (const l of leaves) if (l.path === targetPath) return l.text
  return undefined
}

// ── step → message projection ────────────────────────────────────────────────

const STEP_USER = 14
const STEP_ASSISTANT = 15
const STEP_TOOL_RESULT = 21
const STEP_TOOL_CALL = 8

interface DecodedStep {
  idx: number
  role: 'user' | 'assistant' | 'tool'
  text: string
  timestampMs?: number
}

function decodeStep(idx: number, stepType: number, payload: Buffer): DecodedStep | null {
  const leaves = walk(payload)

  if (stepType === STEP_USER) {
    const text = pick(leaves, '.19.2')
    return text ? { idx, role: 'user', text } : null
  }

  if (stepType === STEP_ASSISTANT) {
    const text = pick(leaves, '.20.1') ?? pick(leaves, '.20.8') ?? pick(leaves, '.20.3')
    const tool = pick(leaves, '.20.7.2')
    if (text) return { idx, role: 'assistant', text }
    if (tool) return { idx, role: 'assistant', text: `↳ ${tool}` }
    return null
  }

  if (stepType === STEP_TOOL_RESULT || stepType === STEP_TOOL_CALL) {
    const label = pick(leaves, '.5.30')
    return label ? { idx, role: 'tool', text: label } : null
  }

  return null
}

/**
 * Decode every step in an antigravity `.db` into ordered Claude-shape messages.
 * Tool steps are appended to the preceding assistant turn as `↳ <label>` lines
 * (NormalizedMessage only models user/assistant). Returns [] for an unreadable
 * or empty db — never throws into the caller.
 */
export function decodeAntigravityDb(dbPath: string): NormalizedMessage[] {
  let Database: typeof import('better-sqlite3')
  try {
    // Required lazily so a missing/unbuildable native module degrades to the
    // history.jsonl fallback instead of crashing the chat resolver (#232).
    Database = require('better-sqlite3')
  } catch (err) {
    console.warn('[antigravity-db] better-sqlite3 unavailable; assistant-side decode skipped:', (err as Error)?.message)
    return []
  }

  let db: import('better-sqlite3').Database | null = null
  try {
    // readonly opens the WAL too, so live (in-progress) conversations decode
    // their most recent turns. fileMustExist avoids creating an empty db.
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    const rows = db.prepare('SELECT idx, step_type, step_payload FROM steps ORDER BY idx').all() as Array<{
      idx: number | bigint
      step_type: number | bigint
      step_payload: Buffer | Uint8Array | null
    }>

    const messages: NormalizedMessage[] = []
    let lastAssistant: NormalizedMessage | null = null

    for (const r of rows) {
      if (!r.step_payload) continue
      const payload = Buffer.isBuffer(r.step_payload) ? r.step_payload : Buffer.from(r.step_payload)
      const step = decodeStep(Number(r.idx), Number(r.step_type), payload)
      if (!step) continue

      if (step.role === 'tool') {
        // Fold the tool action into the current assistant bubble.
        if (lastAssistant) {
          lastAssistant.message.content[0].text += `\n↳ ${step.text}`
        }
        continue
      }

      const msg: NormalizedMessage = {
        type: step.role,
        message: { content: [{ type: 'text', text: step.text }] },
        uuid: `antigravity-db-${step.idx}`,
      }
      messages.push(msg)
      lastAssistant = step.role === 'assistant' ? msg : null
    }

    return messages
  } catch (err) {
    console.warn(`[antigravity-db] failed to decode ${dbPath}:`, (err as Error)?.message)
    return []
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * Find the newest `<uuid>.db` conversation in an antigravity `conversations/`
 * dir (by mtime), or null if there are none (e.g. only old encrypted `.pb`
 * files, or the dir is absent). The caller passes the dir that contains the
 * per-conversation files — host `~/.gemini/antigravity-cli/conversations/` or
 * cloud `<agentDir>/antigravity-app-data/conversations/`.
 */
export function findNewestAntigravityDb(conversationsDir: string): { path: string; mtime: Date } | null {
  // fs is imported lazily to keep this module usable from both the Next.js
  // bundle and the raw `tsx server.mjs` WS path without a static fs import
  // surprising the bundler.
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  let entries: string[]
  try {
    entries = fs.readdirSync(conversationsDir)
  } catch {
    return null
  }
  let best: { path: string; mtime: Date } | null = null
  for (const name of entries) {
    if (!name.endsWith('.db')) continue
    const full = path.join(conversationsDir, name)
    try {
      const stat = fs.statSync(full)
      if (!stat.isFile()) continue
      if (!best || stat.mtime > best.mtime) best = { path: full, mtime: stat.mtime }
    } catch {
      /* skip unreadable entry */
    }
  }
  return best
}

/**
 * Convenience: resolve + decode the newest conversation `.db` under a
 * `conversations/` dir. Returns null when there's no `.db` to decode (so the
 * caller can fall back to the history.jsonl user-prompt path), or a populated
 * result otherwise. An empty `messages` array with a non-null result means the
 * db existed but decoded to nothing (treated as "no usable content" by callers).
 */
export function loadNewestAntigravityConversation(
  conversationsDir: string
): { path: string; mtime: Date; messages: NormalizedMessage[] } | null {
  const newest = findNewestAntigravityDb(conversationsDir)
  if (!newest) return null
  return { ...newest, messages: decodeAntigravityDb(newest.path) }
}
