'use client'

import AgentBadge from '@/components/AgentBadge'
import {
  MISSION_CONTROL_COLUMNS,
  summaryNeedsAttention,
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
 * remaining cells show that team's per-status task COUNTS.
 *
 * P2b: counts come from the synced `team.taskSummary` (the cross-host read
 * model) — NOT a per-team task poll. The page does one aggregate poll for every
 * team's summary, so a 30-team mesh is one request, not 30. PURE READ.
 */
export default function TeamRow({ team, orchestrator }: TeamRowProps) {
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

      {/* Status columns — one count cell per active status */}
      {MISSION_CONTROL_COLUMNS.map(col => {
        const count = summary?.counts[col.key] ?? 0
        const litRed = col.attention && count > 0
        // Attention-red wins; else context columns recede behind the emphasized ones.
        const cellBg = litRed ? 'bg-red-950/40' : col.emphasis ? '' : 'bg-slate-950/40'
        return (
          <div
            key={col.key}
            className={`flex-1 min-w-[180px] p-2 border-r border-slate-800 flex items-center justify-center ${cellBg}`}
          >
            <CountCell count={count} attention={!!col.attention} emphasis={!!col.emphasis} />
          </div>
        )
      })}
    </div>
  )
}

/**
 * A single status count. Zero recedes to a faint dash so the eye lands on the
 * columns that actually hold work; a lit NEEDS-YOU count goes red.
 */
function CountCell({ count, attention, emphasis }: { count: number; attention: boolean; emphasis: boolean }) {
  if (count === 0) {
    return <span className="text-slate-700 text-lg leading-none select-none">·</span>
  }
  const tone = attention
    ? 'bg-red-500/20 text-red-300 border-red-500/40'
    : emphasis
      ? 'bg-slate-700/60 text-slate-100 border-slate-600'
      : 'bg-slate-800/60 text-slate-400 border-slate-700'
  return (
    <span className={`min-w-[2rem] px-2 py-1 rounded-lg border text-center text-base font-bold tabular-nums ${tone}`}>
      {count}
    </span>
  )
}
