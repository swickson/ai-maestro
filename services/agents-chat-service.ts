/**
 * Agents Chat Service
 *
 * Business logic for reading agent conversations and sending messages.
 * Routes are thin wrappers that call these functions.
 */

import { getAgent, getAgentBySession } from '@/lib/agent-registry'
import { getRuntime } from '@/lib/agent-runtime'
import {
  enqueueForSession,
  shouldUseAdditionalContext,
  sanitizeForRawInject,
  wrapAsBracketedPaste,
} from '@/lib/meeting-inject-queue'
import { sendKeysToAgent, cancelCopyModeForAgent, agentSessionReady } from '@/services/send-keys-to-agent'
import { resolveConversationDir, resolveChatStateFile, cloudProgram } from '@/lib/agent-paths'
import { resolveActiveTranscript } from '@/lib/conversation-resolver'
import { capturePaneFromContainer } from '@/lib/container-utils'
import { normalizeGeminiLine } from '@/lib/gemini-message-normalizer'
import { normalizeAntigravityLine } from '@/lib/antigravity-message-normalizer'
import { loadNewestAntigravityChat } from '@/lib/antigravity-db-decoder'
import { loadNewestOpencodeConversation } from '@/lib/opencode-db-decoder'
import { normalizeCodexLine } from '@/lib/codex-message-normalizer'
import * as fs from 'fs'
import * as path from 'path'
import { type ServiceResult, notFound, invalidRequest, invalidField, missingField } from '@/services/service-errors'

// ── Public Functions ────────────────────────────────────────────────────────

/**
 * Get messages from the agent's current conversation JSONL file.
 */
