/**
 * Antigravity-CLI conversation `.db` → Claude-shape message decoder.
 *
 * antigravity-cli stores each conversation under its `conversations/` dir:
 *   - OLD (≤ ~2026-06-09): `<uuid>.pb`  — ENCRYPTED, opaque (no plaintext,
 *     no protobuf structure). Genuinely unrecoverable; the chat path falls
 *     back to history.jsonl (user prompts only) for these.
 *   - `.db` era (~2026-06-10): `<uuid>.db` — SQLite, with PLAINTEXT protobuf in
 *     `steps.step_payload`. The FULL user+assistant+tool conversation lives
 *     here and IS decodable. This module decodes it (#232).
 *   - NOW (agy ~1.0.1, ~2026-06-19): `<uuid>.pb` back to OPAQUE; the plaintext
 *     conversation moved to `brain/<uuid>/…/transcript_full.jsonl` (JSONL).
 *     Decoded by `decodeAntigravityTranscript` below; `loadNewestAntigravityChat`
 *     spans both formats newest-mtime-wins (#256). Token usage did NOT survive
 *     this change (gen_metadata gone) — tracked in #256, not this chat path.
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

// ── token-usage extraction (gen_metadata) ────────────────────────────────────
//
// Alongside `steps`, the `.db` carries a `gen_metadata` table — one plaintext-
// protobuf BLOB per model generation — holding the per-call token accounting.
// The chat decoder above never reads it; this is the spend-accounting path that
// closes the antigravity leg of the savings dashboard (was the last "no local
// token floor" provider).
//
// Reverse-engineered field map (gen_metadata.data protobuf), proven via an
// additive identity that held 1440/1440 generations across 19 DBs (host operator
// dir + cloud-agent overlay), 2026-06-16:
//   .1.4.2   = input (prompt) tokens
//   .1.4.3   = candidate tokens  ── INVARIANT: == .1.4.9 + .1.4.10
//   .1.4.9   = output (response text) tokens
//   .1.4.10  = thinking / reasoning tokens   (bills at the output rate)
//   .3.28 / .10.1.28 = model id (e.g. "gemini-3.5-flash-low")
//   .1.21            = model display name (e.g. "Gemini 3.5 Flash (Medium)")
// This mirrors Google's documented `usageMetadata` shape
// (candidatesTokenCount = output + thoughtsTokenCount), which is what makes the
// identity conclusive rather than coincidental.
//
// Do NOT use the monotonic cumulative fields (.1.4.5 / .1.9.10.1) as a session
// total — they branch on sub-trajectories. Sum per-generation instead.
// No separate cached-input field exists, so summed input is a gross (no-cache)
// UPPER bound on the metered alternative — callers should label it as such.
//
// Like the chat path, these constants are unversioned RE over a format that has
// churned once; `assertUsageIdentity` lets callers fail loud on a future change.

interface PbField {
  field: number
  wireType: number
  value?: number // wire type 0 (varint), as a JS number
  bytes?: Buffer // wire type 2 (length-delimited)
}

/** Read a varint as a JS number (BigInt-accumulated so >32-bit values are safe). */
function readVarintNum(b: Buffer, i: number): [number, number] {
  let shift = 0n
  let res = 0n
  while (i < b.length) {
    const x = b[i++]
    res |= BigInt(x & 0x7f) << shift
    if (!(x & 0x80)) break
    shift += 7n
  }
  return [Number(res), i]
}

/**
 * Parse a buffer as a complete protobuf message, KEEPING varint values and
 * length-delimited bytes. Returns null if the bytes don't cleanly form a
 * message (caller treats them as a scalar) — same discipline as
 * `tryParseMessage`, but value-preserving for numeric field reads.
 */
