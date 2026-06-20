import { describe, it, expect, vi, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'

// ============================================================================
// Regression guard for the notify route's botSlug forwarding (#13).
//
// There are TWO implementations of POST /api/users/:id/notify — the Next.js
// route (app/api/users/[id]/notify/route.ts) and the headless-router handler
// (services/headless-router.ts). They drift silently: the Next route was
// updated to forward `botSlug` (per-bot targeting / cold-start), but the
// headless twin kept passing only { platform, subject } — so headless/API-only
// mode silently fell back to context.botSlug and broke the per-bot contract
// (the PR-review agent's catch on #217). This test pins BOTH paths.
// ============================================================================

vi.mock('@/services/users-service', () => ({
  notifyUser: vi.fn(async () => ({ data: { success: true }, status: 200 })),
}))

import { POST as notifyRoute } from '@/app/api/users/[id]/notify/route'
import { notifyUser } from '@/services/users-service'
import { NextRequest } from 'next/server'

function makeRequest(body: unknown): NextRequest {
  return new NextRequest(new URL('http://localhost:23000/api/users/user-1/notify'), {
    method: 'POST',
    body: JSON.stringify(body),
  } as any)
}
const makeParams = (id: string) => ({ params: Promise.resolve({ id }) })

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(notifyUser).mockResolvedValue({ data: { success: true }, status: 200 })
})

describe('POST /api/users/[id]/notify — Next route forwards botSlug (#13)', () => {
  it('forwards platform + subject + botSlug to notifyUser', async () => {
    const res = await notifyRoute(
      makeRequest({ message: 'hi', platform: 'teams', subject: 's', botSlug: 'leoai' }),
      makeParams('user-1'),
    )
    expect(res.status).toBe(200)
    expect(notifyUser).toHaveBeenCalledWith('user-1', 'hi', {
      platform: 'teams',
      subject: 's',
      botSlug: 'leoai',
    })
  })

  it('rejects a body with no message (400) without touching the service', async () => {
    const res = await notifyRoute(makeRequest({ platform: 'teams' }), makeParams('user-1'))
    expect(res.status).toBe(400)
    expect(notifyUser).not.toHaveBeenCalled()
  })
})

describe('headless-router parity — /notify handler must also forward botSlug (#13)', () => {
  it('the headless-router notify handler passes botSlug to notifyUser', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'services', 'headless-router.ts'),
      'utf-8',
    )
    // Anchor on the unique notifyUser call in the /notify handler and assert it
    // forwards botSlug — the exact drift the PR-review agent caught (headless dropped botSlug
    // while the Next route kept it).
    const idx = src.indexOf('notifyUser(params.id, body.message')
    expect(idx, 'notifyUser call not found in headless-router /notify handler').toBeGreaterThan(-1)
    const handlerCall = src.slice(idx, idx + 200)
    expect(handlerCall, 'headless notify handler must forward botSlug').toMatch(/botSlug:\s*body\.botSlug/)
  })
})
