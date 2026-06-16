/**
 * wakeAgent — cloud container lifecycle status reconciliation
 *
 * Regression coverage for kanban 4ba71c3a: waking a cloud (local-container) agent
 * must reconcile the persisted deployment.cloud.status to 'running' once the
 * container is confirmed running — whether it was just started OR was already
 * running — so the UI never renders a live container as "stopped".
 *
 * Host-parity invariant: the already-running branch must NOT re-fire the on-wake
 * hook (it only marks the session online + reconciles status), matching the host
 * tmux already-running branch and avoiding injection into a busy live session.
 * The on-wake hook fires only on a fresh container start (stopped/created branch).
 *
 * Lives in its own file (not agents-core-service.test.ts) intentionally: that file
 * is a reconciliation adoptUpstream artifact; a new file stays out of the contested
 * set so it doesn't trip the merge-time reconcile gate.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { makeAgent, resetFixtureCounter } from '../test-utils/fixtures'

// ============================================================================
// Mocks — vi.hoisted() ensures availability before vi.mock() runs
// ============================================================================

const {
  mockRuntime,
  mockAgentRegistry,
  mockHostsConfig,
  mockSessionPersistence,
  mockAmpInboxWriter,
  mockSharedState,
  mockAgentStartup,
  mockMessageQueue,
  mockFs,
  mockUuid,
} = vi.hoisted(() => {
  const mockRuntime = {
    listSessions: vi.fn().mockResolvedValue([]),
    sessionExists: vi.fn().mockResolvedValue(false),
    createSession: vi.fn().mockResolvedValue(undefined),
    killSession: vi.fn().mockResolvedValue(undefined),
    renameSession: vi.fn().mockResolvedValue(undefined),
    sendKeys: vi.fn().mockResolvedValue(undefined),
    cancelCopyMode: vi.fn().mockResolvedValue(undefined),
    setEnvironment: vi.fn().mockResolvedValue(undefined),
    unsetEnvironment: vi.fn().mockResolvedValue(undefined),
  }
  let uuidCounter = 0
  return {
    mockRuntime,
    mockAgentRegistry: {
      loadAgents: vi.fn().mockReturnValue([]),
      saveAgents: vi.fn(),
      createAgent: vi.fn(),
      getAgent: vi.fn(),
      getAgentByName: vi.fn(),
      getAgentBySession: vi.fn(),
      updateAgent: vi.fn(),
      deleteAgent: vi.fn(),
      searchAgents: vi.fn().mockReturnValue([]),
      linkSession: vi.fn(),
      unlinkSession: vi.fn(),
      markCloudContainerStale: vi.fn(),
      setCloudContainerStatus: vi.fn(),
    },
    mockHostsConfig: {
      getHosts: vi.fn().mockReturnValue([{ id: 'test-host', name: 'Test Host', url: 'http://localhost:23000' }]),
      getSelfHost: vi.fn().mockReturnValue({ id: 'test-host', name: 'Test Host', url: 'http://localhost:23000' }),
      getSelfHostId: vi.fn().mockReturnValue('test-host'),
      isSelf: vi.fn().mockReturnValue(true),
    },
    mockSessionPersistence: {
      persistSession: vi.fn(),
      unpersistSession: vi.fn(),
    },
    mockAmpInboxWriter: {
      initAgentAMPHome: vi.fn().mockResolvedValue(undefined),
      getAgentAMPDir: vi.fn().mockReturnValue('/tmp/amp/test'),
    },
    mockSharedState: {
      sessionActivity: new Map<string, number>(),
      agentActivity: new Map<string, number>(),
    },
    mockAgentStartup: {
      initializeAllAgents: vi.fn().mockResolvedValue({ initialized: [], failed: [] }),
      getStartupStatus: vi.fn().mockReturnValue({ initialized: true }),
    },
    mockMessageQueue: {
      resolveAgentIdentifier: vi.fn(),
    },
    mockFs: {
      default: {
        readFileSync: vi.fn().mockReturnValue('{}'),
        existsSync: vi.fn().mockReturnValue(false),
        readdirSync: vi.fn().mockReturnValue([]),
        mkdirSync: vi.fn(),
        writeFileSync: vi.fn(),
        unlinkSync: vi.fn(),
      },
    },
    mockUuid: {
      v4: vi.fn(() => `uuid-${++uuidCounter}`),
    },
  }
})

vi.mock('@/lib/agent-runtime', () => ({
  getRuntime: vi.fn().mockReturnValue(mockRuntime),
}))
vi.mock('@/lib/agent-registry', () => mockAgentRegistry)
vi.mock('@/lib/hosts-config', () => mockHostsConfig)
vi.mock('@/lib/session-persistence', () => mockSessionPersistence)
vi.mock('@/lib/amp-inbox-writer', () => mockAmpInboxWriter)
vi.mock('@/services/shared-state', () => mockSharedState)
vi.mock('@/lib/agent-startup', () => mockAgentStartup)
vi.mock('@/lib/messageQueue', () => mockMessageQueue)
vi.mock('fs', () => mockFs)
vi.mock('uuid', () => mockUuid)
vi.mock('@/lib/container-utils', () => ({
  capturePaneFromContainer: vi.fn().mockResolvedValue(''),
  inspectContainerStatus: vi.fn().mockResolvedValue('missing'),
  removeContainer: vi.fn().mockResolvedValue(undefined),
  sendKeysToContainer: vi.fn().mockResolvedValue(undefined),
  startContainer: vi.fn().mockResolvedValue(undefined),
  stopContainer: vi.fn().mockResolvedValue(undefined),
  tmuxHasSessionInContainer: vi.fn().mockResolvedValue(false),
}))
vi.mock('child_process', () => ({
  exec: vi.fn((_cmd: string, cb: Function) => cb(null, { stdout: '', stderr: '' })),
  execSync: vi.fn().mockReturnValue(''),
}))

// Import module under test (after mocks)
import { wakeAgent } from '@/services/agents-core-service'
import { inspectContainerStatus, startContainer, sendKeysToContainer } from '@/lib/container-utils'

beforeEach(() => {
  vi.clearAllMocks()
  resetFixtureCounter()
  mockSharedState.sessionActivity.clear()
  mockSharedState.agentActivity.clear()
  mockHostsConfig.isSelf.mockReturnValue(true)
})

const cloudAgent = (id: string, containerName: string) =>
  makeAgent({
    id,
    name: id,
    deployment: { type: 'cloud', cloud: { provider: 'local-container', websocketUrl: 'ws://localhost:23010/term', containerName, status: 'stopped' } },
    hooks: { 'on-wake': 'echo woke' },
  })

describe('wakeAgent — cloud container status reconciliation', () => {
  it('already-running container: reconciles cloud.status to running WITHOUT re-firing the on-wake hook', async () => {
    const agent = cloudAgent('cloud-running', 'aim-cloud-running')
    mockAgentRegistry.getAgent.mockReturnValue(agent)
    mockAgentRegistry.loadAgents.mockReturnValue([agent])
    vi.mocked(inspectContainerStatus).mockResolvedValue('running')

    const result = await wakeAgent('cloud-running', {})

    expect(result.status).toBe(200)
    expect((result.data as any)?.alreadyRunning).toBe(true)
    // persisted cloud lifecycle status reconciled to reality (the UI-visible fix)
    expect(mockAgentRegistry.setCloudContainerStatus).toHaveBeenCalledWith('cloud-running', 'running')
    // host parity: no container start, and crucially NO on-wake hook injection into a live session
    expect(vi.mocked(startContainer)).not.toHaveBeenCalled()
    expect(vi.mocked(sendKeysToContainer)).not.toHaveBeenCalled()
  })

  it('stopped container: starts it and reconciles cloud.status to running', async () => {
    // no on-wake hook → the started-branch hook IIFE (tmux-wait) would otherwise linger past teardown
    const agent = makeAgent({
      id: 'cloud-stopped',
      name: 'cloud-stopped',
      deployment: { type: 'cloud', cloud: { provider: 'local-container', websocketUrl: 'ws://localhost:23010/term', containerName: 'aim-cloud-stopped', status: 'stopped' } },
    })
    mockAgentRegistry.getAgent.mockReturnValue(agent)
    mockAgentRegistry.loadAgents.mockReturnValue([agent])
    vi.mocked(inspectContainerStatus).mockResolvedValue('stopped')

    const result = await wakeAgent('cloud-stopped', {})

    expect(result.status).toBe(200)
    expect((result.data as any)?.programStarted).toBe(true)
    expect(vi.mocked(startContainer)).toHaveBeenCalledWith('aim-cloud-stopped')
    expect(mockAgentRegistry.setCloudContainerStatus).toHaveBeenCalledWith('cloud-stopped', 'running')
  })
})