function parseMessageWithValues(b: Buffer): PbField[] | null {
  const fields: PbField[] = []
  let i = 0
  while (i < b.length) {
    const [tag, ni] = readVarintNum(b, i)
    if (ni > b.length) return null
    i = ni
    if (tag === 0) return null
    const field = tag >>> 3
    const wireType = tag & 7
    if (field === 0) return null
    if (wireType === 0) {
      const [value, vi] = readVarintNum(b, i)
      if (vi > b.length) return null
      i = vi
      fields.push({ field, wireType, value })
    } else if (wireType === 2) {
      const [len, li] = readVarintNum(b, i)
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
      return null
    }
  }
  return fields.length > 0 ? fields : null
}

/** Descend `path` (field numbers) through nested sub-messages; return the leaf. */
function fieldAtPath(b: Buffer, path: number[]): PbField | null {
  let fields = parseMessageWithValues(b)
  for (let depth = 0; depth < path.length; depth++) {
    if (!fields) return null
    const f = fields.find((x) => x.field === path[depth])
    if (!f) return null
    if (depth === path.length - 1) return f
    if (f.wireType !== 2 || !f.bytes) return null
    fields = parseMessageWithValues(f.bytes)
  }
  return null
}

function varintAtPath(b: Buffer, path: number[]): number | null {
  const f = fieldAtPath(b, path)
  return f && f.wireType === 0 && typeof f.value === 'number' ? f.value : null
}

function stringAtPath(b: Buffer, path: number[]): string | null {
  const f = fieldAtPath(b, path)
  return f && f.wireType === 2 && f.bytes ? asText(f.bytes) : null
}

export interface AntigravityGenUsage {
  inputTokens: number
  outputTokens: number
  thinkingTokens: number
  /** Candidate-token field as stored (== output + thinking when present). */
  candidateTokens: number | null
  /**
   * Per-generation wall-clock timestamp (unix SECONDS) at `.1.9.4.1`, or null if
   * absent. Lets a daily-spend consumer bucket each gen to its own event_date
   * (a cascade can span days). Verified present + in-range + monotonic-within-db
   * across 1594/1594 gens / 21 DBs (host + cloud), 2026-06-16.
   */
  tsSec: number | null
}

export interface AntigravityUsage {
  model: string | null
  generations: AntigravityGenUsage[]
  totals: {
    inputTokens: number
    outputTokens: number
    thinkingTokens: number
    /** Output + thinking — both bill at the Gemini output rate. */
    outputBilledTokens: number
    generationCount: number
  }
}

/**
 * Extract token usage from a single `gen_metadata.data` protobuf blob, or null
 * if it carries no readable input-token field. Output/thinking absent ⇒ 0.
 */
export function extractGenUsage(payload: Buffer): AntigravityGenUsage | null {
  const inputTokens = varintAtPath(payload, [1, 4, 2])
  if (inputTokens === null) return null
  return {
    inputTokens,
    outputTokens: varintAtPath(payload, [1, 4, 9]) ?? 0,
    thinkingTokens: varintAtPath(payload, [1, 4, 10]) ?? 0,
    candidateTokens: varintAtPath(payload, [1, 4, 3]),
    tsSec: varintAtPath(payload, [1, 9, 4, 1]),
  }
}

/**
 * The load-bearing RE invariant: candidate tokens == output + thinking. Returns
 * the fraction of generations (with a stored candidate field) that satisfy it.
 * A future format change drops this below 1.0 — callers can assert on it to
 * fail loud instead of silently mis-counting spend.
 */
export function usageIdentityRate(gens: AntigravityGenUsage[]): { checked: number; ok: number } {
  let checked = 0
  let ok = 0
  for (const g of gens) {
    if (g.candidateTokens === null) continue
    checked++
    if (g.candidateTokens === g.outputTokens + g.thinkingTokens) ok++
  }
  return { checked, ok }
}

