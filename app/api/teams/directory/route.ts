/**
 * GET /api/teams/directory
 *
 * Returns this host's local teams for peer sync.
 * Called by other mesh nodes during periodic team directory sync.
 */

import { NextResponse } from 'next/server'
import { getLocalTeamsForSync } from '@/lib/team-registry'

export async function GET() {
  try {
    const teams = getLocalTeamsForSync()
    return NextResponse.json({ teams })
  } catch (error) {
    console.error('[Teams Directory] Failed to get local teams:', error)
    return NextResponse.json(
      { error: 'Failed to get teams directory' },
      { status: 500 }
    )
  }
}
