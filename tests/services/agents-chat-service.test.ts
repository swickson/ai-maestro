/**
 * Agents Chat Service Tests
 *
 * Pinning the cancelCopyMode prelude on the chat send-keys path.
 *
 * Background: kanban 96d317df / GH issue #70 — `services/agents-chat-service.ts`
 * `sendChatMessage` was the only one of three tmux-input callsites NOT calling
 * `runtime.cancelCopyMode` before `sendKeys`. When a recipient pane was in
 * copy-mode (e.g. operator scrolled with mouse-on tmux), `tmux send-keys -l`
 * hangs the calling request indefinitely AND drops the payload on copy-mode
 * exit. Verified empirically 2026-04-28 on Holmes/Rollie controlled repro.
 *
 * The other two callsites (wakeAgent, sendCommand) already had the prelude;
 * this test pins the third.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// Mocks — vi.hoisted ensures availability before vi.mock() runs
// ============================================================================

const { mockRuntime, mockAgentRegistry } = vi.hoisted(() => {
  const mockRuntime = {
    listSessions: vi.fn().mockResolvedValue([]),
    sessionExists: vi.fn().mockResolvedValue(true),
    createSession: vi.fn().mockResolvedValue(undefined),
    killSession: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    sendKeys: vi.fn().mockResolvedValue(undefined),
    cancelCopyMode: vi.fn().mockResolvedValue(undefined),
    setEnvironment: vi.fn().mockResolvedValue(undefined),
    unsetEnvironment: vi.fn().mockResolvedValue(undefined),
    isInCopyMode: vi.fn().mockResolvedValue(false),
    capturePane: vi.fn().mockResolvedValue(''),
  }

  return {
    mockRuntime,
    mockAgentRegistry: {
      getAgent: vi.fn(),
    },
  }
})

vi.mock('@/lib/agent-runtime', () => ({
  getRuntime: vi.fn().mockReturnValue(mockRuntime),
}))
vi.mock('@/lib/agent-registry', () => mockAgentRegistry)

// ============================================================================
// Import module under test (after mocks)
// ============================================================================

import { sendChatMessage } from '@/services/agents-chat-service'

describe('sendChatMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockAgentRegistry.getAgent.mockReturnValue({
      id: 'agent-uuid-1',
      name: 'test-agent',
      sessions: [{ status: 'online' }],
    })
  })

  it('cancels copy mode before sending keys', async () => {
    const result = await sendChatMessage('agent-uuid-1', 'hello world')

    expect(result.status).toBe(200)
    expect(mockRuntime.cancelCopyMode).toHaveBeenCalledWith('test-agent')
    expect(mockRuntime.sendKeys).toHaveBeenCalledWith('test-agent', 'hello world', { literal: true, enter: true })
  })

  it('calls cancelCopyMode before sendKeys (ordering pin)', async () => {
    // The bug was sendKeys without a cancelCopyMode prelude — pin the order.
    const callOrder: string[] = []
    mockRuntime.cancelCopyMode.mockImplementation(async () => {
      callOrder.push('cancelCopyMode')
    })
    mockRuntime.sendKeys.mockImplementation(async () => {
      callOrder.push('sendKeys')
    })

    await sendChatMessage('agent-uuid-1', 'test message')

    expect(callOrder).toEqual(['cancelCopyMode', 'sendKeys'])
  })

  it('returns 400 when message is empty', async () => {
    const result = await sendChatMessage('agent-uuid-1', '')
    expect(result.status).toBe(400)
    expect(mockRuntime.cancelCopyMode).not.toHaveBeenCalled()
    expect(mockRuntime.sendKeys).not.toHaveBeenCalled()
  })

  it('returns 404 when agent does not exist', async () => {
    mockAgentRegistry.getAgent.mockReturnValue(null)
    const result = await sendChatMessage('missing-agent', 'hello')
    expect(result.status).toBe(404)
    expect(mockRuntime.cancelCopyMode).not.toHaveBeenCalled()
    expect(mockRuntime.sendKeys).not.toHaveBeenCalled()
  })

  it('returns 400 when agent has no online session', async () => {
    mockAgentRegistry.getAgent.mockReturnValue({
      id: 'agent-uuid-1',
      name: 'test-agent',
      sessions: [{ status: 'offline' }],
    })
    const result = await sendChatMessage('agent-uuid-1', 'hello')
    expect(result.status).toBe(400)
    expect(mockRuntime.cancelCopyMode).not.toHaveBeenCalled()
    expect(mockRuntime.sendKeys).not.toHaveBeenCalled()
  })
})
