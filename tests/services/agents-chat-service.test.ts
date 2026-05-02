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

const { mockRuntime, mockAgentRegistry, mockMeetingInjectQueue, mockContainerUtils } = vi.hoisted(() => {
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
      getAgentBySession: vi.fn(),
    },
    mockMeetingInjectQueue: {
      enqueueForSession: vi.fn(),
      shouldUseAdditionalContext: vi.fn().mockReturnValue(false),
      sanitizeForRawInject: vi.fn((s: string) => s),
      wrapAsBracketedPaste: vi.fn((s: string) => `\x1b[200~${s}\x1b[201~`),
    },
    mockContainerUtils: {
      sendKeysToContainer: vi.fn().mockResolvedValue(undefined),
      cancelCopyModeInContainer: vi.fn().mockResolvedValue(undefined),
    },
  }
})

vi.mock('@/lib/agent-runtime', () => ({
  getRuntime: vi.fn().mockReturnValue(mockRuntime),
}))
vi.mock('@/lib/agent-registry', () => mockAgentRegistry)
vi.mock('@/lib/meeting-inject-queue', () => mockMeetingInjectQueue)
vi.mock('@/lib/container-utils', () => mockContainerUtils)

// ============================================================================
// Import module under test (after mocks)
// ============================================================================

import { sendChatMessage, injectMeetingPrompt } from '@/services/agents-chat-service'

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

// ============================================================================
// injectMeetingPrompt — kanban cff76d5c (PR #94 follow-up)
//
// Pins the cancelCopyMode→sendKeys ordering invariant on each of the four
// notify-route branches:
//   1. hybrid host    — runtime.cancelCopyMode then runtime.sendKeys('.') + Enter
//   2. hybrid cloud   — cancelCopyModeInContainer then sendKeysToContainer('.') + Enter
//   3. legacy host    — runtime.cancelCopyMode then runtime.sendKeys(safeInjection) + Enter
//   4. legacy cloud   — cancelCopyModeInContainer then sendKeysToContainer(safeInjection) + Enter
//
// Symmetric to the sendChatMessage ordering pin above. Empirical e2e covers
// the regression today (Holmes/Rollie 2026-04-28); these are structural
// regression guards against future drift.
// ============================================================================