// Plausible bounds for a per-gen UNIX-SECONDS timestamp. Deterministic (no
// wall-clock dependence) so the guard is testable. Chosen to fail loud on every
// realistic `.1.9.4.1` field-map drift: a MILLISECONDS value (~1.7e12) blows
// past MAX, and a mis-read token-count (~1e4–1e6) falls below MIN — either way
// the gen is flagged implausible instead of silently mis-dating spend.
const PLAUSIBLE_TS_MIN_SEC = 1_577_836_800 // 2020-01-01T00:00:00Z
const PLAUSIBLE_TS_MAX_SEC = 2_051_222_400 // 2035-01-01T00:00:00Z

/**
 * Per-gen timestamp sanity, parallel to `usageIdentityRate` but for `tsSec`.
 * The additive-identity guard covers TOKEN fields, not the timestamp, so `ts`
 * needs its own fail-loud check: a `.1.9.4.1` field-map drift (or a seconds↔ms
 * unit slip) drops `ok` below `checked`, letting a daily-spend collector refuse
 * per-day bucketing instead of mis-dating (e.g. a ms value → year ~58000, a
 * token-count misread → 1970). Gens with null `tsSec` are not counted (absence
 * is handled by the collector's deliberate fallback, not treated as drift).
 */
export function tsPlausibilityRate(gens: AntigravityGenUsage[]): { checked: number; ok: number } {
  let checked = 0
  let ok = 0
  for (const g of gens) {
    if (g.tsSec === null) continue
    checked++
    if (g.tsSec >= PLAUSIBLE_TS_MIN_SEC && g.tsSec <= PLAUSIBLE_TS_MAX_SEC) ok++
  }
  return { checked, ok }
}

/**
 * Extract per-generation + summed token usage from an antigravity `.db`.
 * Read-only; returns null for an unreadable db, a db without `gen_metadata`, or
 * one with no decodable generations (so the caller can skip it). The model id is
 * taken from the first generation that reports one (group by model upstream if a
 * db ever mixes models). Never throws into the caller.
 */
export function extractAntigravityUsage(dbPath: string): AntigravityUsage | null {
  let Database: typeof import('better-sqlite3')
  try {
    Database = require('better-sqlite3')
  } catch (err) {
    console.warn('[antigravity-db] better-sqlite3 unavailable; usage extraction skipped:', (err as Error)?.message)
    return null
  }

  let db: import('better-sqlite3').Database | null = null
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true })
    // gen_metadata may be absent on older/edge dbs — degrade to null, not throw.
    const hasTable = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gen_metadata' LIMIT 1")
      .get()
    if (!hasTable) return null

    const rows = db.prepare('SELECT data FROM gen_metadata ORDER BY idx').all() as Array<{
      data: Buffer | Uint8Array | null
    }>

    const generations: AntigravityGenUsage[] = []
    let model: string | null = null
    for (const r of rows) {
      if (!r.data) continue
      const payload = Buffer.isBuffer(r.data) ? r.data : Buffer.from(r.data)
      const usage = extractGenUsage(payload)
      if (!usage) continue
      generations.push(usage)
      if (!model) {
        model =
          stringAtPath(payload, [3, 28]) ?? stringAtPath(payload, [10, 1, 28]) ?? stringAtPath(payload, [1, 21])
      }
    }
    if (generations.length === 0) return null

    const totals = generations.reduce(
      (acc, g) => {
        acc.inputTokens += g.inputTokens
        acc.outputTokens += g.outputTokens
        acc.thinkingTokens += g.thinkingTokens
        return acc
      },
      { inputTokens: 0, outputTokens: 0, thinkingTokens: 0 }
    )

    return {
      model,
      generations,
      totals: {
        ...totals,
        outputBilledTokens: totals.outputTokens + totals.thinkingTokens,
        generationCount: generations.length,
      },
    }
  } catch (err) {
    console.warn(`[antigravity-db] failed to extract usage from ${dbPath}:`, (err as Error)?.message)
    return null
  } finally {
    try {
      db?.close()
    } catch {
      /* ignore */
    }
  }
}

