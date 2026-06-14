import { describe, it, expect, vi, beforeEach } from 'vitest'

// ============================================================================
// Mocks — stub the service layer so we test the ROUTE wrapper in isolation.
// The regression target is that the handler FORWARDS platformUserId + context
// through to updateLastSeen (that forwarding is what lets a gateway's
// every-inbound { context: { botSlug } } reach the targeted mapping merge — the
// mechanism behind "most-recently-inbound bot wins" for proactive DMs). It also
// guards the route's existence in full (Next.js) mode: this handler was added in
// #201 to close a headless-only gap where the route 404'd and callers fell back
// to the generic [id] PATCH, silently clobbering lastSeenPerPlatform.
// ============================================================================

vi.mock('@/services/users-service', () => ({
  updateLastSeen: vi.fn(() => ({ data: { success: true }, status: 200 })),
}))

import { PATCH as lastSeenRoute } from '@/app/api/users/[id]/last-seen/route'
import { updateLastSeen } from '@/services/users-service'
import { NextRequest } from 'next/server'

function makeRequest(body: unknown, opts: { rawBody?: string } = {}): NextRequest {
  return new NextRequest(new URL('http://localhost:23000/api/users/user-1/last-seen'), {
    method: 'PATCH',
    body: opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(body),
  } as any)
}

function makeParams(id: string) {
  return { params: Promise.resolve({ id }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(updateLastSeen).mockReturnValue({ data: { success: true }, status: 200 })
})

describe('PATCH /api/users/[id]/last-seen', () => {
  it('rejects a body with no platform (400) without touching the service', async () => {
    const res = await lastSeenRoute(makeRequest({ platformUserId: 'aad-1' }), makeParams('user-1'))
    expect(res.status).toBe(400)
    expect(updateLastSeen).not.toHaveBeenCalled()
  })

  it('forwards platformUserId + context through to updateLastSeen (the merge-enabling contract)', async () => {
    const res = await lastSeenRoute(
      makeRequest({ platform: 'teams', platformUserId: 'aad-xyz', context: { botSlug: 'bot-beta' } }),
      makeParams('user-1'),
    )
    expect(res.status).toBe(200)
    expect(updateLastSeen).toHaveBeenCalledWith('user-1', 'teams', {
      platformUserId: 'aad-xyz',
      context: { botSlug: 'bot-beta' },
    })
  })

  it('works with platform only (back-compat: no platformUserId/context)', async () => {
    const res = await lastSeenRoute(makeRequest({ platform: 'discord' }), makeParams('user-1'))
    expect(res.status).toBe(200)
    expect(updateLastSeen).toHaveBeenCalledWith('user-1', 'discord', {
      platformUserId: undefined,
      context: undefined,
    })
  })

  it('maps a service error status to the response (e.g. unknown user → 404)', async () => {
    vi.mocked(updateLastSeen).mockReturnValue({ error: 'User not found', status: 404 })
    const res = await lastSeenRoute(makeRequest({ platform: 'teams' }), makeParams('nope'))
    expect(res.status).toBe(404)
    const body = await res.json()
    expect(body.error).toBe('User not found')
  })

  it('rejects an invalid JSON body (400) without touching the service', async () => {
    const res = await lastSeenRoute(makeRequest(null, { rawBody: '{not json' }), makeParams('user-1'))
    expect(res.status).toBe(400)
    expect(updateLastSeen).not.toHaveBeenCalled()
  })
})