export async function getConversationMessages(
  agentId: string,
  options: { since?: string | null; limit?: number }
): Promise<ServiceResult<Record<string, unknown>>> {
  const agent = getAgent(agentId)
  if (!agent) {
    return notFound('Agent', agentId)
  }

  const { since, limit = 100 } = options

  const workingDir = agent.workingDirectory ||
                     agent.sessions?.[0]?.workingDirectory ||
                     agent.preferences?.defaultWorkingDirectory

  const program = cloudProgram(agent)

  // Gate the workingDirectory requirement to EXACTLY the host programs whose
  // resolveConversationDir consumes it — claude and gemini both fall to the
  // cwd-keyed default branch (~/.claude/projects/<cwd> / ~/.gemini project key).
  // codex/antigravity/opencode resolve via a FIXED cli-tree path with no
  // workingDirectory (~/.codex/sessions, ~/.gemini/antigravity-cli,
  // ~/.local/share/opencode), so gating them wrongly rejects valid agents and
  // drifts from the WS path, which has no such guard (#251 C2 — host-opencode
  // is the shape this PR added + tested). Cloud agents use the bind-mounted
  // per-agent dir and never need it. The !conversationDir check below still
  // catches a genuinely unresolvable claude/gemini agent.
  const needsWorkingDir = program === 'claude' || program === 'gemini'
  if (!workingDir && agent.deployment?.type !== 'cloud' && needsWorkingDir) {
    return invalidRequest('Agent has no working directory configured')
  }

  // Find the Claude conversation directory for this project. For cloud agents
  // this resolves to the per-agent bind-mounted host path (Claude Code writes
  // to /home/claude/.claude/projects/-workspace/ inside the container; that
  // dir is bind-mounted from ~/.aimaestro/agents/<uuid>/claude-projects/ on
  // the host). For host agents it resolves to ~/.claude/projects/<host-cwd>/.
  const conversationDir = resolveConversationDir(agent)

  if (!conversationDir || !fs.existsSync(conversationDir)) {
    return {
      data: {
        success: true,
        messages: [],
        conversationFile: null,
        message: 'No conversation directory found for this project'
      },
      status: 200
    }
  }

  const sinceTime = since ? new Date(since).getTime() : 0
  const messages: any[] = []
  let currentConversation: { path: string; mtime: Date } | null = null

  // Antigravity: decode the FULL (user + assistant + tool) conversation as a
  // DEDICATED source spanning BOTH on-disk formats — the plaintext SQLite
  // conversations/*.db (#232) and the newer brain/<uuid>/…/transcript_full.jsonl
  // (agy 1.0.1+, #256), newest-mtime-wins. Kept separate from the generic JSONL
  // resolver, which intentionally ignores .pb/.db and serves history.jsonl (user
  // prompts only). Falls through to that user-prompt path below only for old,
  // encrypted .pb-only conversations with neither a decodable .db nor a brain
  // transcript.
  if (program === 'antigravity') {
    const decoded = loadNewestAntigravityChat(conversationDir)
    if (decoded && decoded.messages.length > 0) {
      currentConversation = { path: decoded.path, mtime: decoded.mtime }
      for (const msg of decoded.messages) {
        if (since && msg.timestamp && new Date(msg.timestamp).getTime() <= sinceTime) continue
        messages.push(msg)
      }
    }
  }

  // OpenCode: decode the FULL (user + assistant + tool) conversation from the
  // single opencode.db (SQLite, newest session by time_updated) as a DEDICATED
  // source — SAME shared loader the WS path uses (server.mjs), so the two can't
  // drift. conversationDir IS the data dir (opencode.db lives at its root — no
  // conversations/ subdir, unlike antigravity). OpenCode has no JSONL transcript,
  // so there's no fallback: an empty decode just yields an empty conversation.
  if (program === 'opencode') {
    const decoded = loadNewestOpencodeConversation(conversationDir)
    if (decoded && decoded.messages.length > 0) {
      currentConversation = { path: decoded.path, mtime: decoded.mtime }
      for (const msg of decoded.messages) {
        if (since && msg.timestamp && new Date(msg.timestamp).getTime() <= sinceTime) continue
        messages.push(msg)
      }
    }
  }

  if (!currentConversation) {
    // Resolve the agent's ACTUAL current transcript via the shared resolver
    // (prefers the hook's transcriptPath, rejects title-only stubs, reports
    // pending when the current session's file isn't written yet) — same logic the
    // live WS chat uses, so the two paths can't drift. See #195.
    const resolved = resolveActiveTranscript(agent)
    if (!resolved.path || !resolved.exists) {
      return {
        data: {
          success: true,
          messages: [],
          conversationFile: null,
          message: resolved.pending
            ? 'Conversation transcript not yet available'
            : 'No conversation files found'
        },
        status: 200
      }
    }

    currentConversation = { path: resolved.path, mtime: resolved.mtime as Date }

    // Read and parse the JSONL file
    const fileContent = fs.readFileSync(currentConversation.path, 'utf-8')
    const lines = fileContent.split('\n').filter(line => line.trim())

    const isGemini = program === 'gemini'
    const isAntigravity = program === 'antigravity'
    const isCodex = program === 'codex'

    for (const line of lines) {
      try {
        const raw = JSON.parse(line)

        if (since && raw.timestamp) {
          const msgTime = new Date(raw.timestamp).getTime()
          if (msgTime <= sinceTime) continue
        }

        if (isGemini) {
          const normalized = normalizeGeminiLine(raw)
          if (normalized) messages.push(normalized)
          continue
        }

        if (isAntigravity) {
          // Fallback for old, encrypted .pb-only conversations (no decodable
          // .db): history.jsonl yields USER prompts only. The assistant side
          // for current .db conversations is handled by the dedicated decoder
          // above (#232).
          const normalized = normalizeAntigravityLine(raw)
          if (normalized) messages.push(normalized)
          continue
        }

        if (isCodex) {
          // Codex rollout-*.jsonl: surface user/assistant message turns, skip
          // session/turn/event metadata, reasoning, and tool-call items (#159).
          const normalized = normalizeCodexLine(raw)
          if (normalized) messages.push(normalized)
          continue
        }

        // Claude shape — preserve thinking-block extraction + raw message push
        if (raw.type === 'assistant' && raw.message?.content) {
          const content = raw.message.content
          if (Array.isArray(content)) {
            for (const block of content) {
              if (block.type === 'thinking' && block.thinking) {
                messages.push({
                  type: 'thinking',
                  thinking: block.thinking,
                  timestamp: raw.timestamp,
                  uuid: raw.uuid
                })
              }
            }
          }
        }

        messages.push(raw)
      } catch {
        // Skip malformed lines
      }
    }
  }

  const limitedMessages = messages.slice(-limit)

  // Read hook state file. For cloud agents the hook writes inside the
  // container with cwd=/workspace, so the hash is over /workspace and the
  // file lives in the per-agent bind-mounted ~/.aimaestro/agents/<uuid>/chat-state/
  // host path. resolveChatStateFile encapsulates that branching.
  let hookState: any = null
  const stateFile = resolveChatStateFile(agent)
  if (stateFile) {
    try {
      if (fs.existsSync(stateFile)) {
        const stateContent = fs.readFileSync(stateFile, 'utf-8')
        hookState = JSON.parse(stateContent)

        const isWaitingState = hookState.status === 'waiting_for_input' || hookState.status === 'permission_request' || hookState.status === 'question_prompt'
        if (!isWaitingState) {
          const stateAge = Date.now() - new Date(hookState.updatedAt).getTime()
          if (stateAge > 60000) {
            hookState = null
          }
        }
      }
    } catch {
      // Ignore state read errors
    }
  }

  // Capture tmux to detect prompts waiting for input. Gate uses the
  // cloud-aware agentSessionReady primitive (agent.sessions[] is
  // tmux-host-enumerated and wrongly reports offline for cloud agents).
  // For cloud agents the tmux session itself runs inside the container,
  // so capture routes through docker exec via capturePaneFromContainer;
  // host agents use the local TmuxRuntime.capturePane.
  let terminalPrompt: string | null = null
  let promptType: 'permission' | 'input' | null = null
  const hasOnlineSession = await agentSessionReady(agent)
  if (hasOnlineSession) {
    const sessionName = agent.name || agent.alias
    if (sessionName) {
      try {
        const containerName = agent.deployment?.type === 'cloud'
          ? agent.deployment?.cloud?.containerName
          : null
        const stdout = containerName
          ? await capturePaneFromContainer(containerName, sessionName, 40)
          : await getRuntime().capturePane(sessionName, 40)
        const tmuxLines = stdout.trim().split('\n')
        const recentLines = tmuxLines.slice(-10)
        const recentText = recentLines.join('\n').toLowerCase()

        const isThinking = recentText.includes('elucidating') ||
                           recentText.includes('thinking') ||
                           recentText.includes('analyzing') ||
                           recentText.includes('generating') ||
                           recentText.includes('processing') ||
                           (recentText.includes('esc to interrupt') && !recentText.includes('esc to cancel'))

        if (!isThinking) {
          const separators: number[] = []

          for (let i = recentLines.length - 1; i >= 0; i--) {
            const line = recentLines[i].trim()
            if (line.match(/^[─╌═]{10,}$/)) {
              separators.push(i)
              if (separators.length === 2) break
            }
          }

          let promptContent: string[] = []
          if (separators.length === 2) {
            const [bottomSep, topSep] = separators
            promptContent = recentLines.slice(topSep + 1, bottomSep)
              .map(l => l.trim())
              .filter(l => l)
          }

          const promptText = promptContent.join('\n')
          const isOnlyInputPrompt = promptContent.length === 1 && promptContent[0].match(/^>\s*$/)

          const hasPermissionIndicator = promptContent.some(line =>
            line.startsWith('Do you want to') ||
            line.match(/^❯\s*\d+\./) ||
            line.match(/^\d+\.\s+(Yes|No|Type|Skip)/) ||
            line.startsWith('Esc to cancel')
          )

          if (hasPermissionIndicator && promptContent.length > 0) {
            terminalPrompt = promptText
            promptType = 'permission'
          } else if (isOnlyInputPrompt) {
            terminalPrompt = 'Ready for input'
            promptType = 'input'
          }
        }
      } catch {
        // Ignore tmux capture errors
      }
    }
  }

  return {
    data: {
      success: true,
      messages: limitedMessages,
      conversationFile: currentConversation.path,
      totalMessages: messages.length,
      lastModified: currentConversation.mtime.toISOString(),
      hookState,
      terminalPrompt,
      promptType
    },
    status: 200
  }
}