/**
 * The cross-language emit contract (LOCKED 2026-06-16 with the lead + an agent).
 *
 * Part 1 (this module, TS) is the SOLE source of truth for antigravity token
 * counting; the Ziggy spend pipeline (Python, github.com/swickson/ziggy
 * apps/token-ingest) consumes this JSON rather than re-implementing the field
 * map — which would silently drift and defeat the git-homed identity guard.
 * `identityRate` rides IN the payload so the Python collector can assert
 * `ok === checked` before presenting spend (Part-2 carry-forward #1, satisfied
 * by construction). `sourcePath` echoes the input db path verbatim so every
 * emitted record is SELF-ATTRIBUTING. The aggregator is DUMB — it collects every
 * token from every agent under both roots and does NO filtering/exclusion; the
 * DB/dashboard does ALL attribution + scoping by agent/project. So `sourcePath`
 * is for (1) cross-host DEDUP via its stable suffix (agent-uuid + conversation-
 * uuid; same bind-mounted .db seen on two hosts collapses on ON CONFLICT) and
 * (2) DB-side per-agent attribution — NOT a gate and NOT exclusion. The wrapper
 * does NO tenancy parsing — it only echoes. Field names are the locked wire
 * shape — do NOT rename without re-locking with the Ziggy side.
 */
export interface AntigravityUsageContract {
  /** The db path this record was decoded from, echoed verbatim (self-attribution). */
  sourcePath: string
  model: string | null
  /**
   * Per-generation token counts. `ts` is the gen's unix-SECONDS timestamp (or
   * null if absent) — additive field (2026-06-16) so a daily-spend consumer can
   * bucket each gen to its own event_date instead of mis-dating a multi-day
   * cascade onto one date. Backward-compatible: prior consumers ignore it.
   */
  gens: Array<{ input: number; output: number; thinking: number; ts: number | null }>
  totals: { input: number; output: number; thinking: number }
  identityRate: { checked: number; ok: number }
  /**
   * Per-gen `ts` sanity (parallel to identityRate, for the timestamp). Rides in
   * the payload so the collector asserts `ok === checked` before trusting `ts`
   * for per-day bucketing — a `.1.9.4.1` drift / sec↔ms slip fails loud here.
   */
  tsPlausibilityRate: { checked: number; ok: number }
}

/**
 * Project the internal usage shape onto the locked cross-language contract.
 * `sourcePath` is echoed verbatim (no resolution/parsing) — attribution is the
 * collector's job, not the decoder's.
 */
