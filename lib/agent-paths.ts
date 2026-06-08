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
import { resolveBinary, resolveKind } from './program-resolver'

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

/**
 * Resolve a program identifier (agent.program) to the actual binary name.
 * antigravity is the outlier (binary: `agy`); most identifiers equal their
 * binary. Re-exported from the single source of truth (lib/program-resolver)
 * so the host-wake path and the cloud AI_TOOL composition share one table.
 *
 * Consumed by services/agents-docker-service.ts (cloud-agent AI_TOOL env —
 * without applying this at composition time, AI_TOOL bakes the program
 * identifier verbatim and agent-container/agent-server.js's
 * `tmux send-keys "unset CI && ${AI_TOOL}"` wake-line fails with
 * `command not found: antigravity`). program-resolver lives in a pure leaf
 * module for the same reason this re-export does: importing the runtime/cozo
 * chain into agents-docker-service breaks its test file load.
 */
export { resolveBinary as resolveStartCommand } from './program-resolver'

/**
 * Cloud-agent provider — which per-program bind-mount source a cloud agent
 * needs. Narrowed to the cloud-deployable kinds; host-only programs
 * (aider/cursor/opencode), openclaw (discover-and-attach), and unknown have
 * no cloud mount and resolve to 'claude'. Backed by the shared kind table so
 * the antigravity-before-gemini precedence lives in exactly one place.
 */
export function cloudProgram(agent: AgentPathInput): 'claude' | 'gemini' | 'codex' | 'antigravity' {
  const kind = resolveKind(agent.program, { default: 'claude' })
  return kind === 'gemini' || kind === 'codex' || kind === 'antigravity' ? kind : 'claude'
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
      case 'antigravity':
        // Antigravity (agy) writes conversation JSONL under
        // ~/.gemini/antigravity-cli/conversations/. The whole antigravity-cli/
        // dir is bind-mounted single-source (OPT-B) at
        // <agentDir>/antigravity-app-data/ → /home/claude/.gemini/antigravity-cli/.
        // Returns the conversations subdir so the chat-history reader scans
        // matching files. Format normalization is currently a stub in
        // lib/antigravity-message-normalizer.ts — real implementation lands
        // once a logged-in cloud agent generates sample conversation files.
        return path.join(agentDir, 'antigravity-app-data', 'conversations')
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
