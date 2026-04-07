/**
 * Meeting Router — @mention parsing, agent targeting, and loop guard
 *
 * Determines which agents should be triggered when a message is posted
 * to a meeting chat. Supports @agent-name mentions, @all broadcast,
 * and a hop-based loop guard to prevent runaway agent chains.
 *
 * Design: All messages are VISIBLE to all participants in the shared timeline.
 * @mentions control which agents get tmux INJECTION (prompted to respond).
 * Unaddressed messages are seen by everyone but trigger no one.
 */

import { getMeeting, updateMeeting } from './meeting-registry'
import { getAgent, getAgentByName, loadAgents } from './agent-registry'
import { getAllDirectoryEntries, lookupAgentById } from './agent-directory'
import type { Meeting, LoopGuardState } from '@/types/team'

const DEFAULT_MAX_HOPS = 6

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ParsedMentions {
  mentionedNames: string[]     // Raw @mention strings found (lowercased)
  isAll: boolean               // Whether @all was mentioned
  isContinue: boolean          // Whether /continue command was detected
  cleanedText: string          // Message text with @mentions stripped for display
}

export interface RoutingResult {
  targetAgentIds: string[]     // Agent UUIDs to inject prompt into
  blocked: boolean             // True if loop guard blocked this message
  reason?: string              // Why routing was blocked (for UI display)
  hopCount: number             // Current hop count after this message
}

export interface RouterContext {
  meetingId: string
  senderId: string             // Agent UUID or 'maestro' for human
  senderName: string           // Agent name or operator name
  isHuman: boolean             // True if from the human operator
  messageText: string
}

// ─── @Mention Parsing ────────────────────────────────────────────────────────

/**
 * Parse @mentions and /commands from message text.
 *
 * Supports:
 * - @agent-name (matched against meeting participant names)
 * - @all (triggers all participants except sender)
 * - /continue (resets loop guard and resumes paused conversation)
 */