export function toUsageContract(usage: AntigravityUsage, sourcePath: string): AntigravityUsageContract {
  return {
    sourcePath,
    model: usage.model,
    gens: usage.generations.map((g) => ({
      input: g.inputTokens,
      output: g.outputTokens,
      thinking: g.thinkingTokens,
      ts: g.tsSec,
    })),
    totals: {
      input: usage.totals.inputTokens,
      output: usage.totals.outputTokens,
      thinking: usage.totals.thinkingTokens,
    },
    identityRate: usageIdentityRate(usage.generations),
    tsPlausibilityRate: tsPlausibilityRate(usage.generations),
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

// ── brain/ JSONL transcript (post-`.db` format, agy ~1.0.1+) ──────────────────
//
// antigravity-cli changed conversation storage a THIRD time (GH #256): the
// current CLI (agy 1.0.1, fleet-wide ~2026-06-19) no longer writes the plaintext
// SQLite `conversations/<uuid>.db` the section above decodes. It reverted the
// `conversations/<uuid>.pb` to an OPAQUE blob and moved the PLAINTEXT
// conversation to a per-conversation JSONL transcript at:
//   brain/<uuid>/.system_generated/logs/transcript_full.jsonl
// one JSON object per line. Observed `type`s (verified on an agent + an agent,
// both 1.0.1):
//   USER_INPUT        (source USER_EXPLICIT) → user; `content` wrapped in
//                       <USER_REQUEST>…</USER_REQUEST> (stripped here)
//   PLANNER_RESPONSE  (source MODEL)         → assistant; `content` = visible
//                       text, `thinking` = reasoning (ignored for chat),
//                       `tool_calls[]` = {name, args:{toolSummary,toolAction,…}}
//                       dispatched BEFORE the content step
//   EPHEMERAL_MESSAGE / CONVERSATION_HISTORY (source SYSTEM) → skipped (reminders/
//                       context, not conversation)
//   VIEW_FILE / RUN_COMMAND (source MODEL)   → tool RESULTS (verbose prose blobs);
//                       skipped — the clean tool label comes from the dispatching
//                       PLANNER_RESPONSE.tool_calls instead
// Tool labels fold into the assistant bubble as `↳ <label>` lines, mirroring the
// `.db` decoder's two-sided output. Token usage is NOT recoverable from this
// format (the `.db` gen_metadata table is gone; opaque `.pb` carries none) — that
// regression is tracked separately (#256), out of this chat path.

const TX_REL_LOG = ['.system_generated', 'logs', 'transcript_full.jsonl']

/**
 * Pull the real user message out of an antigravity USER_INPUT `content`. The
 * actual turn is wrapped in <USER_REQUEST>…</USER_REQUEST>; the harness APPENDS
 * sidecar sections after it (<ADDITIONAL_METADATA> with local time, ephemeral
 * reminders) that are NOT what the user typed — so prefer the wrapped inner text.
 * Falls back to the leading prose (cut at the first sidecar tag) when no wrapper
 * is present.
 */
function extractUserText(raw: string): string {
  const m = raw.match(/<USER_REQUEST>\s*([\s\S]*?)\s*<\/USER_REQUEST>/i)
  if (m) return m[1].trim()
  return raw.split(/\n?\s*<(?:ADDITIONAL_METADATA|EPHEMERAL_MESSAGE|USER_REQUEST)\b/i)[0].trim()
}

/**
 * Decode one `brain/<uuid>/.system_generated/logs/transcript_full.jsonl` into
 * ordered Claude-shape messages. USER_INPUT → user, PLANNER_RESPONSE.content →
 * assistant, with each turn's `tool_calls` folded into the following assistant
 * bubble as `↳ <label>` lines (orphan tool dispatches with no content turn flush
 * as their own thin assistant bubble so nothing is lost). Returns [] for an
 * unreadable/empty/absent transcript — never throws into the caller.
 */
export function decodeAntigravityTranscript(transcriptPath: string): NormalizedMessage[] {
  const fs = require('fs') as typeof import('fs')
  let content: string
  try {
    content = fs.readFileSync(transcriptPath, 'utf8')
  } catch {
    return []
  }

  const messages: NormalizedMessage[] = []
  let pendingTools: string[] = []
  let idx = 0

  const flushOrphanTools = (ts?: string) => {
    if (pendingTools.length === 0) return
    messages.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: pendingTools.map((l) => `↳ ${l}`).join('\n') }] },
      ...(ts ? { timestamp: ts } : {}),
      uuid: `antigravity-tx-${idx++}`,
    })
    pendingTools = []
  }

  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let o: any
    try {
      o = JSON.parse(trimmed)
    } catch {
      continue // tolerate a partially-written final line on a live transcript
    }
    if (!o || typeof o !== 'object') continue
    const type = o.type
    const ts = typeof o.created_at === 'string' ? o.created_at : undefined

    if (type === 'USER_INPUT') {
      // A user turn closes any open tool dispatch that never produced content.
      flushOrphanTools(ts)
      const text = typeof o.content === 'string' ? extractUserText(o.content) : ''
      if (!text) continue
      messages.push({
        type: 'user',
        message: { content: [{ type: 'text', text }] },
        ...(ts ? { timestamp: ts } : {}),
        uuid: `antigravity-tx-${idx++}`,
      })
      continue
    }

    if (type === 'PLANNER_RESPONSE') {
      if (Array.isArray(o.tool_calls)) {
        for (const tc of o.tool_calls) {
          const label = tc?.args?.toolSummary || tc?.args?.toolAction || tc?.name
          if (label) pendingTools.push(String(label))
        }
      }
      const text = typeof o.content === 'string' ? o.content.trim() : ''
      if (!text) continue // pure thinking/tool-dispatch step — tools stay buffered
      const toolLines = pendingTools.map((l) => `↳ ${l}`)
      pendingTools = []
      const full = toolLines.length ? `${text}\n${toolLines.join('\n')}` : text
      messages.push({
        type: 'assistant',
        message: { content: [{ type: 'text', text: full }] },
        ...(ts ? { timestamp: ts } : {}),
        uuid: `antigravity-tx-${idx++}`,
      })
      continue
    }
    // EPHEMERAL_MESSAGE / CONVERSATION_HISTORY / VIEW_FILE / RUN_COMMAND → skip
  }
  flushOrphanTools()
  return messages
}

