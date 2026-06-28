/**
 * Diagnostics Endpoint
 *
 * GET /api/diagnostics
 *
 * Runs system self-diagnostics and returns a full report.
 * Checks tmux, node-pty, agent registry, remote hosts, Node.js version, disk space.
 */

import { NextResponse } from 'next/server'
import { runDiagnostics } from '@/services/diagnostics-service'

// Live system state — must never be statically cached. This GET reads runtime
// state (tmux, node-pty, registry, remote hosts, disk), so Next would otherwise
// serve a stale snapshot until a restart. Same class as the directory routes (#283).
export const dynamic = 'force-dynamic'

export async function GET() {
  const result = await runDiagnostics()
  return NextResponse.json(result.data, { status: result.status })
}