export function parseMentions(text: string): ParsedMentions {
  const isContinue = /^\/continue\b/i.test(text.trim())

  // Match @word patterns (agent names can have hyphens, underscores, dots)
  const mentionPattern = /@([\w.-]+)/g
  const mentions: string[] = []
  let isAll = false
  let match: RegExpExecArray | null

  while ((match = mentionPattern.exec(text)) !== null) {
    const name = match[1].toLowerCase()
    if (name === 'all') {
      isAll = true
    } else {
      mentions.push(name)
    }
  }

  // Strip @mentions from display text
  const cleanedText = text
    .replace(/@[\w.-]+/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()

  return {
    mentionedNames: mentions,
    isAll,
    isContinue,
    cleanedText: cleanedText || text.trim(),
  }
}

// ─── Agent Resolution ────────────────────────────────────────────────────────

/**
 * Resolve @mention names to agent UUIDs within a meeting's participant list.
 * Only resolves to agents that are actually in the meeting.
 *
 * Searches local registry first, then falls back to the agent directory
 * (which includes remote agents synced from peer mesh nodes).
 */
function resolveAgentIds(
  mentionedNames: string[],
  meetingAgentIds: string[]
): string[] {
  const resolved: string[] = []
  const meetingAgentSet = new Set(meetingAgentIds)

  // Build a combined lookup from local agents + agent directory
  const allAgents = loadAgents()
  const directoryEntries = getAllDirectoryEntries()

  for (const name of mentionedNames) {
    // Try exact name match from local registry
    const agent = getAgentByName(name)
    if (agent && meetingAgentSet.has(agent.id)) {
      resolved.push(agent.id)
      continue
    }

    // Try partial match against local meeting participants (name + label)
    let found = false
    for (const a of allAgents) {
      if (meetingAgentSet.has(a.id)) {
        const agentName = (a.name || '').toLowerCase()
        const agentLabel = (a.label || '').toLowerCase()
        if (agentName === name || agentLabel === name ||
            agentName.endsWith(name) || agentLabel.endsWith(name)) {
          resolved.push(a.id)
          found = true
          break
        }
      }
    }
    if (found) continue

    // Fallback: search the agent directory (includes remote mesh agents)
    // Build a name/label → agentId map from directory entries for meeting participants
    for (const agentId of meetingAgentIds) {
      const dirEntry = lookupAgentById(agentId)
      if (!dirEntry) continue
      const entryName = dirEntry.name.toLowerCase()
      const entryLabel = (dirEntry.label || '').toLowerCase()
      if (entryName === name || entryLabel === name ||
          entryName.endsWith(name) || entryLabel.endsWith(name)) {
        resolved.push(agentId)
        found = true
        break
      }
    }
  }

  return [...new Set(resolved)]
}

// ─── Loop Guard ──────────────────────────────────────────────────────────────

function getLoopGuardState(meeting: Meeting): LoopGuardState {
  return meeting.loopGuardState || {
    hopCount: 0,
    paused: false,
    lastResetAt: meeting.startedAt,
  }
}

function getMaxHops(meeting: Meeting): number {
  return meeting.loopGuardConfig?.maxHops ?? DEFAULT_MAX_HOPS
}

/**
 * Reset the loop guard (called on human message or /continue)
 */
export function resetLoopGuard(meetingId: string): LoopGuardState | null {
  const meeting = getMeeting(meetingId)
  if (!meeting) return null

  const newState: LoopGuardState = {
    hopCount: 0,
    paused: false,
    lastResetAt: new Date().toISOString(),
  }

  updateMeeting(meetingId, { loopGuardState: newState } as any)
  console.log(`[MeetingRouter] Loop guard reset for meeting ${meetingId}`)
  return newState
}

/**
 * Increment the hop counter (called on agent-originated message)
 * Returns the new state and whether the guard has tripped
 */
function incrementHop(meeting: Meeting): { state: LoopGuardState; tripped: boolean } {
  const state = getLoopGuardState(meeting)
  const maxHops = getMaxHops(meeting)

  const newState: LoopGuardState = {
    ...state,
    hopCount: state.hopCount + 1,
    lastHopAt: new Date().toISOString(),
    paused: state.hopCount + 1 >= maxHops,
  }

  updateMeeting(meeting.id, { loopGuardState: newState } as any)

  if (newState.paused) {
    console.log(`[MeetingRouter] Loop guard TRIPPED for meeting ${meeting.id} at ${newState.hopCount} hops (max: ${maxHops})`)
  }

  return { state: newState, tripped: newState.paused }
}

// ─── Main Router ─────────────────────────────────────────────────────────────

/**
 * Route a meeting message: determine which agents to trigger.
 *
 * Rules:
 * 1. Human messages always pass through and reset the loop guard
 * 2. /continue resets the loop guard and resumes
 * 3. Agent messages increment the hop counter
 * 4. If loop guard is tripped, agent messages are blocked
 * 5. @mentions target specific agents
 * 6. @all targets all meeting participants except sender
 * 7. No @mention = visible to all but triggers no one
 * 8. Sender is always excluded from targets
 */
export function routeMessage(ctx: RouterContext): RoutingResult {
  const meeting = getMeeting(ctx.meetingId)
  if (!meeting) {
    return { targetAgentIds: [], blocked: true, reason: 'Meeting not found', hopCount: 0 }
  }

  const parsed = parseMentions(ctx.messageText)
  const guardState = getLoopGuardState(meeting)

  // /continue command: reset guard and resume
  if (parsed.isContinue) {
    resetLoopGuard(ctx.meetingId)
    return {
      targetAgentIds: [],
      blocked: false,
      reason: 'Loop guard reset — conversation resumed',
      hopCount: 0,
    }
  }

  // Human messages: always pass through, reset guard
  if (ctx.isHuman) {
    resetLoopGuard(ctx.meetingId)

    // Resolve targets from @mentions
    // Human messages without @mentions default to @all — the operator
    // almost always wants everyone to see and respond to their message.
    let targetIds: string[] = []
    if (parsed.isAll || parsed.mentionedNames.length === 0) {
      // @all or no mentions: trigger all agents except sender
      targetIds = meeting.agentIds.filter(id => id !== ctx.senderId)
    } else {
      targetIds = resolveAgentIds(parsed.mentionedNames, meeting.agentIds)
    }

    return {
      targetAgentIds: targetIds,
      blocked: false,
      hopCount: 0,
    }
  }

  // Agent messages: check loop guard
  if (guardState.paused) {
    return {
      targetAgentIds: [],
      blocked: true,
      reason: `Loop guard active (${guardState.hopCount} hops). Human must send /continue to resume.`,
      hopCount: guardState.hopCount,
    }
  }

  // Increment hop counter
  const { state: newState, tripped } = incrementHop(meeting)

  if (tripped) {
    return {
      targetAgentIds: [],
      blocked: true,
      reason: `Loop guard tripped at ${newState.hopCount} hops. Human must send /continue to resume.`,
      hopCount: newState.hopCount,
    }
  }

  // Resolve targets from @mentions
  let targetIds: string[] = []
  if (parsed.isAll) {
    targetIds = meeting.agentIds.filter(id => id !== ctx.senderId)
  } else if (parsed.mentionedNames.length > 0) {
    targetIds = resolveAgentIds(parsed.mentionedNames, meeting.agentIds)
      .filter(id => id !== ctx.senderId)
  }
  // No @mentions from agent = visible to all, triggers nobody

  return {
    targetAgentIds: targetIds,
    blocked: false,
    hopCount: newState.hopCount,
  }
}

/**
 * Get the current loop guard status for a meeting (for UI display)
 */
export function getLoopGuardStatus(meetingId: string): {
  hopCount: number
  maxHops: number
  paused: boolean
} | null {
  const meeting = getMeeting(meetingId)
  if (!meeting) return null

  const state = getLoopGuardState(meeting)
  return {
    hopCount: state.hopCount,
    maxHops: getMaxHops(meeting),
    paused: state.paused,
  }
}