/**
 * Find the newest `brain/<uuid>/.system_generated/logs/transcript_full.jsonl`
 * (by mtime) under an antigravity `brain/` dir, or null if there are none (dir
 * absent, or no transcript written yet — cold-start / pre-first-turn). The
 * caller passes the `brain/` dir; each child is a per-conversation `<uuid>` dir.
 */
export function findNewestAntigravityTranscript(brainDir: string): { path: string; mtime: Date } | null {
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  let entries: string[]
  try {
    entries = fs.readdirSync(brainDir)
  } catch {
    return null
  }
  let best: { path: string; mtime: Date } | null = null
  for (const name of entries) {
    const full = path.join(brainDir, name, ...TX_REL_LOG)
    try {
      const stat = fs.statSync(full)
      if (!stat.isFile()) continue
      if (!best || stat.mtime > best.mtime) best = { path: full, mtime: stat.mtime }
    } catch {
      /* no transcript for this conversation dir — skip */
    }
  }
  return best
}

/**
 * Resolve + decode the newest antigravity conversation for the chat panel,
 * spanning BOTH on-disk formats: the plaintext SQLite `conversations/<uuid>.db`
 * (#232) and the newer `brain/<uuid>/…/transcript_full.jsonl` (#256). Pass the
 * antigravity-cli ROOT dir (host `~/.gemini/antigravity-cli` or cloud
 * `<agentDir>/antigravity-app-data`) — both `conversations/` and `brain/` sit
 * directly under it.
 *
 * Precedence = NEWEST-WINS BY MTIME, brain-preferred on a tie. Rationale
 * (documented per KAI's #256 ask): agy 1.0.1 writes ONLY brain (no `.db`), but an
 * agent that ran on the `.db`-era version AND on 1.0.1 carries a STALE June `.db`
 * alongside its CURRENT brain transcript. A strict `.db`-first order would surface
 * the stale conversation; newest-mtime surfaces whichever source the agent is
 * actually writing now, and stays correct if a future agy revives the `.db`. The
 * `>=` tie-break favors brain because that's the live format today. Returns null
 * when neither source exists (caller falls back to the history.jsonl user-prompt
 * path). Never throws.
 */
export function loadNewestAntigravityChat(
  conversationRootDir: string
): { path: string; mtime: Date; messages: NormalizedMessage[]; source: 'db' | 'transcript' } | null {
  const path = require('path') as typeof import('path')
  const dbCand = findNewestAntigravityDb(path.join(conversationRootDir, 'conversations'))
  const txCand = findNewestAntigravityTranscript(path.join(conversationRootDir, 'brain'))

  let use: 'db' | 'transcript' | null = null
  if (dbCand && txCand) use = txCand.mtime >= dbCand.mtime ? 'transcript' : 'db'
  else if (txCand) use = 'transcript'
  else if (dbCand) use = 'db'
  if (!use) return null

  if (use === 'transcript') {
    return { ...txCand!, messages: decodeAntigravityTranscript(txCand!.path), source: 'transcript' }
  }
  return { ...dbCand!, messages: decodeAntigravityDb(dbCand!.path), source: 'db' }
}
