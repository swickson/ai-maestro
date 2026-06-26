'use client'

import { useEffect, useState } from 'react'
import MissionControlMatrix from '@/components/mission-control/MissionControlMatrix'
import type { Team } from '@/types/team'
import type { Agent } from '@/types/agent'

/**
 * Mission Control — single pane of glass over every team.
 *
 * One row per team (the orchestrator is its face), active tasks spread across
 * status columns, a red row when a lead has declared a block. PURE READ: this
 * pane observes; it never writes the kanban and never pings Teams (the
 * orchestrator does both in its own workflow — the Mission Control design).
 *
 * P1b scaffold: this-host teams only. Cross-host fan-in is P2 (poll-sync).
 */
export default function MissionControlPage() {
  const [teams, setTeams] = useState<Team[]>([])
  const [agentsById, setAgentsById] = useState<Record<string, Agent>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const [teamsRes, agentsRes] = await Promise.all([
          fetch('/api/teams'),
          fetch('/api/agents'),
        ])
        if (!teamsRes.ok) throw new Error('Failed to load teams')
        if (!agentsRes.ok) throw new Error('Failed to load agents')

        const teamsData = await teamsRes.json()
        const agentsData = await agentsRes.json()
        if (cancelled) return

        setTeams(teamsData.teams || [])
        const map: Record<string, Agent> = {}
        for (const a of (agentsData.agents || []) as Agent[]) map[a.id] = a
        setAgentsById(map)
        setError(null)
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load')
      } finally {
        if (!cancelled) setLoading(false)
      }
    }

    load()
    // Roster refreshes slowly; per-team task state polls at 5s inside each row.
    const interval = setInterval(load, 30000)
    return () => {
      cancelled = true
      clearInterval(interval)
    }
  }, [])

  return (
    <div className="h-screen flex flex-col bg-slate-950 text-slate-100">
      <header className="flex-shrink-0 px-6 py-4 border-b border-slate-800">
        <h1 className="text-2xl font-bold tracking-tight">Mission Control</h1>
        <p className="text-sm text-slate-400 mt-0.5">
          One row per team · the orchestrator is its face · red = a lead needs you
        </p>
      </header>

      <main className="flex-1 overflow-auto">
        {loading ? (
          <div className="p-12 text-center text-slate-500">Loading teams…</div>
        ) : error ? (
          <div className="p-12 text-center text-red-400">{error}</div>
        ) : (
          <MissionControlMatrix teams={teams} agentsById={agentsById} />
        )}
      </main>
    </div>
  )
}
