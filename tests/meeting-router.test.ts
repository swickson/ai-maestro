import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// Mocks
// ============================================================================

let meetingsStore: Record<string, any> = {}

vi.mock('@/lib/meeting-registry', () => ({
  getMeeting: vi.fn((id: string) => meetingsStore[id] || null),
  updateMeeting: vi.fn((id: string, updates: any) => {
    if (meetingsStore[id]) {
      meetingsStore[id] = { ...meetingsStore[id], ...updates }
    }
  }),
}))

vi.mock('@/lib/agent-registry', () => ({
  getAgent: vi.fn((id: string) => {
    const agents: Record<string, any> = {
      'agent-1': { id: 'agent-1', name: 'dev-backend', label: 'BackendBot' },
      'agent-2': { id: 'agent-2', name: 'dev-frontend', label: 'FrontendBot' },
      'agent-3': { id: 'agent-3', name: 'ops-reviewer', label: 'ReviewBot' },
    }
    return agents[id] || null
  }),
  getAgentByName: vi.fn((name: string) => {
    const byName: Record<string, any> = {
      'dev-backend': { id: 'agent-1', name: 'dev-backend', label: 'BackendBot' },
      'dev-frontend': { id: 'agent-2', name: 'dev-frontend', label: 'FrontendBot' },
      'ops-reviewer': { id: 'agent-3', name: 'ops-reviewer', label: 'ReviewBot' },
      'backendbot': { id: 'agent-1', name: 'dev-backend', label: 'BackendBot' },
      'frontendbot': { id: 'agent-2', name: 'dev-frontend', label: 'FrontendBot' },
    }
    return byName[name] || null
  }),
  loadAgents: vi.fn(() => [
    { id: 'agent-1', name: 'dev-backend', label: 'BackendBot' },
    { id: 'agent-2', name: 'dev-frontend', label: 'FrontendBot' },
    { id: 'agent-3', name: 'ops-reviewer', label: 'ReviewBot' },
  ]),
}))

// ============================================================================
// Import module under test (after mocks)
// ============================================================================

import {
  parseMentions,
  routeMessage,
  resetLoopGuard,
  getLoopGuardStatus,
} from '@/lib/meeting-router'

// ============================================================================
// Helpers
// ============================================================================

function createMeeting(overrides: Record<string, any> = {}) {
  return {
    id: 'meeting-1',
    teamId: 'team-1',
    agentIds: ['agent-1', 'agent-2', 'agent-3'],
    startedAt: new Date().toISOString(),
    loopGuardConfig: { maxHops: 6, enabled: true },
    loopGuardState: { hopCount: 0, paused: false, lastResetAt: new Date().toISOString() },
    ...overrides,
  }
}

function humanCtx(text: string, meetingId = 'meeting-1'): any {
  return { meetingId, senderId: 'maestro', senderName: 'Shane', isHuman: true, messageText: text }
}

function agentCtx(agentId: string, text: string, meetingId = 'meeting-1'): any {
  return { meetingId, senderId: agentId, senderName: `agent-${agentId}`, isHuman: false, messageText: text }
}

// ============================================================================
// Tests
// ============================================================================

