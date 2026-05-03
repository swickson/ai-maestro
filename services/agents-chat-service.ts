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
import { sendKeysToContainer, cancelCopyModeInContainer } from '@/lib/container-utils'
import * as fs from 'fs'
import * as path from 'path'
import * as crypto from 'crypto'
import os from 'os'
import { type ServiceResult, notFound, invalidRequest, invalidField, missingField } from '@/services/service-errors'

// ── Helpers ─────────────────────────────────────────────────────────────────

function hashCwd(cwd: string): string {
  return crypto.createHash('md5').update(cwd || '').digest('hex').substring(0, 16)
}

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

  if (!workingDir) {
    return invalidRequest('Agent has no working directory configured')
  }

  // Find the Claude conversation directory for this project
  const claudeProjectsDir = path.join(os.homedir(), '.claude', 'projects')
  const projectDirName = workingDir.replace(/\//g, '-')
  const conversationDir = path.join(claudeProjectsDir, projectDirName)

  if (!fs.existsSync(conversationDir)) {
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

  // Find the most recently modified .jsonl file
  const files = fs.readdirSync(conversationDir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => ({
      name: f,
      path: path.join(conversationDir, f),
      mtime: fs.statSync(path.join(conversationDir, f)).mtime
    }))
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

  if (files.length === 0) {
    return {
      data: {
        success: true,
        messages: [],
        conversationFile: null,
        message: 'No conversation files found'
      },
      status: 200
    }
  }

  const currentConversation = files[0]

  // Read and parse the JSONL file
  const fileContent = fs.readFileSync(currentConversation.path, 'utf-8')
  const lines = fileContent.split('\n').filter(line => line.trim())

  const sinceTime = since ? new Date(since).getTime() : 0
  const messages: any[] = []

  for (const line of lines) {
    try {
      const message = JSON.parse(line)

      if (since && message.timestamp) {
        const msgTime = new Date(message.timestamp).getTime()
        if (msgTime <= sinceTime) continue
      }

      // Extract thinking blocks from assistant messages
      if (message.type === 'assistant' && message.message?.content) {
        const content = message.message.content
        if (Array.isArray(content)) {
          for (const block of content) {
            if (block.type === 'thinking' && block.thinking) {
              messages.push({
                type: 'thinking',
                thinking: block.thinking,
                timestamp: message.timestamp,
                uuid: message.uuid
              })
            }
          }
        }
      }

      messages.push(message)
    } catch {
      // Skip malformed lines
    }
  }

  const limitedMessages = messages.slice(-limit)

  // Read hook state file
  let hookState: any = null
  if (workingDir) {
    const stateDir = path.join(os.homedir(), '.aimaestro', 'chat-state')
    const cwdHash = hashCwd(workingDir)
    const stateFile = path.join(stateDir, `${cwdHash}.json`)

    try {
      if (fs.existsSync(stateFile)) {
        const stateContent = fs.readFileSync(stateFile, 'utf-8')
        hookState = JSON.parse(stateContent)

        const isWaitingState = hookState.status === 'waiting_for_input' || hookState.status === 'permission_request'
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

  // Capture tmux to detect prompts waiting for input
  let terminalPrompt: string | null = null
  let promptType: 'permission' | 'input' | null = null
  const hasOnlineSession = agent.sessions?.some((s: any) => s.status === 'online')
  if (hasOnlineSession) {
    const sessionName = agent.name || agent.alias
    if (sessionName) {
      try {
        const runtime = getRuntime()
        const stdout = await runtime.capturePane(sessionName, 40)
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

  const hasOnlineSession = agent.sessions?.some(s => s.status === 'online')
  if (!hasOnlineSession) {
    return invalidRequest('Agent session is not online')
  }

  const runtime = getRuntime()
  // Exit copy-mode first — sending keys to a copy-mode pane hangs the request
  // and drops the payload (kanban 96d317df). Mirror of the wakeAgent and
  // sessions-service patterns.
  await runtime.cancelCopyMode(sessionName)
  await runtime.sendKeys(sessionName, message, { literal: true, enter: true })

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
 * Four branches:
 *   1. hybrid host    — runtime.cancelCopyMode → runtime.sendKeys('.') → wait → Enter
 *   2. hybrid cloud   — cancelCopyModeInContainer → sendKeysToContainer('.') → wait → Enter
 *   3. legacy host    — runtime.cancelCopyMode → runtime.sendKeys(safeInjection) → wait → Enter
 *   4. legacy cloud   — cancelCopyModeInContainer → sendKeysToContainer(safeInjection) → wait → Enter
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
  const isCloud = agent?.deployment?.type === 'cloud'
  const containerName = isCloud ? agent?.deployment?.cloud?.containerName : undefined

  if (isCloud) {
    if (!containerName) {
      return invalidField('deployment.cloud.containerName', `Cloud agent ${sessionName} has no containerName configured`)
    }
  } else {
    const runtime = getRuntime()
    const exists = await runtime.sessionExists(sessionName)
    if (!exists) {
      return notFound('Session', sessionName)
    }
  }

  // Hybrid path (flag-gated per agent kind): enqueue as structured context and
  // wake-ping with "." + Enter (bare Enter was a no-op in Claude Code). Hook
  // drains on the resulting UserPromptSubmit.
  if (agent && shouldUseAdditionalContext(agent.program)) {
    enqueueForSession(sessionName, body.injection)
    if (isCloud && containerName) {
      await cancelCopyModeInContainer(containerName, sessionName)
      await sendKeysToContainer(containerName, sessionName, '.', { literal: true, enter: false })
      await new Promise(r => setTimeout(r, 100))
      await sendKeysToContainer(containerName, sessionName, '', { literal: false, enter: true })
    } else {
      const runtime = getRuntime()
      await runtime.cancelCopyMode(sessionName)
      await runtime.sendKeys(sessionName, '.', { literal: true, enter: false })
      await new Promise(r => setTimeout(r, 100))
      await runtime.sendKeys(sessionName, '', { literal: false, enter: true })
    }
    console.log(`[Inject Service] queued + wake-pinged ${sessionName} (${agent.program}${isCloud ? ', cloud' : ''})`)
    return { data: { success: true, queued: true }, status: 200 }
  }

  // Legacy path: send the injection as an explicit bracketed-paste block
  // (ESC[200~…ESC[201~) so Codex/Gemini close their paste-receive window on
  // the 201~ marker before our trailing Enter lands.
  const safeInjection = wrapAsBracketedPaste(sanitizeForRawInject(String(body.injection)))
  if (isCloud && containerName) {
    await cancelCopyModeInContainer(containerName, sessionName)
    await sendKeysToContainer(containerName, sessionName, safeInjection, { literal: true, enter: false })
    await new Promise(r => setTimeout(r, 500))
    await sendKeysToContainer(containerName, sessionName, '', { literal: false, enter: true })
  } else {
    const runtime = getRuntime()
    await runtime.cancelCopyMode(sessionName)
    await runtime.sendKeys(sessionName, safeInjection, { literal: true, enter: false })
    await new Promise(r => setTimeout(r, 500))
    await runtime.sendKeys(sessionName, '', { literal: false, enter: true })
  }
  console.log(`[Inject Service] injected meeting prompt into ${sessionName}${isCloud ? ' (cloud)' : ''}`)
  return { data: { success: true, injected: true }, status: 200 }
}
