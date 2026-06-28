/**
 * Unit coverage for the Mission Control matrix data helpers
 * (components/mission-control/missionControlColumns.ts).
 *
 * These pure functions back the P1b matrix view:
 * rows = teams, active tasks spread across status columns, a red row when a
 * lead has declared a block. The view-independent rules under test:
 *   - tasks bucket into exactly the active columns (Backlog/To-Do/In Progress/
 *     NEEDS-YOU/Review); `completed` is dropped from the live view.
 *   - needs_input lands in the NEEDS-YOU attention column.
 *   - a team needs the operator iff it holds a needs_input task — dependency
 *     blocking (isBlocked) does NOT raise the alarm.
 */

import { describe, expect, it } from 'vitest'
import {
  MISSION_CONTROL_COLUMNS,
  ATTENTION_STATUS,
  groupTasksByColumn,
  teamNeedsAttention,
  summaryNeedsAttention,
  columnCellMode,
} from '@/components/mission-control/missionControlColumns'
import type { TaskWithDeps } from '@/types/task'
import type { TeamTaskSummary } from '@/types/team'

// Minimal TaskWithDeps factory — only fields the helpers read matter.
function task(id: string, status: string, extra: Partial<TaskWithDeps> = {}): TaskWithDeps {
  return {
    id,
    teamId: 'team-1',
    subject: `task ${id}`,
    description: '',
    status: status as TaskWithDeps['status'],
    assigneeAgentId: null,
    blockedBy: [],
    priority: 0,
    createdAt: 0,
    updatedAt: 0,
    isBlocked: false,
    ...extra,
  } as TaskWithDeps
}

describe('mission-control column config', () => {
  it('exposes exactly the 5 active columns, completed hidden', () => {
    const keys = MISSION_CONTROL_COLUMNS.map(c => c.key)
    expect(keys).toEqual(['backlog', 'pending', 'in_progress', 'needs_input', 'review'])
    expect(keys).not.toContain('completed')
  })

  it('marks NEEDS-YOU as the attention column and emphasizes the scan columns', () => {
    const attention = MISSION_CONTROL_COLUMNS.filter(c => c.attention).map(c => c.key)
    expect(attention).toEqual([ATTENTION_STATUS])
    const emphasized = MISSION_CONTROL_COLUMNS.filter(c => c.emphasis).map(c => c.key)
    expect(emphasized).toEqual(['in_progress', 'needs_input'])
  })
})

describe('groupTasksByColumn', () => {
  it('buckets each task into its status column', () => {
    const grouped = groupTasksByColumn([
      task('a', 'backlog'),
      task('b', 'in_progress'),
      task('c', 'in_progress'),
      task('d', 'review'),
    ])
    expect(grouped.backlog.map(t => t.id)).toEqual(['a'])
    expect(grouped.in_progress.map(t => t.id)).toEqual(['b', 'c'])
    expect(grouped.review.map(t => t.id)).toEqual(['d'])
    expect(grouped.pending).toEqual([])
  })

  it('drops completed (and any off-matrix status) from the live view', () => {
    const grouped = groupTasksByColumn([
      task('done', 'completed'),
      task('weird', 'archived'),
      task('keep', 'pending'),
    ])
    expect(grouped.pending.map(t => t.id)).toEqual(['keep'])
    expect(Object.values(grouped).flat().map(t => t.id)).toEqual(['keep'])
    expect(grouped).not.toHaveProperty('completed')
  })

  it('buckets needs_input into the attention column', () => {
    const grouped = groupTasksByColumn([task('blk', 'needs_input')])
    expect(grouped[ATTENTION_STATUS].map(t => t.id)).toEqual(['blk'])
  })

  it('always returns an array for every column, even with no tasks', () => {
    const grouped = groupTasksByColumn([])
    for (const col of MISSION_CONTROL_COLUMNS) {
      expect(grouped[col.key]).toEqual([])
    }
  })
})

describe('teamNeedsAttention', () => {
  it('is true when the team holds an agent-declared (needs_input) task', () => {
    const grouped = groupTasksByColumn([task('a', 'in_progress'), task('b', 'needs_input')])
    expect(teamNeedsAttention(grouped)).toBe(true)
  })

  it('is false with only active/queued work', () => {
    const grouped = groupTasksByColumn([task('a', 'in_progress'), task('b', 'backlog')])
    expect(teamNeedsAttention(grouped)).toBe(false)
  })

  it('does NOT raise on dependency-blocked tasks — that is routine queueing, not an alarm', () => {
    const grouped = groupTasksByColumn([
      task('dep', 'pending', { isBlocked: true, blockedBy: ['x'] }),
    ])
    expect(teamNeedsAttention(grouped)).toBe(false)
  })
})

describe('summaryNeedsAttention (cross-host read model)', () => {
  function summary(needsYouCount: number): TeamTaskSummary {
    return {
      counts: { backlog: 0, pending: 0, in_progress: 0, needs_input: needsYouCount, review: 0, completed: 0 },
      total: needsYouCount,
      needsYouCount,
    }
  }

  it('is true when the rolled-up needs_input count is non-zero', () => {
    expect(summaryNeedsAttention(summary(1))).toBe(true)
    expect(summaryNeedsAttention(summary(3))).toBe(true)
  })

  it('is false when no task needs the operator', () => {
    expect(summaryNeedsAttention(summary(0))).toBe(false)
  })

  it('treats a missing summary as no alarm (team not yet synced)', () => {
    expect(summaryNeedsAttention(undefined)).toBe(false)
  })
})

describe('columnCellMode (version-skew graceful degradation)', () => {
  it('renders the card when a top card is present', () => {
    expect(columnCellMode(true, 5)).toBe('card')
    expect(columnCellMode(true, 1)).toBe('card')
  })

  it('renders the COUNT (not empty) when there is work but no top card — the pre-card-stack peer case', () => {
    // A peer on a version that computes counts but NOT topTaskByStatus: during a
    // staggered deploy its synced summary has count>0 with no top card. The cell
    // must show the count, NOT a dot, or active work silently vanishes.
    expect(columnCellMode(false, 3)).toBe('count')
    // The load-bearing review catch: NEEDS-YOU with a count but no top card
    // must NOT render empty (would hide the operator alarm during a rollout).
    expect(columnCellMode(false, 1)).toBe('count')
  })

  it('renders empty only when the column genuinely has no work', () => {
    expect(columnCellMode(false, 0)).toBe('empty')
  })
})
