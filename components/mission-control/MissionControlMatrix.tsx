'use client'

import TeamRow from './TeamRow'
import { MISSION_CONTROL_COLUMNS } from './missionControlColumns'
import type { Team } from '@/types/team'
import type { Agent } from '@/types/agent'

interface MissionControlMatrixProps {
  teams: Team[]
  /** Agent lookup by id, for resolving each team's orchestrator (chiefOfStaffId). */
  agentsById: Record<string, Agent>
}

/**
 * The mission-control matrix: team rows × active-status columns. The header row
 * uses the same flex widths as TeamRow so columns stay aligned. House-component
 * styling only (slate/gray, Space Grotesk) — no Stitch neon theme.
 */
export default function MissionControlMatrix({ teams, agentsById }: MissionControlMatrixProps) {
  return (
    <div className="min-w-[1100px]">
      {/* Column header row */}
      <div className="flex border-b border-slate-700 bg-slate-900/90 sticky top-0 z-10">
        <div className="w-60 flex-shrink-0 px-3 py-2 border-r border-slate-800">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Team / Orchestrator
          </span>
        </div>
        {MISSION_CONTROL_COLUMNS.map(col => (
          <div
            key={col.key}
            className={`flex-1 min-w-[180px] px-3 py-2 border-r border-slate-800 ${
              col.emphasis ? '' : 'bg-slate-950/40'
            }`}
          >
            <span
              className={`text-[11px] font-semibold uppercase tracking-wider ${
                col.attention
                  ? 'text-red-400'
                  : col.emphasis
                    ? 'text-slate-200'
                    : 'text-slate-500'
              }`}
            >
              {col.label}
            </span>
          </div>
        ))}
      </div>

      {/* Team rows */}
      {teams.map(team => (
        <TeamRow
          key={team.id}
          team={team}
          orchestrator={team.chiefOfStaffId ? agentsById[team.chiefOfStaffId] : undefined}
        />
      ))}

      {teams.length === 0 && (
        <div className="p-12 text-center text-slate-500">No teams found.</div>
      )}
    </div>
  )
}
