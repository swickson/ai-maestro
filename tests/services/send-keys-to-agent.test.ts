/**
 * sendKeysToAgent primitive tests
 *
 * Pins the deployment-aware dispatch — agent.deployment.type === 'cloud'
 * routes to docker-exec via container-utils; everything else routes to the
 * host tmux runtime. This is the centralized branch that 4 callsites
 * previously had to (re)derive (kanban 7a94534e closes 6f5562f4 + 6c3f4357
 * + Watson messages-service finding).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockRuntime, mockContainerUtils } = vi.hoisted(() => ({
  mockRuntime: {
    sendKeys: vi.fn().mockResolvedValue(undefined),
    cancelCopyMode: vi.fn().mockResolvedValue(undefined),
    sessionExists: vi.fn().mockResolvedValue(true),
  },
  mockContainerUtils: {
    sendKeysToContainer: vi.fn().mockResolvedValue(undefined),
    cancelCopyModeInContainer: vi.fn().mockResolvedValue(undefined),
  },
}))

vi.mock('@/lib/agent-runtime', () => ({
  getRuntime: vi.fn().mockReturnValue(mockRuntime),
}))
vi.mock('@/lib/container-utils', () => mockContainerUtils)

import { sendKeysToAgent, cancelCopyModeForAgent, agentSessionReady } from '@/services/send-keys-to-agent'

describe('sendKeysToAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('host agent: dispatches to runtime.sendKeys', async () => {
    const agent = { id: 'a', name: 'host-agent', deployment: { type: 'local' } } as any
    await sendKeysToAgent(agent, 'hello', { literal: true, enter: true })
    expect(mockRuntime.sendKeys).toHaveBeenCalledWith('host-agent', 'hello', { literal: true, enter: true })
    expect(mockContainerUtils.sendKeysToContainer).not.toHaveBeenCalled()
  })

  it('cloud agent with containerName: dispatches to sendKeysToContainer', async () => {
    const agent = {
      id: 'c',
      name: 'cloud-agent',
      deployment: { type: 'cloud', cloud: { containerName: 'aim-cloud-agent' } },
    } as any
    await sendKeysToAgent(agent, 'hi cloud', { literal: false, enter: true })
    expect(mockContainerUtils.sendKeysToContainer).toHaveBeenCalledWith(
      'aim-cloud-agent',
      'cloud-agent',
      'hi cloud',
      { literal: false, enter: true },
    )
    expect(mockRuntime.sendKeys).not.toHaveBeenCalled()
  })

  it('cloud agent missing containerName: falls back to host runtime (degenerate, surfaces upstream errors)', async () => {
    // Caller validation should reject this case BEFORE getting here; primitive
    // does not throw on its own. Documenting the fallback so future readers
    // know the primitive itself does not gate on containerName.
    const agent = {
      id: 'c',
      name: 'broken-cloud',
      deployment: { type: 'cloud', cloud: {} },
    } as any
    await sendKeysToAgent(agent, 'x', {})
    expect(mockRuntime.sendKeys).toHaveBeenCalledWith('broken-cloud', 'x', {})
    expect(mockContainerUtils.sendKeysToContainer).not.toHaveBeenCalled()
  })

  it('agent without name: throws (caller bug)', async () => {
    const agent = { id: 'broken', deployment: { type: 'local' } } as any
    await expect(sendKeysToAgent(agent, 'x', {})).rejects.toThrow(/no session name/)
  })

  it('uses alias when name is absent', async () => {
    const agent = { id: 'a', alias: 'aliased', deployment: { type: 'local' } } as any
    await sendKeysToAgent(agent, 'msg', {})
    expect(mockRuntime.sendKeys).toHaveBeenCalledWith('aliased', 'msg', {})
  })
})

describe('cancelCopyModeForAgent', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('host agent: dispatches to runtime.cancelCopyMode', async () => {
    const agent = { id: 'a', name: 'host-agent', deployment: { type: 'local' } } as any
    await cancelCopyModeForAgent(agent)
    expect(mockRuntime.cancelCopyMode).toHaveBeenCalledWith('host-agent')
    expect(mockContainerUtils.cancelCopyModeInContainer).not.toHaveBeenCalled()
  })

  it('cloud agent: dispatches to cancelCopyModeInContainer', async () => {
    const agent = {
      id: 'c',
      name: 'cloud-agent',
      deployment: { type: 'cloud', cloud: { containerName: 'aim-cloud' } },
    } as any
    await cancelCopyModeForAgent(agent)
    expect(mockContainerUtils.cancelCopyModeInContainer).toHaveBeenCalledWith('aim-cloud', 'cloud-agent')
    expect(mockRuntime.cancelCopyMode).not.toHaveBeenCalled()
  })
})

describe('agentSessionReady', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('host agent: delegates to runtime.sessionExists', async () => {
    mockRuntime.sessionExists.mockResolvedValue(true)
    const agent = { id: 'a', name: 'host-agent', deployment: { type: 'local' } } as any
    expect(await agentSessionReady(agent)).toBe(true)
    expect(mockRuntime.sessionExists).toHaveBeenCalledWith('host-agent')

    mockRuntime.sessionExists.mockResolvedValue(false)
    expect(await agentSessionReady(agent)).toBe(false)
  })

  it('cloud agent with containerName: returns true (existence resolved by docker-exec at send-time)', async () => {
    // Host tmux has no session for a cloud agent (tmux runs inside container
    // under the same name). Naive runtime.sessionExists() returned false and
    // upstream callers skipped cloud agents entirely — that was the
    // 6f5562f4 / Watson messages-service finding bug. agentSessionReady
    // collapses the check to "containerName configured".
    const agent = {
      id: 'c',
      name: 'cloud-agent',
      deployment: { type: 'cloud', cloud: { containerName: 'aim-cloud' } },
    } as any
    expect(await agentSessionReady(agent)).toBe(true)
    expect(mockRuntime.sessionExists).not.toHaveBeenCalled()
  })

  it('cloud agent without containerName: falls back to host check (returns false in practice)', async () => {
    mockRuntime.sessionExists.mockResolvedValue(false)
    const agent = { id: 'c', name: 'broken-cloud', deployment: { type: 'cloud', cloud: {} } } as any
    expect(await agentSessionReady(agent)).toBe(false)
  })

  it('agent without name or alias: returns false', async () => {
    const agent = { id: 'broken', deployment: { type: 'local' } } as any
    expect(await agentSessionReady(agent)).toBe(false)
    expect(mockRuntime.sessionExists).not.toHaveBeenCalled()
  })
})