describe('injectMeetingPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockRuntime.sessionExists.mockResolvedValue(true)
    mockMeetingInjectQueue.shouldUseAdditionalContext.mockReturnValue(false)
    mockMeetingInjectQueue.sanitizeForRawInject.mockImplementation((s: string) => s)
    mockMeetingInjectQueue.wrapAsBracketedPaste.mockImplementation((s: string) => `[200~${s}[201~`)
  })

  describe('legacy host path', () => {
    beforeEach(() => {
      mockAgentRegistry.getAgentBySession.mockReturnValue({
        id: 'agent-uuid-1',
        name: 'test-agent',
        program: 'codex', // legacy path: shouldUseAdditionalContext=false
        deployment: { type: 'local' },
      })
    })

    it('calls cancelCopyMode before sendKeys (ordering pin)', async () => {
      const callOrder: string[] = []
      mockRuntime.cancelCopyMode.mockImplementation(async () => { callOrder.push('cancelCopyMode') })
      mockRuntime.sendKeys.mockImplementation(async () => { callOrder.push('sendKeys') })

      await injectMeetingPrompt({ agentName: 'test-agent', injection: 'hello world' })

      // First call must be cancelCopyMode; subsequent are sendKeys (text + Enter).
      expect(callOrder[0]).toBe('cancelCopyMode')
      expect(callOrder.slice(1).every(c => c === 'sendKeys')).toBe(true)
      expect(mockRuntime.cancelCopyMode).toHaveBeenCalledTimes(1)
      expect(mockRuntime.sendKeys).toHaveBeenCalledTimes(2)
      expect(mockContainerUtils.cancelCopyModeInContainer).not.toHaveBeenCalled()
      expect(mockContainerUtils.sendKeysToContainer).not.toHaveBeenCalled()
    })

    it('wraps payload as bracketed-paste before sendKeys', async () => {
      await injectMeetingPrompt({ agentName: 'test-agent', injection: 'hello world' })

      expect(mockMeetingInjectQueue.wrapAsBracketedPaste).toHaveBeenCalled()
      // First sendKeys carries the wrapped body; second sendKeys is the trailing Enter.
      expect(mockRuntime.sendKeys).toHaveBeenNthCalledWith(1, 'test-agent', '[200~hello world[201~', { literal: true, enter: false })
      expect(mockRuntime.sendKeys).toHaveBeenNthCalledWith(2, 'test-agent', '', { literal: false, enter: true })
    })
  })

  describe('legacy cloud path', () => {
    beforeEach(() => {
      mockAgentRegistry.getAgentBySession.mockReturnValue({
        id: 'cloud-1',
        name: 'cloud-agent',
        program: 'codex', // legacy path
        deployment: {
          type: 'cloud',
          cloud: { provider: 'local-container', containerName: 'aim-cloud-agent' },
        },
      })
    })

    it('calls cancelCopyModeInContainer before sendKeysToContainer (ordering pin)', async () => {
      const callOrder: string[] = []
      mockContainerUtils.cancelCopyModeInContainer.mockImplementation(async () => { callOrder.push('cancelCopyModeInContainer') })
      mockContainerUtils.sendKeysToContainer.mockImplementation(async () => { callOrder.push('sendKeysToContainer') })

      await injectMeetingPrompt({ agentName: 'cloud-agent', injection: 'hello cloud' })

      expect(callOrder[0]).toBe('cancelCopyModeInContainer')
      expect(callOrder.slice(1).every(c => c === 'sendKeysToContainer')).toBe(true)
      expect(mockContainerUtils.cancelCopyModeInContainer).toHaveBeenCalledTimes(1)
      expect(mockContainerUtils.sendKeysToContainer).toHaveBeenCalledTimes(2)
      // Host runtime untouched on cloud path.
      expect(mockRuntime.cancelCopyMode).not.toHaveBeenCalled()
      expect(mockRuntime.sendKeys).not.toHaveBeenCalled()
    })

    it('targets the agent containerName for both cancelCopyModeInContainer and sendKeysToContainer', async () => {
      await injectMeetingPrompt({ agentName: 'cloud-agent', injection: 'hello cloud' })

      expect(mockContainerUtils.cancelCopyModeInContainer).toHaveBeenCalledWith('aim-cloud-agent', 'cloud-agent')
      expect(mockContainerUtils.sendKeysToContainer).toHaveBeenNthCalledWith(1, 'aim-cloud-agent', 'cloud-agent', '[200~hello cloud[201~', { literal: true, enter: false })
      expect(mockContainerUtils.sendKeysToContainer).toHaveBeenNthCalledWith(2, 'aim-cloud-agent', 'cloud-agent', '', { literal: false, enter: true })
    })
  })

  describe('hybrid host path', () => {
    beforeEach(() => {
      mockMeetingInjectQueue.shouldUseAdditionalContext.mockReturnValue(true)
      mockAgentRegistry.getAgentBySession.mockReturnValue({
        id: 'agent-uuid-1',
        name: 'test-agent',
        program: 'claude-code', // hybrid path: shouldUseAdditionalContext=true
        deployment: { type: 'local' },
      })
    })

    it('calls cancelCopyMode before sendKeys (ordering pin) and enqueues for hook drain', async () => {
      const callOrder: string[] = []
      mockRuntime.cancelCopyMode.mockImplementation(async () => { callOrder.push('cancelCopyMode') })
      mockRuntime.sendKeys.mockImplementation(async () => { callOrder.push('sendKeys') })

      const result = await injectMeetingPrompt({ agentName: 'test-agent', injection: 'hybrid host msg' })

      expect(result.status).toBe(200)
      expect((result.data as any)?.queued).toBe(true)
      expect(mockMeetingInjectQueue.enqueueForSession).toHaveBeenCalledWith('test-agent', 'hybrid host msg')
      expect(callOrder[0]).toBe('cancelCopyMode')
      expect(callOrder.slice(1).every(c => c === 'sendKeys')).toBe(true)
      // Hybrid path uses '.' wake-ping (NOT bracketed-paste of the actual payload).
      expect(mockRuntime.sendKeys).toHaveBeenNthCalledWith(1, 'test-agent', '.', { literal: true, enter: false })
      expect(mockMeetingInjectQueue.wrapAsBracketedPaste).not.toHaveBeenCalled()
    })
  })

  describe('hybrid cloud path', () => {
    beforeEach(() => {
      mockMeetingInjectQueue.shouldUseAdditionalContext.mockReturnValue(true)
      mockAgentRegistry.getAgentBySession.mockReturnValue({
        id: 'cloud-1',
        name: 'cloud-agent',
        program: 'claude-code', // hybrid path
        deployment: {
          type: 'cloud',
          cloud: { provider: 'local-container', containerName: 'aim-cloud-agent' },
        },
      })
    })

    it('calls cancelCopyModeInContainer before sendKeysToContainer (ordering pin) and enqueues for hook drain', async () => {
      const callOrder: string[] = []
      mockContainerUtils.cancelCopyModeInContainer.mockImplementation(async () => { callOrder.push('cancelCopyModeInContainer') })
      mockContainerUtils.sendKeysToContainer.mockImplementation(async () => { callOrder.push('sendKeysToContainer') })

      const result = await injectMeetingPrompt({ agentName: 'cloud-agent', injection: 'hybrid cloud msg' })

      expect(result.status).toBe(200)
      expect((result.data as any)?.queued).toBe(true)
      expect(mockMeetingInjectQueue.enqueueForSession).toHaveBeenCalledWith('cloud-agent', 'hybrid cloud msg')
      expect(callOrder[0]).toBe('cancelCopyModeInContainer')
      expect(callOrder.slice(1).every(c => c === 'sendKeysToContainer')).toBe(true)
      expect(mockContainerUtils.sendKeysToContainer).toHaveBeenNthCalledWith(1, 'aim-cloud-agent', 'cloud-agent', '.', { literal: true, enter: false })
      // Host runtime untouched.
      expect(mockRuntime.cancelCopyMode).not.toHaveBeenCalled()
      expect(mockRuntime.sendKeys).not.toHaveBeenCalled()
    })
  })

  describe('error paths', () => {
    it('returns 400 when agentName is missing', async () => {
      const result = await injectMeetingPrompt({ injection: 'hello' })
      expect(result.status).toBe(400)
      expect(mockRuntime.cancelCopyMode).not.toHaveBeenCalled()
      expect(mockContainerUtils.cancelCopyModeInContainer).not.toHaveBeenCalled()
    })

    it('returns 400 when injection is missing', async () => {
      const result = await injectMeetingPrompt({ agentName: 'test-agent' })
      expect(result.status).toBe(400)
      expect(mockRuntime.cancelCopyMode).not.toHaveBeenCalled()
      expect(mockContainerUtils.cancelCopyModeInContainer).not.toHaveBeenCalled()
    })

    it('returns 404 for host agent when session does not exist', async () => {
      mockAgentRegistry.getAgentBySession.mockReturnValue({
        id: 'agent-uuid-1',
        name: 'test-agent',
        program: 'codex',
        deployment: { type: 'local' },
      })
      mockRuntime.sessionExists.mockResolvedValue(false)

      const result = await injectMeetingPrompt({ agentName: 'test-agent', injection: 'hello' })

      expect(result.status).toBe(404)
      expect(mockRuntime.cancelCopyMode).not.toHaveBeenCalled()
      expect(mockRuntime.sendKeys).not.toHaveBeenCalled()
    })

    it('returns 400 for cloud agent without containerName', async () => {
      mockAgentRegistry.getAgentBySession.mockReturnValue({
        id: 'cloud-1',
        name: 'cloud-agent',
        program: 'codex',
        deployment: { type: 'cloud', cloud: { provider: 'local-container' } },
      })

      const result = await injectMeetingPrompt({ agentName: 'cloud-agent', injection: 'hello' })

      expect(result.status).toBe(400)
      expect(mockContainerUtils.cancelCopyModeInContainer).not.toHaveBeenCalled()
      expect(mockContainerUtils.sendKeysToContainer).not.toHaveBeenCalled()
    })
  })
})