describe('parseMentions', () => {
  it('parses single @mention', () => {
    const result = parseMentions('Hey @dev-backend check this')
    expect(result.mentionedNames).toEqual(['dev-backend'])
    expect(result.isAll).toBe(false)
    expect(result.isContinue).toBe(false)
    expect(result.cleanedText).toBe('Hey check this')
  })

  it('parses multiple @mentions', () => {
    const result = parseMentions('@dev-backend @dev-frontend review the PR')
    expect(result.mentionedNames).toEqual(['dev-backend', 'dev-frontend'])
    expect(result.isAll).toBe(false)
    expect(result.cleanedText).toBe('review the PR')
  })

  it('parses @all', () => {
    const result = parseMentions('@all standup time')
    expect(result.isAll).toBe(true)
    expect(result.mentionedNames).toEqual([])
    expect(result.cleanedText).toBe('standup time')
  })

  it('parses /continue command', () => {
    const result = parseMentions('/continue')
    expect(result.isContinue).toBe(true)
  })

  it('/continue with trailing text', () => {
    const result = parseMentions('/continue keep going')
    expect(result.isContinue).toBe(true)
  })

  it('returns original text when no mentions to strip', () => {
    const result = parseMentions('just a plain message')
    expect(result.mentionedNames).toEqual([])
    expect(result.isAll).toBe(false)
    expect(result.cleanedText).toBe('just a plain message')
  })

  it('lowercases mention names', () => {
    const result = parseMentions('@Dev-Backend hello')
    expect(result.mentionedNames).toEqual(['dev-backend'])
  })

  it('handles agent names with dots and underscores', () => {
    const result = parseMentions('@agent.v2 @my_bot check')
    expect(result.mentionedNames).toEqual(['agent.v2', 'my_bot'])
  })

  it('handles @all mixed with named mentions', () => {
    const result = parseMentions('@all @dev-backend focus on this')
    expect(result.isAll).toBe(true)
    expect(result.mentionedNames).toEqual(['dev-backend'])
  })
})

describe('routeMessage — human messages', () => {
  beforeEach(() => {
    meetingsStore = { 'meeting-1': createMeeting() }
  })

  it('human message with @mention targets that agent', () => {
    const result = routeMessage(humanCtx('@dev-backend check the API'))
    expect(result.blocked).toBe(false)
    expect(result.targetAgentIds).toContain('agent-1')
    expect(result.hopCount).toBe(0)
  })

  it('human message with @all targets all agents', () => {
    const result = routeMessage(humanCtx('@all standup time'))
    expect(result.blocked).toBe(false)
    expect(result.targetAgentIds).toHaveLength(3)
    expect(result.targetAgentIds).toContain('agent-1')
    expect(result.targetAgentIds).toContain('agent-2')
    expect(result.targetAgentIds).toContain('agent-3')
  })

  it('human message without @mention triggers nobody', () => {
    const result = routeMessage(humanCtx('just thinking out loud'))
    expect(result.blocked).toBe(false)
    expect(result.targetAgentIds).toHaveLength(0)
  })

  it('human message resets loop guard', () => {
    // Set up a meeting with high hop count
    meetingsStore['meeting-1'] = createMeeting({
      loopGuardState: { hopCount: 5, paused: false, lastResetAt: '' },
    })
    routeMessage(humanCtx('@dev-backend hey'))
    const status = getLoopGuardStatus('meeting-1')
    expect(status?.hopCount).toBe(0)
    expect(status?.paused).toBe(false)
  })

  it('human message always passes even when guard is paused', () => {
    meetingsStore['meeting-1'] = createMeeting({
      loopGuardState: { hopCount: 6, paused: true, lastResetAt: '' },
    })
    const result = routeMessage(humanCtx('@all resume work'))
    expect(result.blocked).toBe(false)
    expect(result.targetAgentIds).toHaveLength(3)
  })
})

describe('routeMessage — agent messages', () => {
  beforeEach(() => {
    meetingsStore = { 'meeting-1': createMeeting() }
  })

  it('agent message with @mention targets that agent', () => {
    const result = routeMessage(agentCtx('agent-1', '@dev-frontend check my changes'))
    expect(result.blocked).toBe(false)
    expect(result.targetAgentIds).toContain('agent-2')
    expect(result.hopCount).toBe(1)
  })

  it('agent message excludes sender from targets', () => {
    const result = routeMessage(agentCtx('agent-1', '@all everyone check this'))
    expect(result.targetAgentIds).not.toContain('agent-1')
    expect(result.targetAgentIds).toContain('agent-2')
    expect(result.targetAgentIds).toContain('agent-3')
  })

  it('agent message increments hop counter', () => {
    routeMessage(agentCtx('agent-1', '@dev-frontend first'))
    const status1 = getLoopGuardStatus('meeting-1')
    expect(status1?.hopCount).toBe(1)

    routeMessage(agentCtx('agent-2', '@dev-backend reply'))
    const status2 = getLoopGuardStatus('meeting-1')
    expect(status2?.hopCount).toBe(2)
  })

  it('agent message without @mention triggers nobody', () => {
    const result = routeMessage(agentCtx('agent-1', 'just noting something'))
    expect(result.targetAgentIds).toHaveLength(0)
  })
})

