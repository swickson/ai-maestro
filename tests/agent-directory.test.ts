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
vi.mock('@/lib/hosts-config', () => ({
  getSelfHostId: vi.fn(() => 'prod'),
  getPeerHosts: vi.fn(() => []),
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
function seedFile(obj: unknown) { mockFs[DIRECTORY_FILE] = JSON.stringify(obj) }
function readFile(): any { return JSON.parse(mockFs[DIRECTORY_FILE]) }

beforeEach(() => {
  vi.resetModules()
  mockFs = {}
  vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => p.toString() in mockFs || p.toString().endsWith('.aimaestro'))
  vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
    const c = mockFs[p.toString()]
    if (c === undefined) throw new Error(`ENOENT: ${p}`)
    return c
  })
  vi.mocked(fs.writeFileSync).mockImplementation((p: fs.PathOrFileDescriptor, data: any) => { mockFs[p.toString()] = String(data) })
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
