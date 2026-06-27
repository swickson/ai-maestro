/**
 * Team types for the Team Meeting feature
 *
 * Teams represent groups of agents that can be assembled into
 * a "war room" for multi-agent coordination sessions.
 *
 * Team types:
 * - open (default): No messaging restrictions. Backward compatible.
 * - closed: Isolated messaging. External messages routed through the
 *   chief-of-staff. Agents can only message teammates + COS + manager.
 */

import type { TaskStatus } from '@/types/task'

/**
 * Team communication type
 * - open: No restrictions, any agent can message team members (default, backward compat)
 * - closed: Isolated — messages from outside the team are routed through the chief-of-staff
 */
export type TeamType = 'open' | 'closed'

/**
 * Rolled-up task state for a team — the cross-host Mission Control read model.
 *
 * Task files (~/.aimaestro/teams/tasks-<id>.json) are NOT synced across the mesh;
 * only the owning host can read a team's tasks. So the owning host computes this
 * summary and attaches it to the Team object, which DOES ride the team-directory
 * sync. A remote host then renders each team's task state from counts alone —
 * no per-team task fetch, and one poll covers every team (Mission Control P2b).
 */
export interface TeamTaskSummary {
  /** Count of tasks in each status (all six statuses always present, 0 if none). */
  counts: Record<TaskStatus, number>
  /** Total task count across all statuses. */
  total: number
  /** counts.needs_input — the agent-declared "operator must act" count (NEEDS-YOU). */
  needsYouCount: number
  /**
   * The headline ("top") task for each ACTIVE status column on the Mission
   * Control matrix — one card per column (backlog/pending/in_progress/
   * needs_input/review), bounded to ≤5 per team. Each column renders its top
   * card + a "+N" for the rest of that column (counts[status] - 1). Carries
   * assigneeId only; the viewing host resolves the assignee avatar at render
   * from the federated agent directory (#286-synced), so the real face shows
   * even for a remote team's assignee. `completed` is never represented.
   */
  topTaskByStatus?: Partial<Record<TaskStatus, TopTask>>
}

/**
 * The headline task shown on one column's Mission Control card. Selection
 * (see selectTopTaskPerStatus): within a status, lowest `priority` number
 * (0 = highest), tie-broken by most-recently-updated.
 */
export interface TopTask {
  id: string
  subject: string
  status: TaskStatus
  assigneeId: string | null
  priority?: number
}

export interface Team {
  id: string              // UUID
  name: string            // "Backend Squad"
  description?: string
  agentIds: string[]      // Agent UUIDs (order = display order)
  instructions?: string   // Team-level markdown (like a per-team CLAUDE.md)
  type?: TeamType         // 'open' (default) or 'closed' (isolated messaging)
  chiefOfStaffId?: string // Agent ID of the chief-of-staff (required for closed teams)
  createdAt: string       // ISO
  updatedAt: string       // ISO
  lastMeetingAt?: string  // ISO - last time a meeting was started with this team
  lastActivityAt?: string // ISO - updated on any team interaction
  hostId?: string         // Host that owns this team (set on creation, used for mesh sync)
  source?: 'local' | 'remote'  // Runtime only — not persisted, set during sync
  taskSummary?: TeamTaskSummary  // Runtime only — not persisted; computed on the owning host, rides the directory sync
}

export interface TeamsFile {
  version: 1 | 2
  teams: Team[]
}

/** Meeting status for persistent rooms */
export type MeetingStatus = 'active' | 'ended'

/** Loop guard configuration for meeting chat */
export interface LoopGuardConfig {
  maxHops: number               // Max agent-to-agent hops before pausing (default: 6)
  enabled: boolean              // Whether loop guard is active
}

/** Loop guard runtime state */
export interface LoopGuardState {
  hopCount: number              // Current hop count in the chain
  paused: boolean               // Whether the guard has paused the conversation
  lastResetAt: string           // ISO — when the counter was last reset (by human message)
  lastHopAt?: string            // ISO — when the last agent hop occurred
}

/** Persistent meeting record */
export interface Meeting {
  id: string                    // UUID
  teamId: string | null         // Link to team for task persistence
  name: string                  // Display name
  agentIds: string[]            // Participating agent UUIDs
  status: MeetingStatus
  activeAgentId: string | null  // Last-viewed agent
  sidebarMode: SidebarMode
  startedAt: string             // ISO
  lastActiveAt: string          // ISO
  endedAt?: string              // ISO (when ended)
  loopGuardConfig?: LoopGuardConfig   // Chat loop guard settings
  loopGuardState?: LoopGuardState     // Chat loop guard runtime state
  operatorId?: string           // Human operator identifier (e.g. 'operator')
  operatorName?: string         // Human operator display name (e.g. 'the operator')
}

export interface MeetingsFile {
  version: 1
  meetings: Meeting[]
}

/** State machine states for team meeting */
export type MeetingPhase = 'idle' | 'selecting' | 'ringing' | 'active'

/** Sidebar display mode during active meeting */
export type SidebarMode = 'grid' | 'list'

/** Right panel tab for active meetings */
export type RightPanelTab = 'tasks' | 'chat'

/** State for the team meeting page */
export interface TeamMeetingState {
  phase: MeetingPhase
  selectedAgentIds: string[]
  teamName: string
  notifyAmp: boolean
  activeAgentId: string | null
  joinedAgentIds: string[]
  sidebarMode: SidebarMode
  meetingId: string | null
  rightPanelOpen: boolean
  rightPanelTab: RightPanelTab
  kanbanOpen: boolean
  chatOpen: boolean
}

/** Actions for the team meeting reducer */
export type TeamMeetingAction =
  | { type: 'SELECT_AGENT'; agentId: string }
  | { type: 'DESELECT_AGENT'; agentId: string }
  | { type: 'LOAD_TEAM'; agentIds: string[]; teamName: string }
  | { type: 'START_MEETING' }
  | { type: 'AGENT_JOINED'; agentId: string }
  | { type: 'ALL_JOINED' }
  | { type: 'END_MEETING' }
  | { type: 'SET_ACTIVE_AGENT'; agentId: string }
  | { type: 'TOGGLE_SIDEBAR_MODE' }
  | { type: 'SET_TEAM_NAME'; name: string }
  | { type: 'SET_NOTIFY_AMP'; enabled: boolean }
  | { type: 'ADD_AGENT'; agentId: string }
  | { type: 'REMOVE_AGENT'; agentId: string }
  | { type: 'TOGGLE_RIGHT_PANEL' }
  | { type: 'SET_RIGHT_PANEL_TAB'; tab: RightPanelTab }
  | { type: 'OPEN_RIGHT_PANEL'; tab: RightPanelTab }
  | { type: 'OPEN_KANBAN' }
  | { type: 'CLOSE_KANBAN' }
  | { type: 'OPEN_CHAT' }
  | { type: 'CLOSE_CHAT' }
  | { type: 'RESTORE_MEETING'; meeting: Meeting; teamId: string | null }
