/**
 * Antigravity-CLI conversation `.db` decoder (#232).
 *
 * antigravity-cli migrated conversation storage ~2026-06-10 from encrypted
 * `<uuid>.pb` files to SQLite `<uuid>.db` files whose `steps.step_payload`
 * BLOBs are PLAINTEXT protobuf — the full user+assistant+tool conversation is
 * decodable (superseding the earlier "assistant side = black box" call).
 *
 * These tests build SYNTHETIC protobuf step payloads + a temp SQLite db (no
 * real conversation content committed) and pin: the (step_type, field-path) →
 * role map, tool-step folding into the preceding assistant bubble, newest-db
 * selection, and graceful empty-result on a missing/garbage db.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import Database from 'better-sqlite3'
import {
  decodeAntigravityDb,
  findNewestAntigravityDb,
  loadNewestAntigravityConversation,
} from '@/lib/antigravity-db-decoder'

// ── minimal protobuf wire encoder (mirrors the real on-disk shape) ───────────

function encodeVarint(n: number): Buffer {
  const out: number[] = []
  while (n > 0x7f) {
    out.push((n & 0x7f) | 0x80)
    n >>>= 7
  }
  out.push(n & 0x7f)
  return Buffer.from(out)
}

function tag(field: number, wireType: number): Buffer {
  return encodeVarint((field << 3) | wireType)
}

/** Length-delimited field (wire type 2): used for both strings and sub-messages. */
function lenDelim(field: number, payload: Buffer): Buffer {
  return Buffer.concat([tag(field, 2), encodeVarint(payload.length), payload])
}

function strField(field: number, value: string): Buffer {
  return lenDelim(field, Buffer.from(value, 'utf8'))
}

// Build the payloads the decoder expects for each role:
//   user      step_type 14 → .19.2  = text
//   assistant step_type 15 → .20.1  = text ; .20.7.2 = tool name
//   tool      step_type 21 → .5.30  = label
function userPayload(text: string): Buffer {
  return lenDelim(19, strField(2, text))
}
function assistantPayload(text: string, toolName?: string): Buffer {
  const inner = [strField(1, text)]
  if (toolName) inner.push(lenDelim(7, strField(2, toolName)))
  return lenDelim(20, Buffer.concat(inner))
}
function toolPayload(label: string): Buffer {
  return lenDelim(5, strField(30, label))
}

// ── temp-db harness ──────────────────────────────────────────────────────────

let tmpDir: string

function writeDb(name: string, steps: Array<{ step_type: number; payload: Buffer }>): string {
  const dbPath = path.join(tmpDir, name)
  const db = new Database(dbPath)
  db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)')
  const ins = db.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)')
  steps.forEach((s, i) => ins.run(i, s.step_type, s.payload))
  db.close()
  return dbPath
}

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agy-db-test-'))
})
afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true })
})

describe('decodeAntigravityDb (#232)', () => {
  it('decodes a user + assistant exchange to Claude-shape messages', () => {
    const dbPath = writeDb('simple.db', [
      { step_type: 14, payload: userPayload('Summarize the repo') },
      { step_type: 15, payload: assistantPayload('Here is the summary of the repo.') },
    ])
    const msgs = decodeAntigravityDb(dbPath)
    expect(msgs).toHaveLength(2)
    expect(msgs[0].type).toBe('user')
    expect(msgs[0].message.content[0].text).toBe('Summarize the repo')
    expect(msgs[1].type).toBe('assistant')
    expect(msgs[1].message.content[0].text).toBe('Here is the summary of the repo.')
  })

  it('folds tool steps into the preceding assistant bubble', () => {
    const dbPath = writeDb('tools.db', [
      { step_type: 14, payload: userPayload('Check my inbox') },
      { step_type: 15, payload: assistantPayload('Let me check.', 'run_command') },
      { step_type: 21, payload: toolPayload('Checking AMP Inbox') },
    ])
    const msgs = decodeAntigravityDb(dbPath)
    expect(msgs).toHaveLength(2) // tool step folds, not a separate message
    expect(msgs[1].type).toBe('assistant')
    expect(msgs[1].message.content[0].text).toBe('Let me check.\n↳ Checking AMP Inbox')
  })

  it('renders a tool-only assistant step via the tool name', () => {
    const dbPath = writeDb('toolonly.db', [
      { step_type: 15, payload: assistantPayload('', 'view_file') },
    ])
    const msgs = decodeAntigravityDb(dbPath)
    expect(msgs).toHaveLength(1)
    expect(msgs[0].message.content[0].text).toBe('↳ view_file')
  })

  it('returns [] for a missing db rather than throwing', () => {
    expect(decodeAntigravityDb(path.join(tmpDir, 'does-not-exist.db'))).toEqual([])
  })

  it('returns [] for a non-sqlite (garbage) file rather than throwing', () => {
    const junk = path.join(tmpDir, 'junk.db')
    fs.writeFileSync(junk, 'not a database')
    expect(decodeAntigravityDb(junk)).toEqual([])
  })
})

describe('findNewestAntigravityDb / loadNewestAntigravityConversation (#232)', () => {
  it('selects the newest .db by mtime and ignores .pb files', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'conv-'))
    const older = path.join(dir, 'old.db')
    const newer = path.join(dir, 'new.db')
    const db1 = new Database(older); db1.exec('CREATE TABLE steps (idx INTEGER)'); db1.close()
    const db2 = new Database(newer); db2.exec('CREATE TABLE steps (idx INTEGER)'); db2.close()
    // Force a deterministic mtime ordering (old < new).
    fs.utimesSync(older, new Date('2026-06-10T00:00:00Z'), new Date('2026-06-10T00:00:00Z'))
    fs.utimesSync(newer, new Date('2026-06-15T00:00:00Z'), new Date('2026-06-15T00:00:00Z'))
    // An encrypted .pb sibling must be ignored.
    fs.writeFileSync(path.join(dir, 'ancient.pb'), Buffer.from([0x50, 0x3c, 0xad, 0xfb]))

    const found = findNewestAntigravityDb(dir)
    expect(found).not.toBeNull()
    expect(path.basename(found!.path)).toBe('new.db')
  })

  it('returns null when a conversations dir has no .db (only .pb / absent)', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'pbonly-'))
    fs.writeFileSync(path.join(dir, 'a.pb'), Buffer.from([0x00, 0x01]))
    expect(findNewestAntigravityDb(dir)).toBeNull()
    expect(loadNewestAntigravityConversation(dir)).toBeNull()
    expect(findNewestAntigravityDb(path.join(tmpDir, 'no-such-dir'))).toBeNull()
  })

  it('loadNewestAntigravityConversation returns decoded messages for the newest db', () => {
    const dir = fs.mkdtempSync(path.join(tmpDir, 'load-'))
    const db = new Database(path.join(dir, 'c.db'))
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)')
    db.prepare('INSERT INTO steps VALUES (?, ?, ?)').run(0, 14, userPayload('hi'))
    db.close()
    const result = loadNewestAntigravityConversation(dir)
    expect(result).not.toBeNull()
    expect(result!.messages).toHaveLength(1)
    expect(result!.messages[0].message.content[0].text).toBe('hi')
  })
})
