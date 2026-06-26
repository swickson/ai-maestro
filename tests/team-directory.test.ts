/**
 * Team Directory — the cross-host taskSummary merge point (Mission Control P2b).
 *
 * getAllTeams() is where local and remote teams meet: LOCAL teams must get a
 * read-time-fresh task rollup, while REMOTE teams must keep the summary that
 * rode the sync from their owning host (a remote host can't read peer task
 * files, so recomputing them would zero out their counts). This is the exact
 * #280-analog clobber risk flagged in review — the isolated computeTeamTaskSummary
 * tests don't pin the merge point, so a future "simplify getAllTeams" that maps
 * the rollup over ALL teams would silently wipe remote task state. These tests
 * guard that boundary.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Team } from '@/types/team'
import type { TeamTaskSummary } from '@/types/team'

// Local teams come from team-registry; getAllTeams + syncTeamsWithPeers both read it.
const mockLoadTeams = vi.fn<[], Team[]>(() => [])
vi.mock('@/lib/team-registry', () => ({
  loadTeams: () => mockLoadTeams(),
  getLocalTeamsForSync: vi.fn(() => []),
}))

// The fresh local rollup — a sentinel so we can tell it apart from a synced one.
const FRESH: TeamTaskSummary = {
  counts: { backlog: 1, pending: 0, in_progress: 2, needs_input: 0, review: 0, completed: 0 },
  total: 3,
  needsYouCount: 0,
}
vi.mock('@/lib/task-registry', () => ({
  computeTeamTaskSummary: vi.fn(() => FRESH),
}))

vi.mock('@/lib/hosts-config', () => ({
  getPeerHosts: vi.fn(() => [{ id: 'peer-1', url: 'http://peer-1' }]),
}))

function team(id: string, overrides: Partial<Team> = {}): Team {
  return {
    id,
    name: `team-${id}`,
    agentIds: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  }
}

// A remote team as it arrives over the sync: already carrying its OWN summary
// (computed on its home host), distinct from the local FRESH sentinel.
const REMOTE_SYNCED: TeamTaskSummary = {
  counts: { backlog: 0, pending: 4, in_progress: 0, needs_input: 1, review: 0, completed: 9 },
  total: 14,
  needsYouCount: 1,
}

beforeEach(() => {
  vi.resetModules()
  mockLoadTeams.mockReset()
})
afterEach(() => vi.restoreAllMocks())

describe('getAllTeams — local-fresh / remote-preserved task rollup', () => {
  it('attaches a freshly-computed summary to LOCAL teams', async () => {
    mockLoadTeams.mockReturnValue([team('local-1')])
    const dir = await import('@/lib/team-directory')

    const all = dir.getAllTeams()
    const local = all.find(t => t.id === 'local-1')
    expect(local?.source).toBe('local')
    expect(local?.taskSummary).toEqual(FRESH)
  })

  it('PRESERVES the synced summary on REMOTE teams — never recomputes it (the #280-analog clobber guard)', async () => {
    mockLoadTeams.mockReturnValue([team('local-1')])

    // Sync pulls a remote team that already carries REMOTE_SYNCED.
    const fetchMock = vi.fn(async () => ({
      ok: true,
      json: async () => ({ teams: [team('remote-1', { hostId: 'peer-1', taskSummary: REMOTE_SYNCED })] }),
    }))
    vi.stubGlobal('fetch', fetchMock)

    const dir = await import('@/lib/team-directory')
    await dir.syncTeamsWithPeers()

    const all = dir.getAllTeams()
    const remote = all.find(t => t.id === 'remote-1')
    const local = all.find(t => t.id === 'local-1')

    // Remote keeps the summary that rode the sync — NOT the local FRESH sentinel.
    expect(remote?.source).toBe('remote')
    expect(remote?.taskSummary).toEqual(REMOTE_SYNCED)
    expect(remote?.taskSummary).not.toEqual(FRESH)
    // Local still gets the fresh rollup in the same call — the two paths don't cross.
    expect(local?.taskSummary).toEqual(FRESH)
  })
})
