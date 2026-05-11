/**
 * Agent path resolvers — cloud-vs-host conversation & hook-state directories.
 *
 * For host agents, Claude Code runs as the operator user and writes its
 * conversation JSONL + hook chat-state under the operator's $HOME on the host.
 * For cloud agents, Claude Code runs inside a Docker container as the `claude`
 * user with cwd=/workspace — its JSONL + hook chat-state live INSIDE the
 * container and would be invisible to the host-side maestro server without
 * bind mounts. provisionCloudClaudeConfig (services/agents-docker-service.ts)
 * adds two per-agent bind mounts at create time so these helpers can resolve
 * the cloud path locally on the host:
 *   - ~/.aimaestro/agents/<uuid>/claude-projects/ → /home/claude/.claude/projects/
 *   - ~/.aimaestro/agents/<uuid>/chat-state/      → /home/claude/.aimaestro/chat-state/
 *
 * Internal shape is a flat if-cloud branch; when Gemini/Codex providers grow
 * out next sprint, the helpers grow per-provider rows in the same place.
 */

import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'

import { CONTAINER_CWD, CONTAINER_CWD_ENCODED } from './container-utils'

// Minimal shape — avoids dragging the full Agent class into this lookup-only
// module. Callers pass either an Agent instance or a plain serialized record.
export interface AgentPathInput {
  id: string
  workingDirectory?: string
  deployment?: { type?: string; cloud?: { containerName?: string } } | null
  sessions?: Array<{ workingDirectory?: string }>
  preferences?: { defaultWorkingDirectory?: string }
}

function isCloudAgent(agent: AgentPathInput): boolean {
  return agent.deployment?.type === 'cloud'
}

function resolveHostWorkingDir(agent: AgentPathInput): string | null {
  return (
    agent.workingDirectory ||
    agent.sessions?.[0]?.workingDirectory ||
    agent.preferences?.defaultWorkingDirectory ||
    null
  )
}

/**
 * Where to find the agent's conversation JSONL directory on the local host fs.
 * Returns null when no working directory can be resolved for a host agent.
 */
export function resolveConversationDir(
  agent: AgentPathInput,
  hostHome: string = os.homedir()
): string | null {
  if (isCloudAgent(agent)) {
    return path.join(
      hostHome,
      '.aimaestro',
      'agents',
      agent.id,
      'claude-projects',
      CONTAINER_CWD_ENCODED,
    )
  }
  const workingDir = resolveHostWorkingDir(agent)
  if (!workingDir) return null
  const projectDirName = workingDir.replace(/\//g, '-')
  return path.join(hostHome, '.claude', 'projects', projectDirName)
}

// Mirrors the hashCwd implementations at services/agents-chat-service.ts:25,
// services/sessions-service.ts:140, and scripts/claude-hooks/ai-maestro-hook.cjs:55.
// All three must agree — the hook writes the file, the server reads it.
function hashCwd(cwd: string): string {
  return crypto.createHash('md5').update(cwd || '').digest('hex').substring(0, 16)
}

/**
 * Where the chat-state hook-output file for this agent's current working
 * directory lives on the local host fs. For cloud agents the hook runs
 * inside the container with cwd=CONTAINER_CWD ("/workspace"), so the hash
 * is over the container path not the host workingDirectory. Returns null
 * when no working directory can be resolved for a host agent.
 */
export function resolveChatStateFile(
  agent: AgentPathInput,
  hostHome: string = os.homedir()
): string | null {
  if (isCloudAgent(agent)) {
    const stateDir = path.join(hostHome, '.aimaestro', 'agents', agent.id, 'chat-state')
    return path.join(stateDir, `${hashCwd(CONTAINER_CWD)}.json`)
  }
  const workingDir = resolveHostWorkingDir(agent)
  if (!workingDir) return null
  const stateDir = path.join(hostHome, '.aimaestro', 'chat-state')
  return path.join(stateDir, `${hashCwd(workingDir)}.json`)
}
