/**
 * One-time legacy-runtime backfill endpoint for cloud agents (kanban 1ef9eabd).
 *
 * POST /api/agents/[id]/backfill-runtime — Reads `docker inspect` for the
 * agent's container, computes cpus / memory / autoRemove, and persists them
 * onto the agent record via updateAgentRuntimeConfig. No container restart,
 * no UUID rotation, no /update-runtime rebuild.
 *
 * Why this exists: agents created before PR #146 (v0.30.84) have no
 * `deployment.cloud.runtime` block. /recreate and /update-runtime both read
 * back from that block and fall back to createDockerAgent's hard-coded
 * defaults (cpus=2, memory='4g', autoRemove=false) when fields are missing —
 * silent downsize for any agent originally created with non-default sizing
 * via dashboard. This endpoint walks the registry from the operator's
 * aimaestro-backfill-runtime CLI and pins the live container's sizing into
 * the registry so future /recreate flows preserve it.
 *
 * Idempotent: returns action="skipped" when runtime.cpus + runtime.memory
 * are already populated.
 *
 * No body. Thin wrapper — business logic in
 * services/agents-docker-service.backfillAgentRuntime.
 */

import { NextResponse } from 'next/server'
import { backfillAgentRuntime } from '@/services/agents-docker-service'
import { toResponse } from '@/app/api/_helpers'

export const dynamic = 'force-dynamic'

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const result = await backfillAgentRuntime(id)
    return toResponse(result)
  } catch (error) {
    console.error('[Docker BackfillRuntime] Error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to backfill agent runtime' },
      { status: 500 }
    )
  }
}
