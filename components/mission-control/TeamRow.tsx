'use client'

import { useMemo } from 'react'
import AgentBadge from '@/components/AgentBadge'
import KanbanCard from '@/components/team-meeting/KanbanCard'
import { useTasks } from '@/hooks/useTasks'
import {
  MISSION_CONTROL_COLUMNS,
  groupTasksByColumn,
  teamNeedsAttention,
} from './missionControlColumns'
import type { Team } from '@/types/team'
import type { Agent } from '@/types/agent'

interface TeamRowProps {
  team: Team
  /** Resolved orchestrator (team.chiefOfStaffId → Agent). Undefined until P1a lands or if no lead is set. */
  orchestrator?: Agent
}

const noop = () => {}

/**
 * One mission-control row = one team. Left cell carries the team name
 * prominently with the orchestrator's reused AgentBadge beneath it; the
 * remaining cells spread that team's active tasks across the status columns.
 * PURE READ — every interaction handler is a no-op and AgentBadge actions are off.
 */
export default function TeamRow({ team, orchestrator }: TeamRowProps) {
  const { tasks } = useTasks(team.id)

  const byColumn = useMemo(() => groupTasksByColumn(tasks), [tasks])
  const needsAttention = teamNeedsAttention(byColumn)

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

      {/* Status columns — one cell per active status */}
      {MISSION_CONTROL_COLUMNS.map(col => {
        const cards = byColumn[col.key] ?? []
        const litRed = col.attention && cards.length > 0
        // Attention-red wins; else context columns recede behind the emphasized ones.
        const cellBg = litRed ? 'bg-red-950/40' : col.emphasis ? '' : 'bg-slate-950/40'
        return (
          <div
            key={col.key}
            className={`flex-1 min-w-[180px] p-2 border-r border-slate-800 space-y-2 ${cellBg}`}
          >
            {cards.map(task => (
              <KanbanCard key={task.id} task={task} onSelect={noop} />
            ))}
          </div>
        )
      })}
    </div>
  )
}
