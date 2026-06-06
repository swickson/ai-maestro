/**
 * Atomic recreate endpoint for cloud agents.
 *
 * POST /api/agents/[id]/recreate — Re-provision the container behind an
 * existing cloud agent while preserving all persisted config (programArgs,
 * model, mounts, hooks, label, avatar, working directory, tags, etc.).
 *
 * Replaces the prior 2-step "delete + manually-construct create body" dance,
 * which silently dropped fields the operator forgot to forward — programArgs
 * being the canonical case, surfaced 2026-04-28 on Mason/Optic/Hardin recreates
 * (kanban 5e4ebdd5).
 *
 * Thin wrapper — business logic in services/agents-docker-service.ts.
 */

import { NextResponse } from 'next/server'
import { recreateDockerAgent } from '@/services/agents-docker-service'
import { toResponse } from '@/app/api/_helpers'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const result = await recreateDockerAgent(id)
    return toResponse(result)
  } catch (error) {
    console.error('[Docker Recreate] Error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to recreate Docker agent' },
      { status: 500 }
    )
  }
}
