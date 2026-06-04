/**
 * POST /api/teams/directory/sync
 *
 * Manually trigger team directory sync with all mesh peers.
 */

import { NextResponse } from 'next/server'
import { syncTeamsWithPeers, getTeamDirectoryStats } from '@/lib/team-directory'

export async function POST() {
  try {
    const result = await syncTeamsWithPeers()
    const stats = getTeamDirectoryStats()

    return NextResponse.json({
      success: true,
      result,
      stats,
      message: result.newTeams > 0
        ? `Discovered ${result.newTeams} new teams from ${result.synced.length} peer(s)`
        : `Synced with ${result.synced.length} peer(s), no new teams`,
    })
  } catch (error) {
    console.error('[Teams Directory Sync] Failed:', error)
    return NextResponse.json(
      { error: 'Failed to sync team directory' },
      { status: 500 }
    )
  }
}
