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
 *   - codex:  ~/.aimaestro/agents/<uuid>/codex-app-data/sessions/ → /home/claude/.codex/sessions/
 *     (single-dir OPT-B mount of the whole ~/.codex tree, kanban 01e11bf9)
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
 * (aider/cursor), openclaw (discover-and-attach), and unknown have no cloud
 * mount and resolve to 'claude'. Backed by the shared kind table so the
 * antigravity-before-gemini precedence lives in exactly one place.
 */
export function cloudProgram(
  agent: AgentPathInput
): 'claude' | 'gemini' | 'codex' | 'antigravity' | 'opencode' {
  const kind = resolveKind(agent.program, { default: 'claude' })
  return kind === 'gemini' || kind === 'codex' || kind === 'antigravity' || kind === 'opencode'
    ? kind
    : 'claude'
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
        // Antigravity (agy) does NOT write a JSONL conversation transcript.
        // Empirically (han cloud agent, #219): conversations/ holds only
        // <conversationId>.pb (protobuf) + .db (sqlite WAL) blobs — a binary
        // black box with no public schema. The ONLY JSONL is history.jsonl at
        // the antigravity-app-data ROOT, a flat log of USER prompts
        // ({display, timestamp, workspace, conversationId?}); assistant
        // responses live only in the .pb/.db black box. So return the ROOT dir
        // (single .jsonl there) — the flat scan picks history.jsonl and
        // normalizeAntigravityLine renders the user turns. Assistant-side is a
        // documented known limitation (lib/antigravity-message-normalizer.ts).
        // The whole antigravity-cli/ dir is bind-mounted single-source (OPT-B)
        // at <agentDir>/antigravity-app-data/ → /home/claude/.gemini/antigravity-cli/.
        return path.join(agentDir, 'antigravity-app-data')
      case 'codex':
        // Codex writes conversation transcripts as rollout-*.jsonl under
        // ~/.codex/sessions/<YYYY>/<MM>/<DD>/. The whole ~/.codex tree is
        // bind-mounted single-source (OPT-B, kanban 01e11bf9) at
        // <agentDir>/codex-app-data/ → /home/claude/.codex/. Returns the
        // sessions subdir so the chat-history reader scans the rollout files.
        // (All host threads.rollout_path values resolve under ~/.codex/sessions
        // with no config override — verified on the dev host 2026-06-10.)
        return path.join(agentDir, 'codex-app-data', 'sessions')
      case 'opencode':
        // OpenCode (v1.x) stores conversations in a SINGLE SQLite db
        // `opencode.db` (relational project→session→message→part), NOT a JSONL
        // transcript or a storage/*.json fan-out. The whole ~/.local/share/opencode
        // data dir (holds opencode.db + auth.json) is bind-mounted single-source
        // (OPT-B) at <agentDir>/opencode-data/ → /home/claude/.local/share/opencode/.
        // Return the data dir; the dedicated decoder (lib/opencode-db-decoder.ts)
        // opens opencode.db inside it. See docs/OPENCODE-HARNESS-SPEC.md.
        return path.join(agentDir, 'opencode-data')
      case 'claude':
      default:
        return path.join(agentDir, 'claude-projects', CONTAINER_CWD_ENCODED)
    }
  }
  // Host (non-cloud) agents run as the operator, so non-Claude programs write
  // their transcripts to the operator's OWN cli tree — NOT ~/.claude/projects.
  // Mirror the cloud branch's per-program resolution against the host $HOME.
  // Without this, every non-Claude local agent resolved to an empty/wrong
  // ~/.claude/projects dir and the chat window stayed blank (#223/#225, the
  // host-branch counterparts to the cloud #219 fix).
  switch (cloudProgram(agent)) {
    case 'antigravity':
      // ~/.gemini/antigravity-cli/history.jsonl — a shared operator dir (not
      // cwd-keyed, not per-agent; local agents share it). USER-PROMPTS-ONLY +
      // protobuf-blackbox assistant limitation, same as cloud #219/#223.
      return path.join(hostHome, '.gemini', 'antigravity-cli')
    case 'codex':
      // ~/.codex/sessions/<YYYY>/<MM>/<DD>/rollout-*.jsonl (#225). Recursion is
      // applied by resolveActiveTranscript (recursive = codex), so the nested
      // date dirs are scanned. Renders BOTH user + assistant turns — codex,
      // unlike antigravity, is not a black box.
      // LIMITATION: ~/.codex is the operator's SHARED dir; selectTranscriptFile
      // picks the newest-mtime rollout, which could belong to a different host
      // codex session if the operator runs codex in another cwd. Empirically the
      // recent rollouts all carry the agent's cwd (verified vs dev-<team>-<role>),
      // and session_meta.payload.cwd is recorded — so cwd-pinned selection is a
      // feasible future refinement if cross-session bleed becomes a problem.
      return path.join(hostHome, '.codex', 'sessions')
    case 'opencode':
      // ~/.local/share/opencode/opencode.db — the operator's OWN single OpenCode
      // data dir (holds opencode.db + auth.json). Shared across host agents (one
      // operator home; the spec's single-test-rig caveat — multiple host
      // opencode agents collide in the same db), so this lights up the Phase-1
      // decoder test rig, not a host product path. Same db shape as cloud, just a
      // different root. The decoder selects the newest session by time_updated.
      return path.join(hostHome, '.local', 'share', 'opencode')
    // NOTE: host GEMINI (~/.gemini/tmp/<project>/chats/session-*.jsonl) has the
    // same blind spot, but the project key is the literal from ~/.gemini/projects.json
    // (cwd-derived on host, NOT the cloud's fixed 'workspace'), and there is no
    // local gemini agent to verify the end-to-end resolution against. Left as a
    // thin follow-up rather than ship an unverified path (#225 scope note).
    case 'claude':
    default: {
      const workingDir = resolveHostWorkingDir(agent)
      if (!workingDir) return null
      const projectDirName = workingDir.replace(/\//g, '-')
      return path.join(hostHome, '.claude', 'projects', projectDirName)
    }
  }
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
