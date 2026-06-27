'use client'

import { useEffect, useState } from 'react'
import MissionControlMatrix from '@/components/mission-control/MissionControlMatrix'
import type { Team } from '@/types/team'
import type { Agent } from '@/types/agent'

/**
 * Mission Control — single pane of glass over every team.
 *
 * One row per team (the orchestrator is its face), per-status task counts, a red
 * row when a lead has declared a block. PURE READ: this pane observes; it never
 * writes the kanban and never pings Teams (the orchestrator does both in its own
 * workflow — the Mission Control design).
 *
 * P2b: cross-host. Teams come from /api/teams (getAllTeams = local + synced
 * peers, each carrying a synced taskSummary), so ONE poll covers every team's
 * task state — no per-team task fetch. Leads resolve against the FEDERATED agent
 * directory so off-host orchestrators render, with the local roster overlaid for
 * richer (avatar/program/session) badges on this host's own leads.
 */

/** Synthesize a minimal Agent from a federated directory entry so an off-host
 *  lead still renders an AgentBadge. Degrades gracefully — no avatar (falls back
 *  to the id-hashed one), no live session (shows offline) — the local roster
 *  overlay below replaces these with the full record for this host's agents. */
function entryToAgent(e: {
  agentId?: string
  name: string
  label?: string
  hostId: string
  hostUrl?: string
  avatar?: string
}): Agent | null {
  if (!e.agentId) return null
  return {
    id: e.agentId,
    name: e.name,
    label: e.label,
    hostId: e.hostId,
    hostUrl: e.hostUrl,
    avatar: e.avatar,
    sessions: [],
    program: '',
    taskDescription: '',
    // Minimal record — AgentBadge/InfraIcon read only the fields above plus
    // optionals; cast through unknown since the rest of Agent is absent by design.
    // avatar rides the synced directory entry so off-host leads render their
    // real avatar instead of AgentBadge's hash-derived fallback.
  } as unknown as Agent
}

export default function MissionControlPage() {
  const [teams, setTeams] = useState<Team[]>([])
  const [agentsById, setAgentsById] = useState<Record<string, Agent>>({})
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false

    const load = async () => {
      try {
        const [teamsRes, agentsRes, directoryRes] = await Promise.all([
          fetch('/api/teams'),
          fetch('/api/agents'),
          fetch('/api/agents/directory/all'),
        ])
        if (!teamsRes.ok) throw new Error('Failed to load teams')
        if (!agentsRes.ok) throw new Error('Failed to load agents')

        const teamsData = await teamsRes.json()
        const agentsData = await agentsRes.json()
        // Federated directory is best-effort — a lead just falls back to local-only.
        const directoryData = directoryRes.ok ? await directoryRes.json() : { entries: [] }
        if (cancelled) return

        setTeams(teamsData.teams || [])

        const map: Record<string, Agent> = {}
        // Federated entries first (resolves off-host leads, lighter badge)…
        for (const e of (directoryData.entries || []) as Parameters<typeof entryToAgent>[0][]) {
          const agent = entryToAgent(e)
          if (agent) map[agent.id] = agent
        }
        // …then overlay the local roster so this host's own leads get full records.
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
    // One aggregate poll covers every team's task state (the synced summaries)
    // plus the federated roster — so cadence can be brisk without N-per-team fan-out.
    const interval = setInterval(load, 10000)
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