/**
 * Send a message to the agent's Claude session via tmux.
 */
export async function sendChatMessage(
  agentId: string,
  message: string
): Promise<ServiceResult<Record<string, unknown>>> {
  if (!message || typeof message !== 'string') {
    return missingField('message')
  }

  const agent = getAgent(agentId)
  if (!agent) {
    return notFound('Agent', agentId)
  }

  const sessionName = agent.name || agent.alias
  if (!sessionName) {
    return invalidRequest('Agent has no session name')
  }

  // Use the cloud-aware agentSessionReady primitive — agent.sessions[] is
  // tmux-host-enumerated and wrongly reports offline for cloud agents whose
  // tmux runs in-container. The PR #115 dispatch path is already cloud-aware;
  // this pre-dispatch gate was missed in that migration.
  const hasOnlineSession = await agentSessionReady(agent)
  if (!hasOnlineSession) {
    return invalidRequest('Agent session is not online')
  }

  // Exit copy-mode first — sending keys to a copy-mode pane hangs the request
  // and drops the payload (kanban 96d317df). Mirror of the wakeAgent and
  // sessions-service patterns. Primitive routes the call to docker-exec for
  // cloud agents (kanban 6c3f4357 / 7a94534e) — this used to be host-only.
  await cancelCopyModeForAgent(agent)
  await sendKeysToAgent(agent, message, { literal: true, enter: true })

  console.log('[Chat Service] Message sent successfully')

  return {
    data: {
      success: true,
      message: 'Message sent to session',
      sessionName
    },
    status: 200
  }
}

