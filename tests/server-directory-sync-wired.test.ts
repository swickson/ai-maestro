/**
 * Guard: server init must wire BOTH recurring directory-sync starters.
 *
 * `startDirectorySync` (lib/agent-directory.ts) and `startTeamDirectorySync`
 * (lib/team-directory.ts) were both DEFINED but never called from server init —
 * so cross-host agent activity got only a one-shot startup pull and team CRUD
 * never propagated until a viewer's mission-control pane polled (or a manual
 * POST /api/.../directory/sync). That silently broke the "live single pane
 * without a viewer" promise. server.mjs now starts both in the shared
 * `server.listen` callback (runs in full AND headless modes via `startServer`).
 *
 * This pins the wiring so a future edit can't drop a starter and re-introduce
 * the staleness. Source-regex guard (same approach as directory-routes-dynamic).
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

describe('server init wires the recurring directory-sync starters', () => {
  const src = fs.readFileSync(path.join(process.cwd(), 'server.mjs'), 'utf-8')

  it('imports and calls startDirectorySync (agent directory)', () => {
    expect(src).toMatch(/import\([`'"]\.\/lib\/agent-directory\.ts[`'"]\)/)
    expect(src).toMatch(/startDirectorySync\s*\(/)
  })

  it('imports and calls startTeamDirectorySync (team directory)', () => {
    expect(src).toMatch(/import\([`'"]\.\/lib\/team-directory\.ts[`'"]\)/)
    expect(src).toMatch(/startTeamDirectorySync\s*\(/)
  })
})
