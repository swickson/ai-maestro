/**
 * OpenCode conversation `.db` decoder.
 *
 * OpenCode (v1.x, verified v1.17.8) stores conversations in a single SQLite
 * database `opencode.db` (relational project → session → message → part, with
 * JSON in `*.data` columns) — NOT the `storage/*.json` fan-out older docs/ccusage
 * describe (that predates the v1.x SQLite migration). See
 * docs/OPENCODE-HARNESS-SPEC.md + opencode-schema-findings.md.
 *
 * These tests build a SYNTHETIC opencode.db (no real conversation content
 * committed) with the real queried columns and pin: role mapping, part-type
 * dispatch (text content, tool-part folding into the turn, step-start/step-finish
 * skipped), newest-session-by-time_updated selection, empty-turn skipping, and
 * graceful empty-result on a missing/garbage db. The decode shapes mirror real
 * rows captured from a bananajr install (a "tech stack" Q&A + a bash/read/edit
 * tool session).
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import {
  decodeOpencodeDb,
  decodeNewestOpencodeSession,
  findOpencodeDb,
  loadNewestOpencodeConversation,
  OPENCODE_DB_FILENAME,
} from '@/lib/opencode-db-decoder'

interface MsgSpec {
  id: string
  session_id: string
  time_created: number
  data: Record<string, unknown>
  parts: Array<{ id: string; time_created: number; data: Record<string, unknown> }>
}

/** Create a synthetic opencode.db with just the columns the decoder reads. */
function writeDb(
  name: string,
  sessions: Array<{ id: string; time_updated: number }>,
  messages: MsgSpec[],
): string {
  const dbPath = path.join(tmpDir, name)
  const db = new Database(dbPath)
  db.exec(`
    CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER NOT NULL);
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
  `)
  const sStmt = db.prepare('INSERT INTO session (id, time_updated) VALUES (?, ?)')
  for (const s of sessions) sStmt.run(s.id, s.time_updated)
  const mStmt = db.prepare('INSERT INTO message (id, session_id, time_created, data) VALUES (?, ?, ?, ?)')
  const pStmt = db.prepare('INSERT INTO part (id, message_id, session_id, time_created, data) VALUES (?, ?, ?, ?, ?)')
  for (const m of messages) {
    mStmt.run(m.id, m.session_id, m.time_created, JSON.stringify(m.data))
    for (const p of m.parts) pStmt.run(p.id, m.id, m.session_id, p.time_created, JSON.stringify(p.data))
  }
  db.close()
  return dbPath
}

