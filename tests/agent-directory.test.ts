/**
 * Agent Directory — agentId-keying + cross-host collision tests (#42)
 *
 * The old directory was a name-keyed map, so two agents sharing a session name
 * on different hosts (e.g. milo-dock "Antonia" and holmes "Watson", both
 * `dev-aimaestro-holmes`) silently shadowed each other. These tests pin the fix:
 * entries keyed by agentId (composite hostId:name fallback), name-lookup with
 * host disambiguation, and a backward-compat dual-read migration of an existing
 * name-keyed file (KAI's "validate fresh AND populated" caveat).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'

vi.mock('fs')
vi.mock('@/lib/hosts-config', () => ({
  getSelfHostId: vi.fn(() => 'holmes'),
  getPeerHosts: vi.fn(() => []),
}))
vi.mock('@/lib/agent-registry', () => ({
  loadAgents: vi.fn(() => []),
  normalizeHostId: vi.fn((h: string) => (h || '').toLowerCase()),
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

const watson = { agentId: 'uuid-watson', name: 'dev-aimaestro-holmes', hostId: 'holmes', ampRegistered: true }
const antonia = { agentId: 'uuid-antonia', name: 'dev-aimaestro-holmes', hostId: 'milo-dock', ampRegistered: true }

describe('cross-host name collision (#42 — the headline fix)', () => {
  it('two same-named agents on different hosts BOTH coexist (no shadowing)', async () => {
    const dir = await import('@/lib/agent-directory')
    expect(dir.registerRemoteAgent(watson)).toBe(true)
    expect(dir.registerRemoteAgent(antonia)).toBe(true)
    const all = dir.getAllDirectoryEntries()
    expect(all).toHaveLength(2)                                  // old name-keyed map would hold ONE
    expect(dir.lookupAgentsByName('dev-aimaestro-holmes')).toHaveLength(2)
  })

  it('lookupAgent is null on ambiguity, resolves with hostId', async () => {
    const dir = await import('@/lib/agent-directory')
    dir.registerRemoteAgent(watson)
    dir.registerRemoteAgent(antonia)
    expect(dir.lookupAgent('dev-aimaestro-holmes')).toBeNull()                       // ambiguous → surfaced, not shadowed
    expect(dir.lookupAgent('dev-aimaestro-holmes', 'holmes')?.agentId).toBe('uuid-watson')
    expect(dir.lookupAgent('dev-aimaestro-holmes', 'milo-dock')?.agentId).toBe('uuid-antonia')
  })

  it('lookupAgentById resolves each distinct agent', async () => {
    const dir = await import('@/lib/agent-directory')
    dir.registerRemoteAgent(watson)
    dir.registerRemoteAgent(antonia)
    expect(dir.lookupAgentById('uuid-watson')?.hostId).toBe('holmes')
    expect(dir.lookupAgentById('uuid-antonia')?.hostId).toBe('milo-dock')
  })

  it('entries are keyed by agentId on disk', async () => {
    const dir = await import('@/lib/agent-directory')
    dir.registerRemoteAgent(watson)
    expect(Object.keys(readFile().entries)).toEqual(['uuid-watson'])
  })

  it('unregisterAgent(name, hostId) removes only that host’s entry', async () => {
    const dir = await import('@/lib/agent-directory')
    dir.registerRemoteAgent(watson)
    dir.registerRemoteAgent(antonia)
    expect(dir.unregisterAgent('dev-aimaestro-holmes', 'holmes')).toBe(true)
    expect(dir.lookupAgentById('uuid-watson')).toBeNull()
    expect(dir.lookupAgentById('uuid-antonia')?.hostId).toBe('milo-dock')           // sibling survives
  })
})

describe('backward-compat migration of an existing (populated) name-keyed file (#42)', () => {
  it('re-keys an OLD name-keyed file to agentId on load (dual-read)', async () => {
    // Old shape: map keyed by NAME.
    seedFile({ version: 5, lastSync: 'x', entries: { 'dev-aimaestro-holmes': { ...watson, source: 'remote', lastSeen: 'x' } } })
    const dir = await import('@/lib/agent-directory')
    // Adding the colliding sibling now SUCCEEDS (old map would have overwritten).
    expect(dir.registerRemoteAgent(antonia)).toBe(true)
    expect(dir.getAllDirectoryEntries()).toHaveLength(2)
    expect(Object.keys(readFile().entries).sort()).toEqual(['uuid-antonia', 'uuid-watson'])
  })

  it('composite hostId:name fallback for legacy entries with no agentId', async () => {
    seedFile({ version: 1, lastSync: 'x', entries: { 'legacy-agent': { name: 'legacy-agent', hostId: 'oldbox', ampRegistered: false, source: 'remote', lastSeen: 'x' } } })
    const dir = await import('@/lib/agent-directory')
    dir.registerRemoteAgent(watson)  // force a load+save cycle
    expect(Object.keys(readFile().entries).sort()).toEqual(['oldbox:legacy-agent', 'uuid-watson'])
    expect(dir.lookupAgent('legacy-agent', 'oldbox')?.hostId).toBe('oldbox')
  })

  it('is idempotent on an already agentId-keyed file', async () => {
    seedFile({ version: 9, lastSync: 'x', entries: { 'uuid-watson': { ...watson, source: 'remote', lastSeen: 'x' } } })
    const dir = await import('@/lib/agent-directory')
    expect(dir.lookupAgentById('uuid-watson')?.hostId).toBe('holmes')
    expect(dir.getAllDirectoryEntries()).toHaveLength(1)
  })
})

describe('fresh rebuildLocalDirectory keys local agents by agentId (#42)', () => {
  it('keys a fresh local agent by its UUID', async () => {
    const reg = await import('@/lib/agent-registry')
    vi.mocked(reg.loadAgents).mockReturnValue([
      { id: 'uuid-watson', name: 'dev-aimaestro-holmes', hostId: 'holmes', ampRegistered: true } as any,
    ])
    const dir = await import('@/lib/agent-directory')
    dir.rebuildLocalDirectory()
    expect(Object.keys(readFile().entries)).toEqual(['uuid-watson'])
    expect(dir.lookupAgentById('uuid-watson')?.source).toBe('local')
  })
})
