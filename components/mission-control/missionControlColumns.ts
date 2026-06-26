import type { TaskStatus, TaskWithDeps } from '@/types/task'
import type { TeamTaskSummary } from '@/types/team'

/**
 * Mission Control matrix column configuration.
 *
 * Rows are teams (one orchestrator each); columns are the ACTIVE task statuses
 * shown at a glance. `completed` is deliberately HIDDEN from the live view (done
 * work is not an at-a-glance need — see the Mission Control design).
 *
 * `needs_input` is the agent-declared "I am parked, I need the operator" status
 * (the NEEDS-YOU attention column) — landed by P1c (#276). It is the only status
 * that warrants a proactive operator ping; the dependency-derived `isBlocked`
 * flag is NOT an alarm and never surfaces here.
 */
export interface MissionControlColumn {
  /** Task status this column collects. */
  key: TaskStatus
  /** Header label shown in the matrix. */
  label: string
  /** Attention column — the agent-declared block that the operator must handle. */
  attention?: boolean
  /**
   * Emphasized column — what the operator actively scans ("what is moving" /
   * "what needs me"). Context columns (Backlog/To-Do/Review) are de-emphasized
   * so the eye lands on In Progress + NEEDS-YOU first. (design default —
   * tune against the live render.)
   */
  emphasis?: boolean
}

export const MISSION_CONTROL_COLUMNS: MissionControlColumn[] = [
  { key: 'backlog', label: 'Backlog' },
  { key: 'pending', label: 'To-Do' },
  { key: 'in_progress', label: 'In Progress', emphasis: true },
  { key: 'needs_input', label: 'NEEDS-YOU', attention: true, emphasis: true },
  { key: 'review', label: 'Review' },
]

/** The status that lights a row/agent red (agent-declared block). */
export const ATTENTION_STATUS: TaskStatus = 'needs_input'

// Pure data helpers (no React) so the matrix logic is unit-testable independent
// of the view. Imported by TeamRow.

/**
 * Bucket tasks into the mission-control columns. Any status NOT in
 * MISSION_CONTROL_COLUMNS (notably `completed`) is dropped from the live view.
 */
export function groupTasksByColumn(tasks: TaskWithDeps[]): Record<string, TaskWithDeps[]> {
  const map: Record<string, TaskWithDeps[]> = {}
  for (const col of MISSION_CONTROL_COLUMNS) map[col.key] = []
  for (const t of tasks) {
    const bucket = map[t.status]
    if (bucket) bucket.push(t)
  }
  return map
}

/**
 * A team needs the operator when it holds at least one agent-declared
 * (needs_input) task. Dependency-blocked tasks (task.isBlocked / blockedBy) do
 * NOT count — that is routine queueing, not an operator alarm.
 */
export function teamNeedsAttention(grouped: Record<string, TaskWithDeps[]>): boolean {
  return (grouped[ATTENTION_STATUS]?.length ?? 0) > 0
}

/**
 * Summary-level twin of {@link teamNeedsAttention} for the cross-host read model:
 * a team needs the operator iff its rolled-up needs_input count is non-zero. This
 * is the path the live matrix uses (it renders from the synced TeamTaskSummary,
 * not from per-team task arrays). A missing summary is treated as "no alarm".
 */
export function summaryNeedsAttention(summary?: TeamTaskSummary): boolean {
  return (summary?.needsYouCount ?? 0) > 0
}
