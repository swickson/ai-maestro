/**
 * Agent Directory Mesh-Wide Enumeration API
 *
 * GET /api/agents/directory/all
 *   Returns the merged mesh-wide directory (local + remote-synced peers)
 *   for batch enumeration from cloud-agent containers.
 *
 *   Sister to /api/agents/directory/lookup/[name] (single-agent merged view).
 *   Distinct from /api/agents/directory which returns local-only entries
 *   for peer-host sync.
 *
 * Thin wrapper — business logic in services/agents-directory-service.ts
 */

import { NextRequest } from 'next/server'
import { getAllDirectory } from '@/services/agents-directory-service'
import { toResponse } from '@/app/api/_helpers'

export async function GET(_request: NextRequest) {
  const result = getAllDirectory()
  return toResponse(result)
}
