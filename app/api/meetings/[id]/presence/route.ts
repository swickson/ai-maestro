import { NextRequest, NextResponse } from 'next/server'
import { getMeetingPresence } from '@/lib/meeting-presence'
import { getMeeting } from '@/lib/meeting-registry'

/**
 * GET /api/meetings/[id]/presence
 *
 * Returns the current presence state for all agents in a meeting.
 * Includes status (online/idle/active/working/offline) and last activity.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id: meetingId } = await params

  const meeting = getMeeting(meetingId)
  if (!meeting) {
    return NextResponse.json({ error: 'Meeting not found' }, { status: 404 })
  }

  const presence = getMeetingPresence(meetingId)

  return NextResponse.json({
    meetingId,
    agents: presence?.agents || {},
    lastUpdated: presence?.lastUpdated || null,
  })
}
