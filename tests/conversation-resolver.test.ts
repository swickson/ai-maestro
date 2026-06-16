import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { selectTranscriptFile, resolveActiveTranscript } from '@/lib/conversation-resolver'

const STUB = JSON.stringify({ type: 'ai-title', aiTitle: 'Set up agent messaging' }) + '\n'
const REAL =
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'hello' }, timestamp: '2026-06-13T10:00:00Z' }) + '\n' +
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: 'hi' }, timestamp: '2026-06-13T10:00:01Z' }) + '\n'

let dir: string
function write(name: string, content: string, mtimeMs: number) {
  const p = path.join(dir, name)
  fs.writeFileSync(p, content)
  fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs))
  return p
}

beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'convres-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

describe('selectTranscriptFile', () => {
  it('returns empty for a null or non-existent dir', () => {
    expect(selectTranscriptFile(null)).toMatchObject({ path: null, exists: false, pending: false })
    expect(selectTranscriptFile('/no/such/dir')).toMatchObject({ exists: false })
  })

  it('returns empty when the dir has no .jsonl files', () => {
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'x')
    expect(selectTranscriptFile(dir)).toMatchObject({ path: null, exists: false })
  })

  it('THE BUG: picks the real transcript over a NEWER title-only stub', () => {
    write('real.jsonl', REAL, 1_000_000)          // older
    write('stub.jsonl', STUB, 2_000_000)          // newer, but a 117-byte stub
    const r = selectTranscriptFile(dir)
    expect(r.exists).toBe(true)
    expect(path.basename(r.path!)).toBe('real.jsonl')   // NOT the newer stub
  })

  it('picks the newest among multiple real transcripts', () => {
    write('old.jsonl', REAL, 1_000_000)
    write('new.jsonl', REAL, 3_000_000)
    expect(path.basename(selectTranscriptFile(dir).path!)).toBe('new.jsonl')
  })

  it('falls back to newest when every file is a stub (better than nothing)', () => {
    write('s1.jsonl', STUB, 1_000_000)
    write('s2.jsonl', STUB, 2_000_000)
    expect(path.basename(selectTranscriptFile(dir).path!)).toBe('s2.jsonl')
  })

  it('trusts a large file without content-reading it (size > stub threshold)', () => {
    // 5KB of tool-result-only lines (no user/assistant) — but big, so trusted.
    const big = (JSON.stringify({ type: 'user', toolUseResult: { x: 'y'.repeat(200) } }) + '\n').repeat(30)
    expect(big.length).toBeGreaterThan(4096)
    write('big.jsonl', big, 1_000_000)
    expect(path.basename(selectTranscriptFile(dir).path!)).toBe('big.jsonl')
  })

  it('does NOT mis-flag a small non-Claude file (gemini/codex-shaped) as a stub', () => {
    // Valid JSON, parses fine, but type is not user/assistant and not a title.
    const gemini = JSON.stringify({ type: 'message', role: 'model', text: 'hi' }) + '\n'
    expect(gemini.length).toBeLessThan(4096)
    write('stub.jsonl', STUB, 2_000_000)            // newer title-only stub
    write('gemini.jsonl', gemini, 1_000_000)        // older, small, real non-Claude
    expect(path.basename(selectTranscriptFile(dir).path!)).toBe('gemini.jsonl')
  })

  it('antigravity (#219): picks history.jsonl and IGNORES the .pb/.db conversation blobs', () => {
    // Mirrors the real antigravity-app-data ROOT layout: only history.jsonl is
    // .jsonl; conversations are protobuf/sqlite blobs the scanner must skip.
    const history = JSON.stringify({ display: 'hello agent', timestamp: 1779482879705, workspace: '/workspace' }) + '\n'
    write('history.jsonl', history, 2_000_000)
    write('57d9416c.pb', 'binary-protobuf-bytes', 3_000_000)   // newer, but NOT .jsonl
    write('57d9416c.db', 'sqlite-bytes', 3_500_000)            // newest, but NOT .jsonl
    fs.writeFileSync(path.join(dir, 'settings.json'), '{}')    // .json, not .jsonl
    const r = selectTranscriptFile(dir)
    expect(r.exists).toBe(true)
    expect(path.basename(r.path!)).toBe('history.jsonl')       // the only .jsonl wins
  })

  it('prefers the hook transcriptPath when it exists in the dir, over a newer file', () => {
    const hook = write('session-abc.jsonl', REAL, 1_000_000)   // older
    write('newer.jsonl', REAL, 5_000_000)                       // newer
    const r = selectTranscriptFile(dir, hook)
    expect(path.basename(r.path!)).toBe('session-abc.jsonl')
    expect(r.exists).toBe(true)
    expect(r.pending).toBe(false)
  })

  it('reports pending when the hook transcriptPath is known but not on disk (child session / deferred)', () => {
    write('stub.jsonl', STUB, 9_000_000)   // a stale stub is present...
    const phantom = path.join(dir, 'never-written.jsonl')
    const r = selectTranscriptFile(dir, phantom)
    expect(r.pending).toBe(true)
    expect(r.exists).toBe(false)
    expect(r.path).toBe(phantom)           // ...but we do NOT fall back to the stub
  })

  it('ignores a hook transcriptPath outside the resolved dir (falls back to scan)', () => {
    write('real.jsonl', REAL, 1_000_000)
    const r = selectTranscriptFile(dir, '/some/other/project/x.jsonl')
    expect(path.basename(r.path!)).toBe('real.jsonl')
    expect(r.pending).toBe(false)
  })

  // #159: Codex nests rollouts under sessions/YYYY/MM/DD/; the flat scan misses
  // them, the recursive scan finds them. Default stays flat for other runtimes.
  function writeNested(rel: string, content: string, mtimeMs: number) {
    const p = path.join(dir, rel)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.writeFileSync(p, content)
    fs.utimesSync(p, new Date(mtimeMs), new Date(mtimeMs))
    return p
  }

  it('does NOT find nested transcripts with the default (flat) scan', () => {
    writeNested('2026/06/15/rollout-a.jsonl', REAL, 1_000_000)
    expect(selectTranscriptFile(dir)).toMatchObject({ path: null, exists: false })
  })

  it('finds a nested transcript when recursive is enabled (Codex sessions/YYYY/MM/DD/)', () => {
    const p = writeNested('2026/06/15/rollout-a.jsonl', REAL, 1_000_000)
    const r = selectTranscriptFile(dir, null, { recursive: true })
    expect(r.exists).toBe(true)
    expect(r.path).toBe(p)
  })

  it('picks the newest nested rollout across date subdirs (recursive)', () => {
    writeNested('2026/06/14/rollout-old.jsonl', REAL, 1_000_000)
    const newer = writeNested('2026/06/15/rollout-new.jsonl', REAL, 3_000_000)
    const r = selectTranscriptFile(dir, null, { recursive: true })
    expect(r.path).toBe(newer)
    expect(path.basename(r.path!)).toBe('rollout-new.jsonl')
  })
})

