/**
 * Meeting Presence — Agent status tracking for active meetings
 *
 * Watches agent session activity and posts system messages to the
 * meeting chat when agents join/leave or change status. Surfaces
 * idle/active/working states for the meeting UI.
 */

import { getMeeting, loadMeetings } from './meeting-registry'
import { postChatMessage } from './meeting-chat-service'
import { sessionActivity } from '@/services/shared-state'

// ─── Types ───────────────────────────────────────────────────────────────────

export interface AgentPresence {
  agentId: string
  agentName: string
  status: 'online' | 'idle' | 'active' | 'working' | 'offline'
  lastActivity?: string  // ISO timestamp
  lastStatusChange?: string
}

export interface MeetingPresenceState {
  meetingId: string
  agents: Record<string, AgentPresence>
  lastUpdated: string
}

// ─── In-memory presence tracking ─────────────────────────────────────────────

const presenceByMeeting = new Map<string, MeetingPresenceState>()

// Track previous status to detect changes
const previousStatus = new Map<string, string>() // agentId -> last known status

/**
 * Get the current presence state for a meeting.
 */
export function getMeetingPresence(meetingId: string): MeetingPresenceState | null {
  return presenceByMeeting.get(meetingId) || null
}

/**
 * Update agent presence for all active meetings.
 * Called periodically by the presence polling loop.
 *
 * @param agentStatuses - Map of sessionName -> { status, hookStatus }
 */
export function updatePresence(
  agentStatuses: Map<string, { status: string; hookStatus?: string }>
): void {
  const activeMeetings = loadMeetings().filter(m => m.status === 'active')

  for (const meeting of activeMeetings) {
    let state = presenceByMeeting.get(meeting.id)
    if (!state) {
      state = {
        meetingId: meeting.id,
        agents: {},
        lastUpdated: new Date().toISOString(),
      }
      presenceByMeeting.set(meeting.id, state)
    }

    for (const agentId of meeting.agentIds) {
      // Find the agent's session by checking all statuses
      let agentStatus: 'online' | 'idle' | 'active' | 'working' | 'offline' = 'offline'
      let agentName = agentId
      let lastActivityTs: string | undefined

      for (const [sessionName, statusInfo] of agentStatuses.entries()) {
        // Check if this session belongs to this agent
        // Sessions are named after agents (e.g., dev-aimaestro-admin)
        const activity = sessionActivity.get(sessionName)
        if (activity) {
          lastActivityTs = new Date(activity).toISOString()
        }

        // Map hook status to presence status
        if (statusInfo.hookStatus === 'waiting_for_input' || statusInfo.hookStatus === 'permission_request') {
          agentStatus = 'idle'
        } else if (statusInfo.status === 'active') {
          agentStatus = 'working'
        } else {
          agentStatus = 'online'
        }
        agentName = sessionName
      }

      const prevStatus = previousStatus.get(agentId)
      const currentStatus = agentStatus

      // Detect status changes and post system messages
      if (prevStatus && prevStatus !== currentStatus) {
        if (prevStatus === 'offline' && currentStatus !== 'offline') {
          // Agent came online — post join notification
          postSystemMessage(meeting.id, `${agentName} joined the meeting`)
        } else if (prevStatus !== 'offline' && currentStatus === 'offline') {
          // Agent went offline — post leave notification
          postSystemMessage(meeting.id, `${agentName} left the meeting`)
        }
      }

      previousStatus.set(agentId, currentStatus)

      state.agents[agentId] = {
        agentId,
        agentName,
        status: agentStatus,
        lastActivity: lastActivityTs,
        lastStatusChange: prevStatus !== currentStatus
          ? new Date().toISOString()
          : state.agents[agentId]?.lastStatusChange,
      }
    }

    state.lastUpdated = new Date().toISOString()
  }
}

/**
 * Post a system message to a meeting's shared timeline.
 */
function postSystemMessage(meetingId: string, text: string): void {
  try {
    postChatMessage({
      meetingId,
      from: 'system',
      fromAlias: 'System',
      fromType: 'agent',
      message: text,
    })

    // Broadcast via WebSocket if available
    const g = globalThis as Record<string, unknown>
    if (typeof g.__meetingChatBroadcast === 'function') {
      (g.__meetingChatBroadcast as (id: string, msg: unknown) => void)(meetingId, {
        id: `system-${Date.now()}`,
        from: 'system',
        fromAlias: 'System',
        fromType: 'system',
        message: text,
        timestamp: new Date().toISOString(),
        mentions: [],
        mentionAll: false,
      })
    }
  } catch {
    // Non-fatal — presence notifications are best-effort
  }
}

/**
 * Clean up presence state when a meeting ends.
 */
export function clearMeetingPresence(meetingId: string): void {
  presenceByMeeting.delete(meetingId)
}
