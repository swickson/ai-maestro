import { NextRequest, NextResponse } from 'next/server'
import { listAllUsers, createNewUser } from '@/services/users-service'

// GET /api/users - List all users (optional ?role= filter)
export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const role = searchParams.get('role') || undefined
  const result = listAllUsers(role)

  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  return NextResponse.json(result.data, { status: result.status })
}

// POST /api/users - Create a new user
export async function POST(request: NextRequest) {
  const body = await request.json()
  const result = createNewUser(body)

  if (result.error) {
    return NextResponse.json({ error: result.error }, { status: result.status })
  }
  return NextResponse.json(result.data, { status: result.status })
}