describe('resolveActiveTranscript (host-agent wrapper)', () => {
  let home: string
  beforeEach(() => { home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-')) })
  afterEach(() => { fs.rmSync(home, { recursive: true, force: true }) })

  it('resolves a host agent to its newest substantive transcript', () => {
    const workingDirectory = '/Users/x/proj'
    const encoded = workingDirectory.replace(/[/.]/g, '-')   // matches agent-paths hostProjectDirName
    const projDir = path.join(home, '.claude', 'projects', encoded)
    fs.mkdirSync(projDir, { recursive: true })
    fs.writeFileSync(path.join(projDir, 'stub.jsonl'), STUB)
    fs.utimesSync(path.join(projDir, 'stub.jsonl'), new Date(2_000_000), new Date(2_000_000))
    fs.writeFileSync(path.join(projDir, 'real.jsonl'), REAL)
    fs.utimesSync(path.join(projDir, 'real.jsonl'), new Date(1_000_000), new Date(1_000_000))

    const agent = { id: 'a1', workingDirectory } as any
    const r = resolveActiveTranscript(agent, home)
    expect(r.exists).toBe(true)
    expect(path.basename(r.path!)).toBe('real.jsonl')
  })

  it('resolves a cloud Codex agent to its newest NESTED rollout (#159)', () => {
    const agentId = 'codex-agent-1'
    // Mirrors resolveConversationDir cloud-codex: <home>/.aimaestro/agents/<id>/codex-app-data/sessions
    const sessions = path.join(home, '.aimaestro', 'agents', agentId, 'codex-app-data', 'sessions')
    const oldDir = path.join(sessions, '2026', '06', '14')
    const newDir = path.join(sessions, '2026', '06', '15')
    fs.mkdirSync(oldDir, { recursive: true })
    fs.mkdirSync(newDir, { recursive: true })
    fs.writeFileSync(path.join(oldDir, 'rollout-old.jsonl'), REAL)
    fs.utimesSync(path.join(oldDir, 'rollout-old.jsonl'), new Date(1_000_000), new Date(1_000_000))
    fs.writeFileSync(path.join(newDir, 'rollout-new.jsonl'), REAL)
    fs.utimesSync(path.join(newDir, 'rollout-new.jsonl'), new Date(3_000_000), new Date(3_000_000))

    const agent = { id: agentId, program: 'codex', deployment: { type: 'cloud' } } as any
    const r = resolveActiveTranscript(agent, home)
    expect(r.exists).toBe(true)
    expect(path.basename(r.path!)).toBe('rollout-new.jsonl')
  })
})
