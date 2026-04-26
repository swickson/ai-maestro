/**
 * Agents Docker Service
 *
 * Business logic for creating agents in Docker containers.
 * Routes are thin wrappers that call these functions.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { v4 as uuidv4 } from 'uuid'
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
  extraEnv?: Record<string, string>
}

// Reject paths that could break out of the quoted `-v "..."` shell argument.
const UNSAFE_PATH_CHARS = /["'`$\n\r\\]/

// Reject env values that could break out of the quoted `-e KEY="value"` shell
// argument, or smuggle a second flag into the docker invocation. Same character
// class as path validation — both are interpolated into a quoted shell string.
const UNSAFE_ENV_VALUE_CHARS = /["'`$\n\r\\]/

// POSIX env var name shape: leading letter or underscore, then alphanumerics
// or underscores. Matches what `env` and most shells will actually export.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// Container user/home for the standard cloud-agent image (agent-container/Dockerfile).
// Used to compute container-side paths for AMP common mounts. If the image's
// USER ever changes, update this and the Dockerfile together.
const CONTAINER_HOME = '/home/claude'

// Trusts the caller: sandbox.mounts is operator-declared today (e.g., agent
// creation by the dashboard or a host operator). If this ever becomes user-
// controlled (an agent mutating its own mounts, unprivileged operators), add
// realpath + prefix-check against an allow-list of host roots before shelling.
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

export function validateExtraEnv(env: Record<string, string> | undefined): string | null {
  if (!env) return null
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(key)) {
      return `extraEnv: invalid key "${key}" — must match ${ENV_KEY_RE}`
    }
    if (typeof value !== 'string') {
      return `extraEnv["${key}"]: value must be a string`
    }
    if (UNSAFE_ENV_VALUE_CHARS.test(value)) {
      return `extraEnv["${key}"]: value must not contain quotes, backticks, $, backslashes, or newlines`
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

export function buildEnvFlags(env: Record<string, string> | undefined): string[] {
  if (!env) return []
  return Object.entries(env).map(([k, v]) => `-e ${k}="${v}"`)
}

// AMP common mounts wire the container so amp-helper.sh can resolve the agent's
// identity and find the AMP CLI on PATH. Without these, amp-helper falls back
// to the tmux session name and silently auto-creates a phantom empty identity
// with no signing key — every outbound message would be unverifiable.
//
// All four mounts are derived deterministically from the agent UUID, so they
// can be reproduced on container redeploy without operator input.
export function buildAmpCommonMounts(agentId: string, hostHome: string = os.homedir()): SandboxMount[] {
  return [
    {
      hostPath: path.join(hostHome, '.agent-messaging', 'agents', agentId),
      containerPath: path.posix.join(CONTAINER_HOME, '.agent-messaging', 'agents', agentId),
    },
    {
      hostPath: path.join(hostHome, '.aimaestro', 'agents', agentId),
      containerPath: path.posix.join(CONTAINER_HOME, '.aimaestro', 'agents', agentId),
    },
    {
      hostPath: path.join(hostHome, '.local', 'bin'),
      containerPath: path.posix.join(CONTAINER_HOME, '.local', 'bin'),
      readOnly: true,
    },
    {
      hostPath: path.join(hostHome, '.claude'),
      containerPath: path.posix.join(CONTAINER_HOME, '.claude'),
    },
  ]
}

// AMP common envs tell amp-helper.sh exactly which agent identity dir to use
// (priority 1 of its resolution order) and where to reach the AI Maestro server
// from inside the container (host.docker.internal is added via --add-host).
//
// Without these, amp-helper falls through to its name-based fallback, which
// auto-creates a phantom empty identity, and amp-send tries to call the
// container's own loopback agent-server instead of the AI Maestro API.
export function buildAmpCommonEnv(agentId: string, hostUrl: string): Record<string, string> {
  return {
    CLAUDE_AGENT_ID: agentId,
    AMP_DIR: path.posix.join(CONTAINER_HOME, '.agent-messaging', 'agents', agentId),
    AMP_MAESTRO_URL: hostUrl,
  }
}

// Merge mounts so operator-supplied entries override common ones at the same
// containerPath (operator wins), preserving operator order then appending any
// common mount the operator did not already cover.
export function mergeMounts(common: SandboxMount[], operator: SandboxMount[] | undefined): SandboxMount[] {
  const operatorList = operator ?? []
  const operatorPaths = new Set(operatorList.map(m => m.containerPath))
  return [...operatorList, ...common.filter(m => !operatorPaths.has(m.containerPath))]
}

// Merge envs so operator-supplied entries override common ones for the same key.
export function mergeEnv(common: Record<string, string>, operator: Record<string, string> | undefined): Record<string, string> {
  return { ...common, ...(operator ?? {}) }
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

  const envError = validateExtraEnv(body.extraEnv)
  if (envError) {
    return invalidRequest(envError)
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

  // Pre-generate the agent UUID so AMP common mounts and CLAUDE_AGENT_ID can
  // reference it on first container start. createAgent below accepts an
  // explicit `id` and will use it verbatim if it matches the UUID shape.
  const agentId = uuidv4()

  // Build the docker invocation. Common AMP mounts/envs are auto-included for
  // every cloud agent so amp-helper can resolve identity (CLAUDE_AGENT_ID +
  // AMP_DIR) and reach the host AI Maestro server (AMP_MAESTRO_URL via the
  // host.docker.internal alias). Operator-supplied mounts/extraEnv merge on
  // top: same containerPath / same env key wins for the operator, so callers
  // can override defaults when needed.
  const hostPort = process.env.PORT || '23000'
  const hostInternalUrl = `http://host.docker.internal:${hostPort}`

  const baseEnv: Record<string, string> = {
    TMUX_SESSION_NAME: name,
    AI_TOOL: aiTool,
    AGENT_ID: name,
    AIMAESTRO_HOST_URL: hostInternalUrl,
  }
  if (body.githubToken) {
    baseEnv.GITHUB_TOKEN = body.githubToken
  }
  const ampEnv = buildAmpCommonEnv(agentId, hostInternalUrl)
  const mergedEnv = mergeEnv({ ...baseEnv, ...ampEnv }, body.extraEnv)

  const ampMounts = buildAmpCommonMounts(agentId)
  const mergedMounts = mergeMounts(ampMounts, body.mounts)

  // Pre-create host-side AMP dirs that are about to be bind-mounted. If the
  // host path doesn't exist, docker creates it as a root-owned empty directory,
  // which (a) leaves the container's claude (uid 1000) unable to write keys
  // and (b) silently masks the missing-identity failure. We create them as the
  // server process user (uid matches the container's claude user by convention).
  for (const m of ampMounts) {
    try {
      fs.mkdirSync(m.hostPath, { recursive: true })
    } catch (err) {
      console.warn(`[Docker Service] Could not pre-create mount source ${m.hostPath}:`, err)
    }
  }

  const dockerCmd = [
    'docker run -d',
    `--name "${containerName}"`,
    '--add-host=host.docker.internal:host-gateway',
    body.autoRemove ? '' : '--restart unless-stopped',
    ...buildEnvFlags(mergedEnv),
    `-v "${workDir}:/workspace"`,
    ...buildMountFlags(mergedMounts),
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

  // Register in agent registry. Persist only the operator-supplied mounts
  // under deployment.sandbox.mounts — AMP common mounts are recomputed
  // deterministically from the agent UUID at any future redeploy, so storing
  // them would create drift if defaults evolve.
  try {
    const agent = createAgent({
      id: agentId,
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