let tmpDir: string

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-db-test-'))
})
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('decodeOpencodeDb', () => {
  it('decodes a user prompt + assistant text turn', () => {
    const dbPath = writeDb(
      'simple.db',
      [{ id: 'ses_1', time_updated: 1000 }],
      [
        {
          id: 'msg_u',
          session_id: 'ses_1',
          time_created: 100,
          data: { role: 'user' },
          parts: [{ id: 'prt_u', time_created: 100, data: { type: 'text', text: 'What is the tech stack?' } }],
        },
        {
          id: 'msg_a',
          session_id: 'ses_1',
          time_created: 200,
          data: { role: 'assistant' },
          parts: [
            { id: 'prt_a0', time_created: 200, data: { type: 'step-start' } },
            { id: 'prt_a1', time_created: 201, data: { type: 'text', text: 'Next.js + React.' } },
            { id: 'prt_a2', time_created: 202, data: { type: 'step-finish', reason: 'stop', tokens: { total: 5 }, cost: 0 } },
          ],
        },
      ],
    )
    const msgs = decodeOpencodeDb(dbPath)
    expect(msgs).toHaveLength(2)
    expect(msgs[0].type).toBe('user')
    expect(msgs[0].message.content[0].text).toBe('What is the tech stack?')
    expect(msgs[0].uuid).toBe('opencode-db-msg_u')
    expect(msgs[0].timestamp).toBe(new Date(100).toISOString())
    // step-start/step-finish are skipped — only the text part survives.
    expect(msgs[1].type).toBe('assistant')
    expect(msgs[1].message.content[0].text).toBe('Next.js + React.')
  })

  it('folds tool parts into the turn as ↳ lines with an input summary', () => {
    const dbPath = writeDb(
      'tools.db',
      [{ id: 'ses_t', time_updated: 1000 }],
      [
        {
          id: 'msg_t',
          session_id: 'ses_t',
          time_created: 100,
          data: { role: 'assistant' },
          parts: [
            { id: 'p0', time_created: 100, data: { type: 'step-start' } },
            { id: 'p1', time_created: 101, data: { type: 'tool', tool: 'bash', callID: 'bash_1', state: { status: 'completed', input: { command: 'ls -la', description: 'list' }, output: '...' } } },
            { id: 'p2', time_created: 102, data: { type: 'tool', tool: 'read', callID: 'read_1', state: { status: 'completed', input: { filePath: '/tmp/x/README.md' }, output: '...' } } },
            { id: 'p3', time_created: 103, data: { type: 'tool', tool: 'edit', callID: 'edit_1', state: { status: 'completed', input: { filePath: '/tmp/x/calc.py', oldString: 'a', newString: 'b' } } } },
            { id: 'p4', time_created: 104, data: { type: 'text', text: 'The magic number is 4271.' } },
          ],
        },
      ],
    )
    const msgs = decodeOpencodeDb(dbPath)
    expect(msgs).toHaveLength(1)
    const text = msgs[0].message.content[0].text
    expect(text).toContain('↳ bash: ls -la')
    expect(text).toContain('↳ read: /tmp/x/README.md')
    expect(text).toContain('↳ edit: /tmp/x/calc.py')
    expect(text).toContain('The magic number is 4271.')
    // ordering: tools appear before the trailing prose
    expect(text.indexOf('↳ bash')).toBeLessThan(text.indexOf('The magic number'))
  })

  it('renders a tool with no summarizable input as a bare ↳ <tool> line', () => {
    const dbPath = writeDb(
      'tool-bare.db',
      [{ id: 'ses_b', time_updated: 1000 }],
      [
        {
          id: 'msg_b',
          session_id: 'ses_b',
          time_created: 100,
          data: { role: 'assistant' },
          parts: [{ id: 'p1', time_created: 100, data: { type: 'tool', tool: 'todowrite', callID: 'c1', state: { status: 'completed', input: {} } } }],
        },
      ],
    )
    const msgs = decodeOpencodeDb(dbPath)
    expect(msgs[0].message.content[0].text).toBe('↳ todowrite')
  })

  it('selects the NEWEST session by time_updated (one db, many sessions)', () => {
    const dbPath = writeDb(
      'multi.db',
      [
        { id: 'ses_old', time_updated: 100 },
        { id: 'ses_new', time_updated: 999 },
      ],
      [
        {
          id: 'm_old',
          session_id: 'ses_old',
          time_created: 50,
          data: { role: 'user' },
          parts: [{ id: 'po', time_created: 50, data: { type: 'text', text: 'OLD conversation' } }],
        },
        {
          id: 'm_new',
          session_id: 'ses_new',
          time_created: 500,
          data: { role: 'user' },
          parts: [{ id: 'pn', time_created: 500, data: { type: 'text', text: 'NEW conversation' } }],
        },
      ],
    )
    const msgs = decodeOpencodeDb(dbPath)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].message.content[0].text).toBe('NEW conversation')
  })

  it('skips empty turns (a message with only step boundaries, no text/tool)', () => {
    const dbPath = writeDb(
      'empty-turn.db',
      [{ id: 'ses_e', time_updated: 1000 }],
      [
        {
          id: 'm_empty',
          session_id: 'ses_e',
          time_created: 100,
          data: { role: 'assistant' },
          parts: [
            { id: 'p0', time_created: 100, data: { type: 'step-start' } },
            { id: 'p1', time_created: 101, data: { type: 'step-finish', reason: 'stop' } },
          ],
        },
        {
          id: 'm_real',
          session_id: 'ses_e',
          time_created: 200,
          data: { role: 'assistant' },
          parts: [{ id: 'p2', time_created: 200, data: { type: 'text', text: 'hello' } }],
        },
      ],
    )
    const msgs = decodeOpencodeDb(dbPath)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].message.content[0].text).toBe('hello')
  })

  it('ignores messages with an unknown role', () => {
    const dbPath = writeDb(
      'role.db',
      [{ id: 'ses_r', time_updated: 1000 }],
      [
        {
          id: 'm_sys',
          session_id: 'ses_r',
          time_created: 100,
          data: { role: 'system' },
          parts: [{ id: 'p', time_created: 100, data: { type: 'text', text: 'system noise' } }],
        },
        {
          id: 'm_user',
          session_id: 'ses_r',
          time_created: 200,
          data: { role: 'user' },
          parts: [{ id: 'p2', time_created: 200, data: { type: 'text', text: 'real prompt' } }],
        },
      ],
    )
    const msgs = decodeOpencodeDb(dbPath)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].message.content[0].text).toBe('real prompt')
  })

  it('returns [] for a missing db (never throws)', () => {
    expect(decodeOpencodeDb(path.join(tmpDir, 'does-not-exist.db'))).toEqual([])
  })

  it('returns [] for a garbage (non-sqlite) db (never throws)', () => {
    const junk = path.join(tmpDir, 'junk.db')
    fs.writeFileSync(junk, 'this is not a sqlite database')
    expect(decodeOpencodeDb(junk)).toEqual([])
  })

  it('returns [] for a db with no sessions', () => {
    const dbPath = writeDb('nosessions.db', [], [])
    expect(decodeOpencodeDb(dbPath)).toEqual([])
  })
})

