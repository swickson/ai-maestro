/**
 * Agent Directory API
 *
 * GET /api/agents/directory
 *   Returns the agent directory for this host
 *   Used by peer hosts to sync agent locations
 *
 * Thin wrapper — business logic in services/agents-directory-service.ts
 */

import { NextRequest } from 'next/server'
import { getDirectory } from '@/services/agents-directory-service'
import { toResponse } from '@/app/api/_helpers'

// Live mesh state — must never be statically cached. This route is GET-only,
// so Next.js would otherwise cache the response and serve it stale until a
// restart (cross-host team/agent edits never propagate). force-dynamic = always fresh.
export const dynamic = 'force-dynamic'

export async function GET(_request: NextRequest) {
  const result = getDirectory()
  return toResponse(result)
}
