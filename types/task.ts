/**
 * Task types for the Shared Task List feature
 *
 * Tasks belong to teams and support dependency chains
 * with auto-unblocking when dependencies complete.
 */

// 'needs_input' = orchestrator-declared "needs a human decision" (Mission Control's
// NEEDS-YOU attention state). Distinct from the dependency-derived `isBlocked` flag
// (TaskWithDeps.isBlocked) — that is task-waits-on-task and never surfaces as the red
// attention column. needs_input is the only status that warrants a proactive operator ping.
export type TaskStatus = 'backlog' | 'pending' | 'in_progress' | 'needs_input' | 'review' | 'completed'

export interface Task {
  id: string                     // UUID
  teamId: string                 // Team this task belongs to
  subject: string                // "Implement user auth endpoint"
  description?: string           // Detailed description / acceptance criteria
  status: TaskStatus
  assigneeAgentId?: string | null
  blockedBy: string[]            // Task IDs that must complete first
  priority?: number              // 0=highest (optional ordering)
  createdAt: string
  updatedAt: string
  startedAt?: string
  completedAt?: string
}

export interface TaskWithDeps extends Task {
  blocks: string[]               // Derived: task IDs this blocks (computed on read)
  isBlocked: boolean             // true if any blockedBy task not completed
  assigneeName?: string          // Resolved agent display name
}

export interface TasksFile {
  version: 1
  tasks: Task[]
}