describe('decodeNewestOpencodeSession (session-id for rollover detection)', () => {
  it('returns the newest session id alongside its messages', () => {
    const dbPath = writeDb(
      'sid.db',
      [
        { id: 'ses_old', time_updated: 100 },
        { id: 'ses_new', time_updated: 999 },
      ],
      [
        {
          id: 'm_old',
          session_id: 'ses_old',
          time_created: 50,
          data: { role: 'user' },
          parts: [{ id: 'po', time_created: 50, data: { type: 'text', text: 'old' } }],
        },
        {
          id: 'm_new',
          session_id: 'ses_new',
          time_created: 500,
          data: { role: 'user' },
          parts: [{ id: 'pn', time_created: 500, data: { type: 'text', text: 'new' } }],
        },
      ],
    )
    const res = decodeNewestOpencodeSession(dbPath)
    expect(res).not.toBeNull()
    expect(res!.sessionId).toBe('ses_new') // newest by time_updated — the rollover anchor
    expect(res!.messages).toHaveLength(1)
    expect(res!.messages[0].message.content[0].text).toBe('new')
  })

  it('returns null for a db with no sessions (caller skips broadcast)', () => {
    const dbPath = writeDb('sid-empty.db', [], [])
    expect(decodeNewestOpencodeSession(dbPath)).toBeNull()
  })

  it('loadNewestOpencodeConversation surfaces the session id for the watcher baseline', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-sid-'))
    const dbPath = path.join(dataDir, OPENCODE_DB_FILENAME)
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER NOT NULL);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    `)
    db.prepare('INSERT INTO session VALUES (?, ?)').run('ses_abc', 10)
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m1', 'ses_abc', 1, JSON.stringify({ role: 'user' }))
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p1', 'm1', 'ses_abc', 1, JSON.stringify({ type: 'text', text: 'hi' }))
    db.close()
    const res = loadNewestOpencodeConversation(dataDir)
    expect(res?.sessionId).toBe('ses_abc')
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
})

describe('findOpencodeDb / loadNewestOpencodeConversation', () => {
  it('finds opencode.db inside a data dir', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-datadir-'))
    const dbPath = path.join(dataDir, OPENCODE_DB_FILENAME)
    new Database(dbPath).close()
    const found = findOpencodeDb(dataDir)
    expect(found?.path).toBe(dbPath)
    expect(found?.mtime).toBeInstanceOf(Date)
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('returns null when the data dir has no opencode.db', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-empty-'))
    expect(findOpencodeDb(dataDir)).toBeNull()
    expect(loadNewestOpencodeConversation(dataDir)).toBeNull()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('loadNewestOpencodeConversation returns decoded messages for a populated data dir', () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-pop-'))
    const dbPath = path.join(dataDir, OPENCODE_DB_FILENAME)
    const db = new Database(dbPath)
    db.exec(`
      CREATE TABLE session (id TEXT PRIMARY KEY, time_updated INTEGER NOT NULL);
      CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
      CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT NOT NULL, session_id TEXT NOT NULL, time_created INTEGER NOT NULL, data TEXT NOT NULL);
    `)
    db.prepare('INSERT INTO session VALUES (?, ?)').run('s1', 10)
    db.prepare('INSERT INTO message VALUES (?, ?, ?, ?)').run('m1', 's1', 1, JSON.stringify({ role: 'user' }))
    db.prepare('INSERT INTO part VALUES (?, ?, ?, ?, ?)').run('p1', 'm1', 's1', 1, JSON.stringify({ type: 'text', text: 'hi' }))
    db.close()
    const res = loadNewestOpencodeConversation(dataDir)
    expect(res).not.toBeNull()
    expect(res!.path).toBe(dbPath)
    expect(res!.messages).toHaveLength(1)
    expect(res!.messages[0].message.content[0].text).toBe('hi')
    fs.rmSync(dataDir, { recursive: true, force: true })
  })
})
