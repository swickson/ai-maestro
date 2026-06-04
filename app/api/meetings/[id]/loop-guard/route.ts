import { NextRequest, NextResponse } from 'next/server'
import { getLoopGuardStatus, resetLoopGuard } from '@/lib/meeting-router'

/**
 * GET /api/meetings/[id]/loop-guard
 * Returns the current loop guard status for a meeting.
 *
 * POST /api/meetings/[id]/loop-guard
 * Resets the loop guard (equivalent to /continue command).
 */

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const status = getLoopGuardStatus(params.id)
  if (!status) {
    return NextResponse.json({ error: 'Meeting not found' }, { status: 404 })
  }
  return NextResponse.json(status)
}

export async function POST(
  _request: NextRequest,
  { params }: { params: { id: string } }
) {
  const state = resetLoopGuard(params.id)
  if (!state) {
    return NextResponse.json({ error: 'Meeting not found' }, { status: 404 })
  }
  return NextResponse.json({ success: true, state })
}
