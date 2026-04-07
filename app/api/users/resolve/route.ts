import { NextRequest, NextResponse } from 'next/server'
import { resolveUser } from '@/services/users-service'

// GET /api/users/resolve?alias=gosub
// GET /api/users/resolve?platform=discord&platformUserId=123
// GET /api/users/resolve?displayName=Shane+Wickson
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)

  const result = resolveUser({
    alias: searchParams.get('alias') || undefined,
    platform: searchParams.get('platform') || undefined,
    platformUserId: searchParams.get('platformUserId') || undefined,
    displayName: searchParams.get('displayName') || undefined,
  })

  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  return NextResponse.json(result.data, { status: result.status })
}
