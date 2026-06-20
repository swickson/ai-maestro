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
  extractGenUsage,
  extractAntigravityUsage,
  usageIdentityRate,
  tsPlausibilityRate,
  toUsageContract,
} from '@/lib/antigravity-db-decoder'

// ── minimal protobuf wire encoder (mirrors the real on-disk shape) ───────────

function encodeVarint(n: number): Buffer {
  // BigInt-accumulated so values > 2^32 (e.g. a millisecond-scale timestamp)
  // encode faithfully — a `>>>= 7` / `& 0x7f` encoder silently coerces through
  // uint32 and would mis-encode the seconds-vs-ms drift fixture (PR-review-agent #238).
  const out: number[] = []
  let v = BigInt(n)
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  out.push(Number(v & 0x7fn))
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

function varintField(field: number, n: number): Buffer {
  return Buffer.concat([tag(field, 0), encodeVarint(n)])
}

// gen_metadata.data layout (token accounting):
//   .1.4.2 = input ; .1.4.3 = candidate (== .9 + .10) ; .1.4.9 = output ; .1.4.10 = thinking
//   .1.9.4.1 = per-gen unix-seconds timestamp ; .3.28 = model id ; .1.21 = model display name
// `candidate` defaults to output + thinking (the real on-disk invariant); pass an
// explicit value to simulate a format drift that breaks the additive identity.
// `tsSec` omitted ⇒ no .1.9.4.1 emitted (exercises the null-timestamp path).
function genMetadataPayload(opts: {
  input: number
  output: number
  thinking: number
  candidate?: number
  tsSec?: number
  modelId?: string
  modelDisplay?: string
}): Buffer {
  const { input, output, thinking, tsSec, modelId, modelDisplay } = opts
  const candidate = opts.candidate ?? output + thinking
  const usageInner = Buffer.concat([
    varintField(2, input),
    varintField(3, candidate),
    varintField(9, output),
    varintField(10, thinking),
  ])
  const field1Parts = [lenDelim(4, usageInner)]
  // .1.9.4.1 — nested .9 > .4 > .1 varint (per-gen timestamp)
  if (tsSec !== undefined) field1Parts.push(lenDelim(9, lenDelim(4, varintField(1, tsSec))))
  if (modelDisplay) field1Parts.push(strField(21, modelDisplay))
  const parts = [lenDelim(1, Buffer.concat(field1Parts))]
  if (modelId) parts.push(lenDelim(3, strField(28, modelId)))
  return Buffer.concat(parts)
}

function writeGenDb(name: string, gens: Buffer[]): string {
  const dbPath = path.join(tmpDir, name)
  const db = new Database(dbPath)
  db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB, size INTEGER)')
  const ins = db.prepare('INSERT INTO gen_metadata (idx, data, size) VALUES (?, ?, ?)')
  gens.forEach((g, i) => ins.run(i, g, g.length))
  db.close()
  return dbPath
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

  it('sees a WAL-only commit (no checkpoint) — read-through-WAL (PR-review-agent #233)', () => {
    // Regression for the WAL-blind watcher bug: a live commit lands in <db>-wal
    // and the main .db mtime does NOT move until checkpoint. The readonly decode
    // must still see it — which is exactly why the live watcher has to watch the
    // -wal sibling, not just the main .db mtime.
    const dbPath = path.join(tmpDir, 'wal.db')
    const w = new Database(dbPath)
    w.pragma('journal_mode = WAL')
    w.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, step_payload BLOB)')
    const ins = w.prepare('INSERT INTO steps (idx, step_type, step_payload) VALUES (?, ?, ?)')
    ins.run(0, 14, userPayload('first turn'))
    w.pragma('wal_checkpoint(TRUNCATE)') // flush to main .db, reset -wal to empty

    const mtimeBefore = fs.statSync(dbPath).mtimeMs
    ins.run(1, 15, assistantPayload('second turn lives only in the WAL')) // no checkpoint
    const mtimeAfter = fs.statSync(dbPath).mtimeMs

    // The commit is in -wal: main .db is untouched, but the -wal has grown.
    expect(mtimeAfter).toBe(mtimeBefore)
    expect(fs.statSync(`${dbPath}-wal`).size).toBeGreaterThan(0)

    // The readonly decode must still surface the WAL-only assistant turn.
    const msgs = decodeAntigravityDb(dbPath)
    expect(msgs).toHaveLength(2)
    expect(msgs[1].type).toBe('assistant')
    expect(msgs[1].message.content[0].text).toContain('second turn lives only in the WAL')
    w.close()
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

describe('extractGenUsage / extractAntigravityUsage — token accounting', () => {
  it('maps the gen_metadata token fields (.1.4.2/.9/.10) to input/output/thinking', () => {
    const usage = extractGenUsage(genMetadataPayload({ input: 21641, output: 195, thinking: 58, tsSec: 1780940507 }))
    expect(usage).not.toBeNull()
    expect(usage!.inputTokens).toBe(21641)
    expect(usage!.outputTokens).toBe(195)
    expect(usage!.thinkingTokens).toBe(58)
    // .1.4.3 candidate defaults to output + thinking — the on-disk invariant.
    expect(usage!.candidateTokens).toBe(195 + 58)
    // .1.9.4.1 per-gen unix-seconds timestamp.
    expect(usage!.tsSec).toBe(1780940507)
  })

  it('tsSec is null when .1.9.4.1 is absent (graceful, not 0)', () => {
    const usage = extractGenUsage(genMetadataPayload({ input: 100, output: 10, thinking: 5 }))
    expect(usage!.tsSec).toBeNull()
  })

  it('returns null for a blob with no input-token field', () => {
    // A non-usage protobuf (e.g. a string-only blob) must not masquerade as usage.
    expect(extractGenUsage(strField(1, 'just some text'))).toBeNull()
  })

  it('sums per-generation usage and reports output+thinking as output-billed', () => {
    const dbPath = writeGenDb('usage.db', [
      genMetadataPayload({ input: 21641, output: 195, thinking: 58, modelId: 'gemini-3.5-flash-low' }),
      genMetadataPayload({ input: 10128, output: 253, thinking: 68, modelId: 'gemini-3.5-flash-low' }),
      genMetadataPayload({ input: 2404, output: 95, thinking: 65, modelId: 'gemini-3.5-flash-low' }),
    ])
    const result = extractAntigravityUsage(dbPath)
    expect(result).not.toBeNull()
    expect(result!.model).toBe('gemini-3.5-flash-low')
    expect(result!.totals.generationCount).toBe(3)
    expect(result!.totals.inputTokens).toBe(21641 + 10128 + 2404)
    expect(result!.totals.outputTokens).toBe(195 + 253 + 95)
    expect(result!.totals.thinkingTokens).toBe(58 + 68 + 65)
    // Thinking bills at the output rate → output-billed = output + thinking.
    expect(result!.totals.outputBilledTokens).toBe(195 + 253 + 95 + 58 + 68 + 65)
  })

  it('falls back to the .1.21 display name when no .3.28 model id is present', () => {
    const dbPath = writeGenDb('model-fallback.db', [
      genMetadataPayload({ input: 100, output: 10, thinking: 5, modelDisplay: 'Gemini 3.5 Flash (Medium)' }),
    ])
    expect(extractAntigravityUsage(dbPath)!.model).toBe('Gemini 3.5 Flash (Medium)')
  })

  it('ADDITIVE-IDENTITY GUARD: identity holds 100% on well-formed data, fails loud on drift', () => {
    // The load-bearing RE invariant — candidate == output + thinking — is what
    // makes the (schema-less) field map trustworthy. usageIdentityRate lets a
    // caller assert on it so the NEXT antigravity format churn fails loud instead
    // of silently mis-counting spend.
    const good = [
      extractGenUsage(genMetadataPayload({ input: 500, output: 120, thinking: 30 }))!,
      extractGenUsage(genMetadataPayload({ input: 800, output: 1097, thinking: 3991 }))!,
    ]
    const goodRate = usageIdentityRate(good)
    expect(goodRate).toEqual({ checked: 2, ok: 2 })

    // Simulate a format change where .1.4.3 no longer equals output + thinking.
    const drifted = extractGenUsage(
      genMetadataPayload({ input: 500, output: 120, thinking: 30, candidate: 999 })
    )!
    const driftRate = usageIdentityRate([...good, drifted])
    expect(driftRate).toEqual({ checked: 3, ok: 2 }) // < 1.0 → caller fails loud
  })

  it('returns null for a .db without a gen_metadata table (graceful, not a throw)', () => {
    // A chat-only db (steps but no gen_metadata) must yield null, not crash.
    const dbPath = writeDb('chat-only.db', [{ step_type: 14, payload: userPayload('hi') }])
    expect(extractAntigravityUsage(dbPath)).toBeNull()
  })

  it('returns null for a missing or garbage db rather than throwing', () => {
    expect(extractAntigravityUsage(path.join(tmpDir, 'nope.db'))).toBeNull()
    const junk = path.join(tmpDir, 'usage-junk.db')
    fs.writeFileSync(junk, 'not a database')
    expect(extractAntigravityUsage(junk)).toBeNull()
  })

  it('toUsageContract projects onto the LOCKED cross-language wire shape', () => {
    // Locked 2026-06-16 with the lead + an agent — the exact JSON the Ziggy Python leg
    // consumes. Field names + structure must not drift without re-locking.
    const dbPath = writeGenDb('contract.db', [
      genMetadataPayload({ input: 21641, output: 195, thinking: 58, tsSec: 1780940507, modelId: 'gemini-3.5-flash-low' }),
      genMetadataPayload({ input: 10128, output: 253, thinking: 68, tsSec: 1780940999, modelId: 'gemini-3.5-flash-low' }),
    ])
    const contract = toUsageContract(extractAntigravityUsage(dbPath)!, dbPath)
    expect(contract).toEqual({
      sourcePath: dbPath,
      model: 'gemini-3.5-flash-low',
      gens: [
        { input: 21641, output: 195, thinking: 58, ts: 1780940507 },
        { input: 10128, output: 253, thinking: 68, ts: 1780940999 },
      ],
      totals: { input: 21641 + 10128, output: 195 + 253, thinking: 58 + 68 },
      identityRate: { checked: 2, ok: 2 },
      tsPlausibilityRate: { checked: 2, ok: 2 },
    })
    // The shape carries exactly these top-level keys — guards against silent additions.
    expect(Object.keys(contract).sort()).toEqual([
      'gens',
      'identityRate',
      'model',
      'sourcePath',
      'totals',
      'tsPlausibilityRate',
    ])
  })

  it('toUsageContract echoes sourcePath verbatim (no resolution) for collector attribution', () => {
    // Every record self-attributes via the raw path it was decoded from (incl. a
    // bind-mounted foreign-agent path) so the collector can DEDUP across hosts
    // (stable agent-uuid + conv-uuid suffix) and the DB can attribute per-agent —
    // NOT exclude. The wrapper must not normalize the path.
    const dbPath = writeGenDb('attrib.db', [genMetadataPayload({ input: 100, output: 10, thinking: 5 })])
    const foreignLikePath = '/home/peer/.aimaestro/agents/d22088ae-foreign/antigravity-app-data/conversations/x.db'
    expect(toUsageContract(extractAntigravityUsage(dbPath)!, foreignLikePath).sourcePath).toBe(foreignLikePath)
  })

  it('contract identityRate surfaces drift (ok < checked) so the collector can refuse spend', () => {
    const dbPath = writeGenDb('contract-drift.db', [
      genMetadataPayload({ input: 500, output: 120, thinking: 30 }), // identity holds
      genMetadataPayload({ input: 500, output: 120, thinking: 30, candidate: 999 }), // drift
    ])
    const contract = toUsageContract(extractAntigravityUsage(dbPath)!, dbPath)
    expect(contract.identityRate).toEqual({ checked: 2, ok: 1 })
  })

  it('tsPlausibilityRate fails loud on a seconds↔ms unit slip / .1.9.4.1 drift', () => {
    // ts MUST be unix SECONDS. A plausible in-range secs value passes; a ms-scale
    // value (what a unit slip or field-map drift would surface) is flagged, so a
    // daily-spend collector refuses per-day bucketing instead of mis-dating.
    const goodSec = 1780940507 // 2026-06-08 (seconds)
    const msSlip = 1780940507000 // same instant in MILLISECONDS → year ~58361, implausible
    const dbPath = writeGenDb('ts-drift.db', [
      genMetadataPayload({ input: 100, output: 10, thinking: 5, tsSec: goodSec }),
      genMetadataPayload({ input: 100, output: 10, thinking: 5, tsSec: msSlip }),
      genMetadataPayload({ input: 100, output: 10, thinking: 5 }), // null ts → not counted
    ])
    const gens = extractAntigravityUsage(dbPath)!.generations
    // The ms value must round-trip FAITHFULLY (not uint32-wrapped) so this proves
    // the guard catches a genuine seconds↔ms wire value, not a coincidentally
    // out-of-range wrapped one (PR-review-agent #238).
    expect(gens[0].tsSec).toBe(goodSec)
    expect(gens[1].tsSec).toBe(msSlip)
    expect(gens[2].tsSec).toBeNull()
    // 2 gens carry ts (sec + ms); only the seconds one is plausible.
    expect(tsPlausibilityRate(gens)).toEqual({ checked: 2, ok: 1 })
    // Travels in the contract so the Python collector can assert it.
    expect(toUsageContract(extractAntigravityUsage(dbPath)!, dbPath).tsPlausibilityRate).toEqual({
      checked: 2,
      ok: 1,
    })
  })
})
