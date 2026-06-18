/**
 * OpenCode conversation decoder (SQLite).
 *
 * OpenCode (v1.x, verified v1.17.8) stores its conversations in a single SQLite
 * database — `~/.local/share/opencode/opencode.db` (+ `-wal`/`-shm`) on host,
 * the mounted per-agent data dir in a container. This is the SAME shape on host
 * and container (so the decoder is harness-format work, built once). It is NOT
 * the `storage/*.json` fan-out that older OpenCode / ccusage docs describe —
 * that format predates the v1.x SQLite migration (see docs/OPENCODE-HARNESS-SPEC.md
 * and opencode-schema-findings.md).
 *
 * Schema (relational, JSON in `*.data` columns):
 *   project(id, worktree, …)
 *   session(id, project_id, directory, title, model, time_created, time_updated, tokens_*, …)
 *   message(id, session_id, time_created, data)   data = {role, model, tokens, finish, …}
 *   part(id, message_id, session_id, time_created, data)   data discriminated by .type:
 *       text        → { type:'text', text }
 *       tool        → { type:'tool', tool, callID, state:{ status, input, output, … } }
 *       step-start  → { type:'step-start', snapshot? }
 *       step-finish → { type:'step-finish', reason, tokens, cost }
 *
 * Modeled structurally on lib/antigravity-db-decoder.ts (the other SQLite
 * harness): readonly better-sqlite3 open (opens the WAL too, so live turns
 * decode), never-throw, lazy `require` so a missing/unbuildable native module
 * degrades to no-decode instead of crashing the chat resolver. Unlike
 * antigravity, the payload is plain JSON (no protobuf walk) and the DB is a
 * single file (one DB, many sessions) — "newest conversation" = newest
 * `session` by `time_updated`, not newest `.db` file.
 */

import type { NormalizedMessage } from './gemini-message-normalizer'

/** The single SQLite DB filename inside an OpenCode data dir. */
export const OPENCODE_DB_FILENAME = 'opencode.db'

interface OpencodeSessionRow {
  id: string
  time_updated: number | bigint
}
interface OpencodeMessageRow {
  id: string
  time_created: number | bigint
  data: string
}
interface OpencodePartRow {
  data: string
}

/** Concise one-line summary of a tool call's input, for the folded `↳` line. */
function summarizeToolInput(tool: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const i = input as Record<string, unknown>
  // Prefer the most descriptive field per common OpenCode tool.
  const pick =
    i.command ?? i.filePath ?? i.path ?? i.pattern ?? i.query ?? i.description
  if (typeof pick === 'string') {
    const s = pick.replace(/\s+/g, ' ').trim()
    return s.length > 120 ? `${s.slice(0, 117)}…` : s
  }
  return ''
}

/** Render a single message's ordered parts into one text blob (Claude shape). */
function renderParts(parts: OpencodePartRow[]): string {
  const lines: string[] = []
  for (const p of parts) {
    let d: any
    try {
      d = JSON.parse(p.data)
    } catch {
      continue
    }
    if (!d || typeof d !== 'object') continue
    switch (d.type) {
      case 'text':
        if (typeof d.text === 'string' && d.text.length > 0) lines.push(d.text)
        break
      case 'tool': {
        const tool = typeof d.tool === 'string' ? d.tool : 'tool'
        const summary = summarizeToolInput(tool, d.state?.input)
        lines.push(summary ? `↳ ${tool}: ${summary}` : `↳ ${tool}`)
        break
      }
      // step-start / step-finish are agent-step/usage boundaries — not chat content.
      default:
        break
    }
  }
  return lines.join('\n').trim()
}

function unixToIso(value: number | bigint | undefined): string | undefined {
  if (value == null) return undefined
  const ms = Number(value)
  if (!Number.isFinite(ms) || ms <= 0) return undefined
  try {
    return new Date(ms).toISOString()
  } catch {
    return undefined
  }
}

/**
 * Decode the newest conversation (session) in an OpenCode `opencode.db` into
 * ordered, Claude-shaped messages PLUS the selected `sessionId`. Tool parts fold
 * into their assistant turn as `↳ <tool>` lines (mirrors the antigravity
 * tool-step fold). Returns null for an unreadable/empty DB or one with no
 * sessions — never throws into the caller.
 *
 * The `sessionId` lets the live-update path (server.mjs) detect SESSION
 * ROLLOVER: OpenCode keeps many sessions in one DB and "newest" can change
 * mid-connection (the agent starts a new task), so a diff-by-count baseline must
 * reset when the newest session id changes — else `slice(prev)` mis-slices.
 *
 * @param dbPath absolute path to the `opencode.db` file
 */
