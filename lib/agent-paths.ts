/**
 * Agent path resolvers — cloud-vs-host conversation & hook-state directories.
 *
 * For host agents, Claude Code runs as the operator user and writes its
 * conversation JSONL + hook chat-state under the operator's $HOME on the host.
 * For cloud agents, the TUI runs inside a Docker container as the `claude`
 * user with cwd=/workspace — its JSONL + hook chat-state live INSIDE the
 * container and would be invisible to the host-side maestro server without
 * bind mounts. provisionCloudClaudeConfig (services/agents-docker-service.ts)
 * adds per-agent bind mounts at create time so these helpers can resolve
 * the cloud path locally on the host. Per-program (Claude/Gemini/Codex):
 *   - claude: ~/.aimaestro/agents/<uuid>/claude-projects/ → /home/claude/.claude/projects/
 *   - claude: ~/.aimaestro/agents/<uuid>/chat-state/      → /home/claude/.aimaestro/chat-state/
 *   - gemini: ~/.aimaestro/agents/<uuid>/gemini-chats/    → /home/claude/.gemini/tmp/workspace/chats/
 *
 * Codex deferred — no cloud-Codex agents in mesh yet; row will be added when
 * Shane lands Vance on Codex (kanban tbd).
 */

import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'

import { CONTAINER_CWD, CONTAINER_CWD_ENCODED, CONTAINER_CWD_GEMINI_PROJECT } from './container-utils'

// Minimal shape — avoids dragging the full Agent class into this lookup-only
// module. Callers pass either an Agent instance or a plain serialized record.
export interface AgentPathInput {
  id: string
  program?: string
  workingDirectory?: string
  deployment?: { type?: string; cloud?: { containerName?: string } } | null
  sessions?: Array<{ workingDirectory?: string }>
  preferences?: { defaultWorkingDirectory?: string }
}

// Cloud-agent provider — normalized from agent.program (free-form values like
// 'claude code', 'claude-code', 'gemini', 'codex' across the registry). The
// resolver only needs to know "is this Claude, Gemini, or Codex" so it can
// pick the right per-program bind-mount source.
function cloudProgram(agent: AgentPathInput): 'claude' | 'gemini' | 'codex' {
  const raw = (agent.program || '').toLowerCase()
  if (raw.includes('gemini')) return 'gemini'
  if (raw.includes('codex')) return 'codex'
  return 'claude' // default — pre-PR-#117 agents without an explicit program field
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
    const agentDir = path.join(hostHome, '.aimaestro', 'agents', agent.id)
    switch (cloudProgram(agent)) {
      case 'gemini':
        // Gemini: ~/.gemini/tmp/<project>/chats/session-*.jsonl
        // Bind-mount source: <agentDir>/gemini-chats/ → /home/claude/.gemini/tmp/workspace/chats/
        // Note Gemini does NOT slash-encode the cwd; project key is the literal
        // value from ~/.gemini/projects.json (CONTAINER_CWD_GEMINI_PROJECT).
        return path.join(agentDir, 'gemini-chats')
      case 'codex':
        // No cloud-Codex agent in mesh; row deferred to its own kanban
        // when Vance migrates to Codex.
        return null
      case 'claude':
      default:
        return path.join(agentDir, 'claude-projects', CONTAINER_CWD_ENCODED)
    }
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
