/**
 * Agent Directory — agentId-keying + cross-host collision tests (#42)
 *
 * The old directory was a name-keyed map, so two agents sharing a session name
 * on different hosts (e.g. the laptop "agentB" and the prod host "agentA",
 * both `dev-team-dup`) silently shadowed each other. These tests pin the fix:
 * entries keyed by agentId (composite hostId:name fallback), name-lookup with
 * host disambiguation, and a backward-compat dual-read migration of an existing
 * name-keyed file (the lead's "validate fresh AND populated" caveat).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { readHookState } from '@/lib/inject-readiness'
import { loadAgents } from '@/lib/agent-registry'

vi.mock('fs')
// isSelf() is drift-aware in real life (hostname/IP/alias-cache). selfAliases lets a
// test simulate this machine being recognized under multiple names — including a
// DRIFTED hostname (the stored hostId no longer === the runtime hostname).
let selfAliases = new Set<string>(['prod'])
vi.mock('@/lib/hosts-config', () => ({
  getSelfHostId: vi.fn(() => 'prod'),
  getPeerHosts: vi.fn(() => []),
  isSelf: vi.fn((hostId: string) => selfAliases.has((hostId || '').toLowerCase())),
}))
vi.mock('@/lib/agent-registry', () => ({
  loadAgents: vi.fn(() => []),
  normalizeHostId: vi.fn((h: string) => (h || '').toLowerCase()),
}))
vi.mock('@/lib/inject-readiness', () => ({
  readHookState: vi.fn(() => null),
  isBlockingPrompt: vi.fn((s: any) => s?.status === 'waiting_for_input' || s?.status === 'permission_request' || s?.status === 'question_prompt'),
  HOOK_BUSY_STALE_MS: 5 * 60_000,
}))

const DIRECTORY_FILE = path.join(os.homedir(), '.aimaestro', 'agent-directory.json')

let mockFs: Record<string, string>
let mockMtimes: Record<string, number>   // path → mtimeMs, drives loadDirectory's mtime-invalidation
function seedFile(obj: unknown) { mockFs[DIRECTORY_FILE] = JSON.stringify(obj); mockMtimes[DIRECTORY_FILE] = Date.now() }
function readFile(): any { return JSON.parse(mockFs[DIRECTORY_FILE]) }

beforeEach(() => {
  vi.resetModules()
  selfAliases = new Set<string>(['prod'])
  mockFs = {}
  mockMtimes = {}
  vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => p.toString() in mockFs || p.toString().endsWith('.aimaestro'))
  vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
    const c = mockFs[p.toString()]
    if (c === undefined) throw new Error(`ENOENT: ${p}`)
    return c
  })
  vi.mocked(fs.writeFileSync).mockImplementation((p: fs.PathOrFileDescriptor, data: any) => {
    mockFs[p.toString()] = String(data)
    mockMtimes[p.toString()] = Date.now()   // a write bumps the file's mtime, like a real fs
  })
  // mtime defaults to 0 (older than any cacheTimestamp) for unwritten paths, so
  // tests that don't exercise mtime keep the prior cache semantics.
  vi.mocked(fs.statSync).mockImplementation(((p: fs.PathLike) => ({ mtimeMs: mockMtimes[p.toString()] ?? 0 })) as any)
  vi.mocked(fs.mkdirSync).mockImplementation(() => undefined as any)
})
afterEach(() => vi.restoreAllMocks())

const agentA = { agentId: 'uuid-peer', name: 'dev-team-dup', hostId: 'prod', ampRegistered: true }
const agentB = { agentId: 'uuid-agent', name: 'dev-team-dup', hostId: 'laptop', ampRegistered: true }

describe('cross-host name collision (#42 — the headline fix)', () => {
  it('two same-named agents on different hosts BOTH coexist (no shadowing)', async () => {
    const dir = await import('@/lib/agent-directory')
    expect(dir.registerRemoteAgent(agentA)).toBe(true)
    expect(dir.registerRemoteAgent(agentB)).toBe(true)
    const all = dir.getAllDirectoryEntries()
    expect(all).toHaveLength(2)                                  // old name-keyed map would hold ONE
    expect(dir.lookupAgentsByName('dev-team-dup')).toHaveLength(2)
  })

  it('lookupAgent is null on ambiguity, resolves with hostId', async () => {
    const dir = await import('@/lib/agent-directory')
    dir.registerRemoteAgent(agentA)
    dir.registerRemoteAgent(agentB)
    expect(dir.lookupAgent('dev-team-dup')).toBeNull()                       // ambiguous → surfaced, not shadowed
    expect(dir.lookupAgent('dev-team-dup', 'prod')?.agentId).toBe('uuid-peer')
    expect(dir.lookupAgent('dev-team-dup', 'laptop')?.agentId).toBe('uuid-agent')
  })

  it('lookupAgentById resolves each distinct agent', async () => {
    const dir = await import('@/lib/agent-directory')
    dir.registerRemoteAgent(agentA)
    dir.registerRemoteAgent(agentB)
    expect(dir.lookupAgentById('uuid-peer')?.hostId).toBe('prod')
    expect(dir.lookupAgentById('uuid-agent')?.hostId).toBe('laptop')
  })

  it('entries are keyed by agentId on disk', async () => {
    const dir = await import('@/lib/agent-directory')
    dir.registerRemoteAgent(agentA)
    expect(Object.keys(readFile().entries)).toEqual(['uuid-peer'])
  })

  it('unregisterAgent(name, hostId) removes only that host’s entry', async () => {
    const dir = await import('@/lib/agent-directory')
    dir.registerRemoteAgent(agentA)
    dir.registerRemoteAgent(agentB)
    expect(dir.unregisterAgent('dev-team-dup', 'prod')).toBe(true)
    expect(dir.lookupAgentById('uuid-peer')).toBeNull()
    expect(dir.lookupAgentById('uuid-agent')?.hostId).toBe('laptop')           // sibling survives
  })
})

describe('backward-compat migration of an existing (populated) name-keyed file (#42)', () => {
  it('re-keys an OLD name-keyed file to agentId on load (dual-read)', async () => {
    // Old shape: map keyed by NAME.
    seedFile({ version: 5, lastSync: 'x', entries: { 'dev-team-dup': { ...agentA, source: 'remote', lastSeen: 'x' } } })
    const dir = await import('@/lib/agent-directory')
    // Adding the colliding sibling now SUCCEEDS (old map would have overwritten).
    expect(dir.registerRemoteAgent(agentB)).toBe(true)
    expect(dir.getAllDirectoryEntries()).toHaveLength(2)
    expect(Object.keys(readFile().entries).sort()).toEqual(['uuid-agent', 'uuid-peer'])
  })

  it('composite hostId:name fallback for legacy entries with no agentId', async () => {
    seedFile({ version: 1, lastSync: 'x', entries: { 'legacy-agent': { name: 'legacy-agent', hostId: 'oldbox', ampRegistered: false, source: 'remote', lastSeen: 'x' } } })
    const dir = await import('@/lib/agent-directory')
    dir.registerRemoteAgent(agentA)  // force a load+save cycle
    expect(Object.keys(readFile().entries).sort()).toEqual(['oldbox:legacy-agent', 'uuid-peer'])
    expect(dir.lookupAgent('legacy-agent', 'oldbox')?.hostId).toBe('oldbox')
  })

  it('is idempotent on an already agentId-keyed file', async () => {
    seedFile({ version: 9, lastSync: 'x', entries: { 'uuid-peer': { ...agentA, source: 'remote', lastSeen: 'x' } } })
    const dir = await import('@/lib/agent-directory')
    expect(dir.lookupAgentById('uuid-peer')?.hostId).toBe('prod')
    expect(dir.getAllDirectoryEntries()).toHaveLength(1)
  })
})

describe('fresh rebuildLocalDirectory keys local agents by agentId (#42)', () => {
  it('keys a fresh local agent by its UUID', async () => {
    const reg = await import('@/lib/agent-registry')
    vi.mocked(reg.loadAgents).mockReturnValue([
      { id: 'uuid-peer', name: 'dev-team-dup', hostId: 'prod', ampRegistered: true } as any,
    ])
    const dir = await import('@/lib/agent-directory')
    dir.rebuildLocalDirectory()
    expect(Object.keys(readFile().entries)).toEqual(['uuid-peer'])
    expect(dir.lookupAgentById('uuid-peer')?.source).toBe('local')
  })
})

describe('runtime activity (P2 — who is idle / working / stuck)', () => {
  const NOW = 1_000_000_000_000

  it('waiting when a blocking prompt is pending (the NEEDS-YOU signal)', async () => {
    vi.mocked(readHookState).mockReturnValue({ status: 'permission_request', updatedAt: new Date(NOW).toISOString() } as any)
    const dir = await import('@/lib/agent-directory')
    const a = dir.computeAgentActivity('/work/dir', NOW)
    expect(a.state).toBe('waiting')
    expect(a.observedStuck).toBe(false)
  })

  it('active when the hook is busy and fresh', async () => {
    vi.mocked(readHookState).mockReturnValue({ status: 'busy', updatedAt: new Date(NOW - 60_000).toISOString() } as any)
    const dir = await import('@/lib/agent-directory')
    expect(dir.computeAgentActivity('/work/dir', NOW).state).toBe('active')
  })

  it('stuck + observedStuck when the hook says busy but is stale > 5min (token-timer stalled)', async () => {
    vi.mocked(readHookState).mockReturnValue({ status: 'busy', updatedAt: new Date(NOW - 6 * 60_000).toISOString() } as any)
    const dir = await import('@/lib/agent-directory')
    const a = dir.computeAgentActivity('/work/dir', NOW)
    expect(a.state).toBe('stuck')
    expect(a.observedStuck).toBe(true)
  })

  it('idle when the hook is null / dormant', async () => {
    vi.mocked(readHookState).mockReturnValue(null)
    const dir = await import('@/lib/agent-directory')
    expect(dir.computeAgentActivity('/work/dir', NOW).state).toBe('idle')
  })

  it('getLocalEntriesForSync attaches activity to local entries (workingDir resolved from the registry)', async () => {
    seedFile({ version: 5, lastSync: 'x', entries: {
      'uuid-local': { agentId: 'uuid-local', name: 'dev-local', hostId: 'prod', ampRegistered: true, lastSeen: 'x', source: 'local' },
    } })
    vi.mocked(loadAgents).mockReturnValue([{ id: 'uuid-local', name: 'dev-local', hostId: 'prod', workingDirectory: '/work/dir' }] as any)
    vi.mocked(readHookState).mockReturnValue({ status: 'busy', updatedAt: new Date(Date.now() - 1000).toISOString() } as any)
    const dir = await import('@/lib/agent-directory')
    const entries = dir.getLocalEntriesForSync()
    expect(entries).toHaveLength(1)
    expect(entries[0].activity?.state).toBe('active')
  })
})

describe('getAllDirectoryEntries activity enrichment (local fresh, remote synced-as-is)', () => {
  it('enriches local entries but preserves remote entries synced activity', async () => {
    seedFile({ version: 5, lastSync: 'x', entries: {
      'uuid-local': { agentId: 'uuid-local', name: 'dev-local', hostId: 'prod', ampRegistered: true, lastSeen: 'x', source: 'local' },
      'uuid-remote': { agentId: 'uuid-remote', name: 'dev-remote', hostId: 'laptop', ampRegistered: true, lastSeen: 'x', source: 'remote',
        activity: { state: 'stuck', observedStuck: true, lastActivityAt: 'x' } },
    } })
    vi.mocked(loadAgents).mockReturnValue([{ id: 'uuid-local', name: 'dev-local', hostId: 'prod', workingDirectory: '/w' }] as any)
    vi.mocked(readHookState).mockReturnValue(null)  // local → idle
    const dir = await import('@/lib/agent-directory')
    const all = dir.getAllDirectoryEntries()
    const local = all.find(e => e.agentId === 'uuid-local')
    const remote = all.find(e => e.agentId === 'uuid-remote')
    expect(local?.activity?.state).toBe('idle')                  // computed fresh on this host
    expect(remote?.activity?.state).toBe('stuck')                // synced value untouched
    expect(remote?.activity?.observedStuck).toBe(true)
  })
})

describe('syncWithPeers carries remote activity through the pull-sync (Columbo #279 fix)', () => {
  it('stores activity from a peer local entry onto the stored remote entry', async () => {
    const hosts = await import('@/lib/hosts-config')
    vi.mocked(hosts.getPeerHosts).mockReturnValue([{ id: 'laptop', url: 'http://laptop:23000' } as any])
    const peerEntry = {
      agentId: 'uuid-remote', name: 'dev-remote', hostId: 'laptop', ampRegistered: true,
      source: 'local', lastSeen: 'x',
      activity: { state: 'stuck', observedStuck: true, lastActivityAt: 'x' },
    }
    global.fetch = vi.fn(async () => ({ ok: true, json: async () => ({ entries: [peerEntry] }) })) as any
    const dir = await import('@/lib/agent-directory')
    await dir.syncWithPeers()
    const stored = dir.lookupAgentById('uuid-remote')
    expect(stored?.source).toBe('remote')
    expect(stored?.activity?.state).toBe('stuck')        // dropped (undefined) before the fix
    expect(stored?.activity?.observedStuck).toBe(true)
  })
})

describe('loadDirectory cache freshness (P2b — mtime invalidation)', () => {
  const localEntry = (id: string, name: string) =>
    ({ agentId: id, name, hostId: 'prod', source: 'local', lastSeen: 'x' })
  const remoteWithActivity = (id: string, name: string) =>
    ({ agentId: id, name, hostId: 'laptop', source: 'remote', lastSeen: 'x',
       activity: { state: 'active', observedStuck: false, lastActivityAt: 'x' } })
  const dirOf = (...entries: any[]) =>
    ({ version: 1, lastSync: 'x', entries: Object.fromEntries(entries.map(e => [e.agentId, e])) })

  it('re-reads when the on-disk file is newer than the cache (cross-instance write)', async () => {
    seedFile(dirOf(localEntry('a', 'alpha')))
    const dir = await import('@/lib/agent-directory')
    expect(dir.getAllDirectoryEntries().map(e => e.agentId)).toEqual(['a'])   // caches v1

    // another module instance (the sync writer) writes a newer file out-of-band
    mockFs[DIRECTORY_FILE] = JSON.stringify(dirOf(localEntry('b', 'bravo')))
    mockMtimes[DIRECTORY_FILE] = Date.now() + 1_000_000

    // a pure time-cache would still return ['a']; the mtime check forces a re-read
    expect(dir.getAllDirectoryEntries().map(e => e.agentId)).toEqual(['b'])
  })

  it('does NOT clobber a writer fresh remote activity on a read (rebuild-on-read)', async () => {
    seedFile(dirOf(localEntry('a', 'alpha')))
    const dir = await import('@/lib/agent-directory')
    dir.getAllDirectoryEntries()                                              // caches the activity-less v1

    // the sync writer (another instance) lands a remote agent WITH activity
    mockFs[DIRECTORY_FILE] = JSON.stringify(dirOf(localEntry('a', 'alpha'), remoteWithActivity('r', 'remote')))
    mockMtimes[DIRECTORY_FILE] = Date.now() + 1_000_000

    // service getAllDirectory does this load-then-save on EVERY read
    dir.rebuildLocalDirectory()

    // the saved file must STILL carry the remote activity — a stale-cache save would have wiped it
    expect(readFile().entries.r?.activity?.state).toBe('active')
    // and the merged read surfaces it (two consecutive reads both fresh)
    expect(dir.getAllDirectoryEntries().find(e => e.agentId === 'r')?.activity?.state).toBe('active')
  })

  it('a writer own save does not self-invalidate its cache (cacheTimestamp set after write)', async () => {
    seedFile(dirOf(localEntry('a', 'alpha')))
    const dir = await import('@/lib/agent-directory')
    dir.getAllDirectoryEntries()                                              // initial load + cache
    dir.registerRemoteAgent({ agentId: 'r', name: 'remote', hostId: 'laptop', ampRegistered: true } as any)  // load(cache)+save
    const readsAfterWrite = vi.mocked(fs.readFileSync).mock.calls.length
    // mtime bumped by the save, but cacheTimestamp is stamped AFTER the write —
    // so a follow-up read serves cache, not a re-read of the file it just wrote.
    dir.getAllDirectoryEntries()
    expect(vi.mocked(fs.readFileSync).mock.calls.length).toBe(readsAfterWrite)
  })
})

// ============================================================================
// rebuildLocalDirectory — drift-aware self-detection (isSelf, not raw ===)
// Sibling of the getLocalTeamsForSync #284 fix (kanban 99608222). Three self-
// filters here (stale-GC match, stillExists, add-loop "only local") all moved
// from raw hostId=== to isSelf so a drifted runtime hostname can't drop this
// host's own agents from the directory (skip-add / fail-to-GC).
// ============================================================================

describe('rebuildLocalDirectory drift-aware self-detection (isSelf)', () => {
  it('adds local agents stored under a DRIFTED hostname that isSelf still recognizes', async () => {
    const DRIFTED = 'prod-docked'
    selfAliases.add(DRIFTED)            // this machine is now also known as prod-docked
    seedFile({ version: 9, lastSync: 'x', entries: {} })
    vi.mocked(loadAgents).mockReturnValue([
      { id: 'uuid-local', name: 'dev-local', hostId: DRIFTED, ampRegistered: true } as any,
    ])
    const dir = await import('@/lib/agent-directory')
    dir.rebuildLocalDirectory()
    // A raw `hostId === 'prod'` would have SKIPPED this agent (drift); isSelf keeps it.
    expect(Object.keys(readFile().entries)).toContain('uuid-local')
    expect(readFile().entries['uuid-local'].source).toBe('local')
  })

  it('does NOT GC a local entry under a drifted-self hostname when its agent still exists', async () => {
    const DRIFTED = 'prod-docked'
    selfAliases.add(DRIFTED)
    seedFile({ version: 9, lastSync: 'x', entries: {
      'uuid-local': { agentId: 'uuid-local', name: 'dev-local', hostId: DRIFTED, ampRegistered: true, source: 'local', lastSeen: 'x' },
    } })
    vi.mocked(loadAgents).mockReturnValue([
      { id: 'uuid-local', name: 'dev-local', hostId: DRIFTED, ampRegistered: true } as any,
    ])
    const dir = await import('@/lib/agent-directory')
    dir.rebuildLocalDirectory()
    // Under raw ===, the entry would be unrecognized-as-self (drift) and the
    // stillExists check would also miss → either left stale or mis-pruned. isSelf
    // recognizes it AND finds the agent → entry survives correctly.
    expect(Object.keys(readFile().entries)).toContain('uuid-local')
  })

  it('excludes agents owned by a genuinely different host', async () => {
    seedFile({ version: 9, lastSync: 'x', entries: {} })
    vi.mocked(loadAgents).mockReturnValue([
      { id: 'uuid-mine', name: 'mine', hostId: 'prod', ampRegistered: true } as any,
      { id: 'uuid-theirs', name: 'theirs', hostId: 'some-other-host', ampRegistered: true } as any,
    ])
    const dir = await import('@/lib/agent-directory')
    dir.rebuildLocalDirectory()
    const keys = Object.keys(readFile().entries)
    expect(keys).toContain('uuid-mine')
    expect(keys).not.toContain('uuid-theirs')   // isSelf('some-other-host') === false, no over-match
  })
})