/**
 * Inject a meeting prompt into an agent's tmux session — the service-layer
 * counterpart of POST /api/agents/notify (injection mode). Extracted from the
 * route handler for unit-testability of the cancelCopyMode→sendKeys ordering
 * across all four branches (kanban cff76d5c, PR #94 follow-up).
 *
 * Two paths × two deployments:
 *   1. hybrid host  — cancelCopyModeForAgent → sendKeysToAgent('.') → wait → Enter
 *   2. hybrid cloud — same primitives, dispatched in-container by the primitive
 *   3. legacy host  — cancelCopyModeForAgent → sendKeysToAgent(safeInjection) → wait → Enter
 *   4. legacy cloud — same primitives, dispatched in-container by the primitive
 *
 * The cloud-vs-host dispatch was previously inlined here (one branch per path);
 * 7a94534e collapsed it into the sendKeysToAgent / cancelCopyModeForAgent
 * primitives so the four-way matrix is the cartesian product of {hybrid, legacy}
 * × {whatever the primitive resolves} — no manual cloud branch in this file.
 *
 * The cancelCopyMode→sendKeys ordering invariant is load-bearing: tmux
 * send-keys -l against a copy-mode pane hangs the calling process AND drops
 * the payload (kanban 96d317df / Holmes empirical 2026-04-28). Same prelude
 * pattern as wakeAgent + sendCommand + sendChatMessage.
 */
export async function injectMeetingPrompt(
  body: { agentName?: string; injection?: string }
): Promise<ServiceResult<{ success: boolean; queued?: boolean; injected?: boolean }>> {
  if (!body.agentName) {
    return missingField('agentName')
  }
  if (!body.injection) {
    return missingField('injection')
  }

  const sessionName = body.agentName
  const agent = getAgentBySession(sessionName)
  if (!agent) {
    return notFound('Agent', sessionName)
  }
  const isCloud = agent.deployment?.type === 'cloud'
  if (isCloud && !agent.deployment?.cloud?.containerName) {
    return invalidField('deployment.cloud.containerName', `Cloud agent ${sessionName} has no containerName configured`)
  }
  if (!isCloud) {
    const ready = await agentSessionReady(agent)
    if (!ready) {
      return notFound('Session', sessionName)
    }
  }

  // Hybrid path (flag-gated per agent kind): enqueue as structured context and
  // wake-ping with "." + Enter (bare Enter was a no-op in Claude Code). Hook
  // drains on the resulting UserPromptSubmit.
  if (shouldUseAdditionalContext(agent.program)) {
    enqueueForSession(sessionName, body.injection)
    await cancelCopyModeForAgent(agent)
    await sendKeysToAgent(agent, '.', { literal: true, enter: false })
    await new Promise(r => setTimeout(r, 100))
    await sendKeysToAgent(agent, '', { literal: false, enter: true })
    console.log(`[Inject Service] queued + wake-pinged ${sessionName} (${agent.program}${isCloud ? ', cloud' : ''})`)
    return { data: { success: true, queued: true }, status: 200 }
  }

  // Legacy path: send the injection as an explicit bracketed-paste block
  // (ESC[200~…ESC[201~) so Codex/Gemini close their paste-receive window on
  // the 201~ marker before our trailing Enter lands.
  const safeInjection = wrapAsBracketedPaste(sanitizeForRawInject(String(body.injection)))
  await cancelCopyModeForAgent(agent)
  await sendKeysToAgent(agent, safeInjection, { literal: true, enter: false })
  await new Promise(r => setTimeout(r, 500))
  await sendKeysToAgent(agent, '', { literal: false, enter: true })
  console.log(`[Inject Service] injected meeting prompt into ${sessionName}${isCloud ? ' (cloud)' : ''}`)
  return { data: { success: true, injected: true }, status: 200 }
}