export function decodeNewestOpencodeSession(
  dbPath: string,
): { sessionId: string; messages: NormalizedMessage[] } | null {
  let Database: typeof import('better-sqlite3')
  try {
    // Lazy require: a missing/unbuildable native module degrades to no-decode
    // instead of crashing the chat resolver. The `new Database()` below is the
    // real ABI proof — a bare require() is a false-green (lazy native binding).
    Database = require('better-sqlite3')
  } catch (err) {
    console.warn('[opencode-db] better-sqlite3 unavailable; decode skipped:', (err as Error)?.message)
    return null
  }

  let db: import('better-sqlite3').Database | null = null
  try {
    // readonly opens the WAL too, so live (in-progress) conversations decode
    // their most recent turns. fileMustExist avoids creating an empty db.
    db = new Database(dbPath, { readonly: true, fileMustExist: true })

    // Newest conversation = newest session by time_updated (one DB, many sessions).
    const session = db
      .prepare('SELECT id, time_updated FROM session ORDER BY time_updated DESC LIMIT 1')
      .get() as OpencodeSessionRow | undefined
    if (!session) return null

    const messageRows = db
      .prepare(
        'SELECT id, time_created, data FROM message WHERE session_id = ? ORDER BY time_created, id',
      )
      .all(session.id) as OpencodeMessageRow[]

    const partStmt = db.prepare(
      'SELECT data FROM part WHERE message_id = ? ORDER BY time_created, id',
    )

    const messages: NormalizedMessage[] = []
    for (const m of messageRows) {
      let mdata: any
      try {
        mdata = JSON.parse(m.data)
      } catch {
        continue
      }
      const role = mdata?.role
      if (role !== 'user' && role !== 'assistant') continue

      const parts = partStmt.all(m.id) as OpencodePartRow[]
      const text = renderParts(parts)
      if (!text) continue // skip empty turns (e.g. an assistant msg with only step boundaries)

      messages.push({
        type: role,
        message: { content: [{ type: 'text', text }] },
        timestamp: unixToIso(m.time_created),
        uuid: `opencode-db-${m.id}`,
      })
    }

    return { sessionId: String(session.id), messages }
  } catch (err) {
    console.warn(`[opencode-db] failed to decode ${dbPath}:`, (err as Error)?.message)
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
 * Decode the newest conversation in an OpenCode `opencode.db` into ordered,
 * Claude-shaped messages. Thin wrapper over {@link decodeNewestOpencodeSession}
 * for callers that don't need the session id. Returns [] when there's nothing to
 * decode — never throws.
 *
 * @param dbPath absolute path to the `opencode.db` file
 */
export function decodeOpencodeDb(dbPath: string): NormalizedMessage[] {
  return decodeNewestOpencodeSession(dbPath)?.messages ?? []
}

/**
 * Locate the OpenCode `opencode.db` inside a data dir, returning its path +
 * mtime, or null if absent. (Single file — no glob, unlike antigravity's
 * per-conversation `.db` fan-out.)
 *
 * @param dataDir the OpenCode data dir (holds opencode.db + auth.json)
 */
export function findOpencodeDb(dataDir: string): { path: string; mtime: Date } | null {
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  const full = path.join(dataDir, OPENCODE_DB_FILENAME)
  try {
    const stat = fs.statSync(full)
    if (!stat.isFile()) return null
    return { path: full, mtime: stat.mtime }
  } catch {
    return null
  }
}

/**
 * Convenience: resolve + decode the newest conversation in the OpenCode
 * `opencode.db` under a data dir. Returns null when there's no DB to decode, or
 * a populated result otherwise. An empty `messages` array with a non-null result
 * means the DB existed but decoded to nothing (treated as "no usable content").
 *
 * @param dataDir the OpenCode data dir (holds opencode.db)
 */
export function loadNewestOpencodeConversation(
  dataDir: string,
): { path: string; mtime: Date; messages: NormalizedMessage[]; sessionId?: string } | null {
  const found = findOpencodeDb(dataDir)
  if (!found) return null
  const decoded = decodeNewestOpencodeSession(found.path)
  return { ...found, messages: decoded?.messages ?? [], sessionId: decoded?.sessionId }
}
