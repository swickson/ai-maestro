/**
 * Agents Docker Service
 *
 * Business logic for creating agents in Docker containers.
 * Routes are thin wrappers that call these functions.
 */

import { exec } from 'child_process'
import { promisify } from 'util'
import { createAgent, loadAgents, saveAgents } from '@/lib/agent-registry'
import { getHosts, isSelf } from '@/lib/hosts-config'
import { type ServiceResult, missingField, operationFailed, invalidRequest, serviceError } from '@/services/service-errors'
import type { SandboxMount } from '@/types/agent'

const execAsync = promisify(exec)

export interface DockerCreateRequest {
  name: string
  workingDirectory?: string
  hostId?: string
  program?: string
  yolo?: boolean
  model?: string
  prompt?: string
  timeout?: number
  githubToken?: string
  cpus?: number
  memory?: string
  autoRemove?: boolean
  label?: string
  avatar?: string
  mounts?: SandboxMount[]
}

// Reject paths that could break out of the quoted `-v "..."` shell argument.
const UNSAFE_PATH_CHARS = /["'`$\n\r\\]/

export function validateMounts(mounts: SandboxMount[] | undefined): string | null {
  if (!mounts) return null
  for (const [i, m] of mounts.entries()) {
    if (typeof m?.hostPath !== 'string' || typeof m?.containerPath !== 'string') {
      return `mounts[${i}]: hostPath and containerPath are required strings`
    }
    if (!m.hostPath.startsWith('/') || !m.containerPath.startsWith('/')) {
      return `mounts[${i}]: hostPath and containerPath must be absolute paths`
    }
    if (UNSAFE_PATH_CHARS.test(m.hostPath) || UNSAFE_PATH_CHARS.test(m.containerPath)) {
      return `mounts[${i}]: paths must not contain quotes, backticks, $, backslashes, or newlines`
    }
    if (m.containerPath === '/workspace') {
      return `mounts[${i}]: /workspace is reserved for the agent working directory`
    }
  }
  return null
}

export function buildMountFlags(mounts: SandboxMount[] | undefined): string[] {
  if (!mounts || mounts.length === 0) return []
  return mounts.map(m => {
    const suffix = m.readOnly ? ':ro' : ''
    return `-v "${m.hostPath}:${m.containerPath}${suffix}"`
  })
}

// ── Public Functions ────────────────────────────────────────────────────────

/**
 * Create a new agent running inside a Docker container.
 */
export async function createDockerAgent(body: DockerCreateRequest): Promise<ServiceResult<Record<string, unknown>>> {
  if (!body.name?.trim()) {
    return missingField('name')
  }

  const mountError = validateMounts(body.mounts)
  if (mountError) {
    return invalidRequest(mountError)
  }

  const name = body.name.trim().toLowerCase()

  // If targeting a remote host, forward the request
  if (body.hostId) {
    const hosts = getHosts()
    const targetHost = hosts.find(h => h.id === body.hostId)
    if (targetHost && !isSelf(targetHost.id)) {
      try {
        const resp = await fetch(`${targetHost.url}/api/agents/docker/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        })
        const data = await resp.json()
        return { data, status: resp.status }
      } catch (err) {
        return operationFailed('reach remote host', err instanceof Error ? err.message : 'Unknown error')
      }
    }
  }

  // Verify Docker is available
  try {
    await execAsync("docker version --format '{{.Server.Version}}'", { timeout: 5000 })
  } catch {
    return invalidRequest('Docker is not available on this host')
  }

  // Find an available port in 23001-23100 range
  let port: number | null = null
  try {
    const { stdout: portsOutput } = await execAsync(
      "docker ps --format '{{.Ports}}' 2>/dev/null || echo ''"
    )
    const usedPorts = new Set<number>()
    const portRegex = /(\d+)->23000/g
    let match
    while ((match = portRegex.exec(portsOutput)) !== null) {
      usedPorts.add(parseInt(match[1], 10))
    }

    for (let p = 23001; p <= 23100; p++) {
      if (!usedPorts.has(p)) {
        port = p
        break
      }
    }
  } catch {
    port = 23001
  }

  if (!port) {
    return serviceError('operation_failed', 'No available ports in range 23001-23100', 503)
  }

  // Build the AI_TOOL environment variable
  const program = body.program || 'claude'
  let aiTool = program
  if (body.yolo) {
    aiTool += ' --dangerously-skip-permissions'
  }
  if (body.model) {
    aiTool += ` --model ${body.model}`
  }
  if (body.prompt) {
    const escapedPrompt = body.prompt.replace(/'/g, "'\\''")
    aiTool += ` -p '${escapedPrompt}'`
  }

  const containerName = `aim-${name}`
  const workDir = body.workingDirectory || '/tmp'
  const cpus = body.cpus || 2
  const memory = body.memory || '4g'

  // Build docker run command
  const envFlags = [
    `-e TMUX_SESSION_NAME="${name}"`,
    `-e AI_TOOL="${aiTool}"`,
  ]
  if (body.githubToken) {
    envFlags.push(`-e GITHUB_TOKEN="${body.githubToken}"`)
  }

  const extraMountFlags = buildMountFlags(body.mounts)

  const dockerCmd = [
    'docker run -d',
    `--name "${containerName}"`,
    ...envFlags,
    `-v "${workDir}:/workspace"`,
    ...extraMountFlags,
    `-p ${port}:23000`,
    `--cpus=${cpus}`,
    `--memory=${memory}`,
    body.autoRemove ? '--rm' : '',
    'ai-maestro-agent:latest',
  ].filter(Boolean).join(' ')

  let containerId: string
  try {
    const { stdout } = await execAsync(dockerCmd, { timeout: 30000 })
    containerId = stdout.trim().slice(0, 12)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return operationFailed('start container', message)
  }

  // Register in agent registry
  let agentId: string | undefined
  try {
    const agent = createAgent({
      name,
      label: body.label,
      avatar: body.avatar,
      program,
      model: body.model,
      taskDescription: body.prompt || '',
      workingDirectory: workDir,
      createSession: true,
      deploymentType: 'cloud',
      hostId: body.hostId,
    })
    agentId = agent.id

    const agents = loadAgents()
    const idx = agents.findIndex(a => a.id === agent.id)
    if (idx !== -1) {
      agents[idx].deployment = {
        type: 'cloud',
        cloud: {
          provider: 'local-container',
          containerName,
          websocketUrl: `ws://localhost:${port}/term`,
          healthCheckUrl: `http://localhost:${port}/health`,
          status: 'running',
        },
        ...(body.mounts && body.mounts.length > 0
          ? { sandbox: { mounts: body.mounts } }
          : {}),
      }
      saveAgents(agents)
    }
  } catch (err) {
    console.error('[Docker Service] Registry error:', err)
  }

  return {
    data: {
      success: true,
      agentId,
      containerId,
      port,
      containerName,
    },
    status: 200
  }
}