describe('loop guard', () => {
  beforeEach(() => {
    meetingsStore = { 'meeting-1': createMeeting({ loopGuardConfig: { maxHops: 3, enabled: true } }) }
  })

  it('blocks agent messages after max hops', () => {
    routeMessage(agentCtx('agent-1', '@dev-frontend hop 1'))
    routeMessage(agentCtx('agent-2', '@ops-reviewer hop 2'))
    const result = routeMessage(agentCtx('agent-3', '@dev-backend hop 3'))
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('Loop guard')
    expect(result.hopCount).toBe(3)
  })

  it('stays blocked until human or /continue', () => {
    // Trip the guard
    routeMessage(agentCtx('agent-1', '@dev-frontend hop 1'))
    routeMessage(agentCtx('agent-2', '@ops-reviewer hop 2'))
    routeMessage(agentCtx('agent-3', '@dev-backend hop 3'))

    // Subsequent agent messages are blocked
    const blocked = routeMessage(agentCtx('agent-1', '@all try again'))
    expect(blocked.blocked).toBe(true)
  })

  it('/continue resets the guard', () => {
    // Trip the guard
    routeMessage(agentCtx('agent-1', '@dev-frontend hop 1'))
    routeMessage(agentCtx('agent-2', '@ops-reviewer hop 2'))
    routeMessage(agentCtx('agent-3', '@dev-backend hop 3'))

    // /continue resets
    const continueResult = routeMessage(humanCtx('/continue'))
    expect(continueResult.blocked).toBe(false)
    expect(continueResult.hopCount).toBe(0)

    // Agents can post again
    const afterContinue = routeMessage(agentCtx('agent-1', '@dev-frontend resumed'))
    expect(afterContinue.blocked).toBe(false)
  })

  it('human message resets hop counter mid-chain', () => {
    routeMessage(agentCtx('agent-1', '@dev-frontend hop 1'))
    routeMessage(agentCtx('agent-2', '@ops-reviewer hop 2'))

    // Human interjects
    routeMessage(humanCtx('@all new direction'))

    // Counter reset — agents get 3 more hops
    const afterHuman = routeMessage(agentCtx('agent-1', '@dev-frontend fresh start'))
    expect(afterHuman.hopCount).toBe(1)
    expect(afterHuman.blocked).toBe(false)
  })

  it('getLoopGuardStatus returns correct state', () => {
    const status = getLoopGuardStatus('meeting-1')
    expect(status).not.toBeNull()
    expect(status?.hopCount).toBe(0)
    expect(status?.maxHops).toBe(3)
    expect(status?.paused).toBe(false)
  })

  it('getLoopGuardStatus returns null for unknown meeting', () => {
    expect(getLoopGuardStatus('nonexistent')).toBeNull()
  })
})

describe('routeMessage — edge cases', () => {
  beforeEach(() => {
    meetingsStore = { 'meeting-1': createMeeting() }
  })

  it('returns blocked for unknown meeting', () => {
    const result = routeMessage({ meetingId: 'bad-id', senderId: 'maestro', senderName: 'Shane', isHuman: true, messageText: 'hello' })
    expect(result.blocked).toBe(true)
    expect(result.reason).toContain('not found')
  })

  it('@mention for agent not in meeting is ignored', () => {
    const result = routeMessage(humanCtx('@some-other-agent hello'))
    expect(result.targetAgentIds).toHaveLength(0)
  })

  it('resetLoopGuard returns null for unknown meeting', () => {
    expect(resetLoopGuard('nonexistent')).toBeNull()
  })

  it('agent self-mention is excluded from targets', () => {
    const result = routeMessage(agentCtx('agent-1', '@dev-backend I updated my code'))
    expect(result.targetAgentIds).not.toContain('agent-1')
  })
})
