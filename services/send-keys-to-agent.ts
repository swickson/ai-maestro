/**
 * Deployment-aware send-keys primitive — branches on agent.deployment.type
 * and dispatches to either the host tmux runtime or the in-container
 * docker-exec equivalents.
 *
 * Closes 6f5562f4 (cloud agents cannot participate in meetings) +
 * 6c3f4357 (extend /api/agents/<id>/chat to handle cloud agents) plus
 * Watson messages-service finding by centralizing the cloud-vs-host
 * dispatch that four call sites previously had to (re)derive.
 *
 * The cancelCopyMode→sendKeys ordering invariant pinned by PR #111 is
 * preserved by lifting the four-way matrix WHOLE into here — callers
 * only need to call cancelCopyModeForAgent() then sendKeysToAgent(),
 * and they get the right primitive for the deployment type.
 *
 * Per-agent hybrid-vs-legacy decision (shouldUseAdditionalContext) is
 * intentionally left at the higher inject-helper layer — it is per-agent
 * driven by program kind, not per-callsite, and the queue/wake-ping
 * shape is meeting-injection-specific. The four-way callsite matrix
 * collapses to a two-way deployment branch here.
 */

import type { Agent } from '@/types/agent'
import { getRuntime } from '@/lib/agent-runtime'
import { sendKeysToContainer, cancelCopyModeInContainer } from '@/lib/container-utils'

export interface SendKeysOptions {
  literal?: boolean
  enter?: boolean
}

function resolveCloudTarget(agent: Agent): { containerName: string; sessionName: string } | null {
  if (agent.deployment?.type !== 'cloud') return null
  const containerName = agent.deployment?.cloud?.containerName
  if (!containerName) return null
  const sessionName = agent.name || agent.alias
  if (!sessionName) return null
  return { containerName, sessionName }
}

export async function sendKeysToAgent(
  agent: Agent,
  keys: string,
  opts: SendKeysOptions = {}
): Promise<void> {
  const cloud = resolveCloudTarget(agent)
  if (cloud) {
    await sendKeysToContainer(cloud.containerName, cloud.sessionName, keys, opts)
    return
  }
  const sessionName = agent.name || agent.alias
  if (!sessionName) {
    throw new Error(`sendKeysToAgent: agent ${agent.id} has no session name`)
  }
  const runtime = getRuntime()
  await runtime.sendKeys(sessionName, keys, opts)
}

export async function cancelCopyModeForAgent(agent: Agent): Promise<void> {
  const cloud = resolveCloudTarget(agent)
  if (cloud) {
    await cancelCopyModeInContainer(cloud.containerName, cloud.sessionName)
    return
  }
  const sessionName = agent.name || agent.alias
  if (!sessionName) {
    throw new Error(`cancelCopyModeForAgent: agent ${agent.id} has no session name`)
  }
  const runtime = getRuntime()
  await runtime.cancelCopyMode(sessionName)
}

/**
 * Existence check that DTRT for cloud agents — host tmux has no session for
 * a cloud agent (tmux runs inside the container under the same name), so the
 * naive `runtime.sessionExists(name)` returns false and callers skip the
 * agent entirely. For cloud agents we treat "containerName configured" as a
 * proxy for "ready to receive"; sendKeysToAgent will surface the actual
 * docker exec failure if the container is not running.
 */
export async function agentSessionReady(agent: Agent): Promise<boolean> {
  const cloud = resolveCloudTarget(agent)
  if (cloud) return true
  const sessionName = agent.name || agent.alias
  if (!sessionName) return false
  const runtime = getRuntime()
  return runtime.sessionExists(sessionName)
}
