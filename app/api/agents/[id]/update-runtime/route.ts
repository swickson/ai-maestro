/**
 * Mid-life container runtime mutation endpoint for cloud agents.
 *
 * POST /api/agents/[id]/update-runtime — Rebuild the agent's container with
 * updated mounts and/or extraEnv WITHOUT rotating the audit-trail UUID, AMP
 * keypair, or per-agent state directory.
 *
 * Use this when an operator needs to add/remove/replace bind mounts or env
 * vars on an existing cloud agent — e.g. mounting a code repo via
 * `aimaestro-agent mount add`, or overriding HOME=/workspace/<name> for the
 * Shape β agent-home convention. /recreate would do the same docker rebuild
 * but at the cost of UUID rotation (see services/agents-docker-service.ts
 * recreateDockerAgent); use /recreate only when full identity refresh is
 * actually wanted.
 *
 * Body:
 *   {
 *     mounts?: SandboxMount[],            // Replace operator mounts wholesale ([] to clear)
 *     extraEnv?: Record<string, string>,  // Replace operator extraEnv wholesale ({} to clear)
 *     ziggy?: boolean,                    // Toggle ziggy_default attach + Ziggy MCP overlay mounts
 *                                         //   (true requires /opt/stacks/ai-maestro/agent-envs/<name>.env)
 *     profile?: 'worker' | 'orchestrator', // §11.1 dev-team container profile (identity-preserving migration)
 *     teamId?: string,                    // scopes the shared /ai-team mount source
 *     transportRepo?: string,             // absolute host path to the per-wave bare repo
 *   }
 *
 * Any field may be omitted to leave that aspect untouched.
 *
 * Thin wrapper — business logic in services/agents-docker-service.ts.
 */

import { NextResponse } from 'next/server'
import { updateContainerMountsAndExtraEnv } from '@/services/agents-docker-service'
import { toResponse } from '@/app/api/_helpers'

export const dynamic = 'force-dynamic'

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    let body: { mounts?: unknown; extraEnv?: unknown; ziggy?: unknown; profile?: unknown; teamId?: unknown; transportRepo?: unknown } = {}
    try {
      body = await request.json()
    } catch {
      // Empty body is allowed — caller might be probing the endpoint shape.
      // updateContainerMountsAndExtraEnv treats omitted fields as "leave
      // untouched", which is a valid (if unusual) no-op rebuild.
    }

    const result = await updateContainerMountsAndExtraEnv(id, {
      mounts: body.mounts as Parameters<typeof updateContainerMountsAndExtraEnv>[1]['mounts'],
      extraEnv: body.extraEnv as Parameters<typeof updateContainerMountsAndExtraEnv>[1]['extraEnv'],
      ziggy: typeof body.ziggy === 'boolean' ? body.ziggy : undefined,
      profile: body.profile as Parameters<typeof updateContainerMountsAndExtraEnv>[1]['profile'],
      teamId: typeof body.teamId === 'string' ? body.teamId : undefined,
      transportRepo: typeof body.transportRepo === 'string' ? body.transportRepo : undefined,
    })
    return toResponse(result)
  } catch (error) {
    console.error('[Docker UpdateRuntime] Error:', error)
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to update agent runtime config' },
      { status: 500 }
    )
  }
}
