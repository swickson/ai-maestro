/**
 * Guard: live mesh-state directory routes must declare `force-dynamic`.
 *
 * These routes are GET-only, so Next.js statically caches the response and
 * serves it STALE until a restart — which silently broke cross-host team/agent
 * propagation (a team delete/rename/cos change never reached peers' panes; the
 * dashboard rendered stale teams + activity). `export const dynamic =
 * 'force-dynamic'` opts out of the cache. This test pins that contract so a
 * future edit can't drop it and re-introduce the staleness.
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const LIVE_DIRECTORY_ROUTES = [
  'app/api/teams/directory/route.ts',       // peer team sync — the confirmed stale one
  'app/api/agents/directory/route.ts',      // local agent directory for peers
  'app/api/agents/directory/all/route.ts',  // merged cross-host directory the dashboard reads
]

describe('live mesh-state directory routes opt out of Next static caching', () => {
  it.each(LIVE_DIRECTORY_ROUTES)('%s declares force-dynamic', (rel) => {
    const src = fs.readFileSync(path.join(process.cwd(), rel), 'utf-8')
    expect(src).toMatch(/export\s+const\s+dynamic\s*=\s*['"]force-dynamic['"]/)
  })
})
