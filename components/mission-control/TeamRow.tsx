'use client'

import { getAvatarUrl } from '@/lib/hash-utils'
import AgentBadge from '@/components/AgentBadge'
import {
  MISSION_CONTROL_COLUMNS,
  summaryNeedsAttention,
} from './missionControlColumns'
import type { Team, TopTask } from '@/types/team'
import type { Agent } from '@/types/agent'

interface TeamRowProps {
  team: Team
  /** Resolved orchestrator (team.chiefOfStaffId → Agent). Undefined if no lead is set. */
  orchestrator?: Agent
  /** Agent lookup (federated + local) for resolving each top card's assignee avatar. */
  agentsById: Record<string, Agent>
}

const noop = () => {}

/**
 * One mission-control row = one team. Left cell: team name + orchestrator badge.
 * Then one cell per active status column (Backlog/To-Do/In Progress/NEEDS-YOU/
 * Review) — each renders that column's top card (highest-priority task in the
 * status) plus a "+N" for the rest of the column, replacing the bare count
 * badge. PURE READ.
 */
export default function TeamRow({ team, orchestrator, agentsById }: TeamRowProps) {
  const summary = team.taskSummary
  const needsAttention = summaryNeedsAttention(summary)

  return (
    <div className={`flex border-b border-slate-800 ${needsAttention ? 'bg-red-950/30' : ''}`}>
      {/* Profile cell: team name prominent, orchestrator card beneath */}
      <div className="w-60 flex-shrink-0 p-3 border-r border-slate-800">
        <div className="flex items-center justify-between mb-2 gap-2">
          <h2 className="text-sm font-bold tracking-wide text-slate-200 uppercase truncate">
            {team.name}
          </h2>
          {needsAttention && (
            <span className="flex-shrink-0 px-2 py-0.5 rounded-md text-[10px] font-bold bg-red-500/20 text-red-300 border border-red-500/40">
              NEEDS-YOU
            </span>
          )}
        </div>

        {orchestrator ? (
          <AgentBadge agent={orchestrator} isSelected={false} onSelect={noop} showActions={false} />
        ) : (
          <div className="rounded-xl border-2 border-dashed border-slate-700/50 bg-slate-800/30 p-4 text-center">
            <p className="text-xs text-slate-500">No lead set</p>
            <p className="text-[10px] text-slate-600 mt-1">awaiting chiefOfStaffId</p>
          </div>
        )}
      </div>

      {/* One card-stack per active status column */}
      {MISSION_CONTROL_COLUMNS.map(col => {
        const topCard = summary?.topTaskByStatus?.[col.key]
        const count = summary?.counts[col.key] ?? 0
        const remaining = Math.max(0, count - 1)
        const litRed = col.attention && count > 0
        const cellBg = litRed ? 'bg-red-950/40' : col.emphasis ? '' : 'bg-slate-950/40'
        const assignee = topCard?.assigneeId ? agentsById[topCard.assigneeId] : undefined
        return (
          <div
            key={col.key}
            className={`flex-1 min-w-[220px] p-3 border-r border-slate-800 flex items-center ${cellBg}`}
          >
            {topCard ? (
              <TopCardStack task={topCard} assignee={assignee} remaining={remaining} />
            ) : (
              <span className="text-slate-700 text-lg leading-none select-none mx-auto">·</span>
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * The headline card for a column's top task, with offset cards behind it and a
 * "+N" when the column holds more. Fills its column cell. House slate styling.
 */
function TopCardStack({
  task,
  assignee,
  remaining,
}: {
  task: TopTask
  assignee?: Agent
  remaining: number
}) {
  return (
    <div className="relative w-full">
      {/* Stacked cards behind (only when there's more in the column) */}
      {remaining > 0 && (
        <>
          <div className="absolute inset-0 translate-x-1.5 translate-y-1.5 rounded-xl bg-slate-800/40 border border-slate-700/40" />
          {remaining > 1 && (
            <div className="absolute inset-0 translate-x-3 translate-y-3 rounded-xl bg-slate-800/25 border border-slate-700/30" />
          )}
        </>
      )}

      {/* Top card — no status pill (the column header names the status). */}
      <div className="relative w-full rounded-xl border border-slate-600 bg-slate-800/90 p-3 shadow-md">
        <div className="flex items-start justify-between gap-2">
          <p className="text-sm text-slate-100 leading-snug line-clamp-3">{task.subject}</p>
          {assignee && <AssigneeAvatar agent={assignee} />}
        </div>
      </div>

      {/* +N remaining tasks in this column */}
      {remaining > 0 && (
        <span className="absolute -right-2 -top-2 z-10 min-w-[1.5rem] px-1.5 py-0.5 rounded-full bg-blue-500/30 text-blue-200 border border-blue-400/50 text-[11px] font-bold text-center">
          +{remaining}
        </span>
      )}
    </div>
  )
}

/** Small round assignee avatar (real face via #286-synced avatar, else id-hash fallback). */
function AssigneeAvatar({ agent }: { agent: Agent }) {
  const isEmoji = !!agent.avatar && agent.avatar.length <= 4 && !agent.avatar.startsWith('http') && !agent.avatar.startsWith('/')
  const url = agent.avatar && !isEmoji && (agent.avatar.startsWith('http') || agent.avatar.startsWith('/'))
    ? agent.avatar
    : getAvatarUrl(agent.id)
  const label = agent.label || agent.name
  return (
    <div className="flex-shrink-0" title={label}>
      {isEmoji ? (
        <span className="w-6 h-6 rounded-full bg-slate-700 flex items-center justify-center text-sm">{agent.avatar}</span>
      ) : (
        <img src={url} alt={label} className="w-6 h-6 rounded-full object-cover ring-1 ring-slate-600" />
      )}
    </div>
  )
}
