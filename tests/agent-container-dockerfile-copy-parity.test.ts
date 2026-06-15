/**
 * Agent-container Dockerfile COPY parity (#78 regression guard)
 *
 * agent-server.js is COPY-baked into the agent image and `require()`s sibling
 * .cjs helpers at load time. If a new helper is added + required but NOT added
 * to the Dockerfile's COPY set, the rebuilt image crash-loops on
 * MODULE_NOT_FOUND at `node agent-server.js` start — and it's invisible until a
 * rebuild (the running :latest predates the require). This bit #78: #208 added
 * `require('./runtime-check.cjs')` without the matching `COPY runtime-check.cjs`.
 *
 * This test pins the invariant: every local `./*.cjs` required by agent-server.js
 * must have a corresponding `COPY <file>` in agent-container/Dockerfile.
 */

import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const AGENT_DIR = path.join(process.cwd(), 'agent-container')

function localCjsRequires(source: string): string[] {
  const out = new Set<string>()
  const re = /require\(\s*['"]\.\/([A-Za-z0-9_-]+\.cjs)['"]\s*\)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(source)) !== null) out.add(m[1])
  return [...out]
}

function dockerfileCopiedFiles(dockerfile: string): Set<string> {
  const copied = new Set<string>()
  for (const line of dockerfile.split('\n')) {
    const t = line.trim()
    if (!t.startsWith('COPY ')) continue
    // COPY <src...> <dest> — collect every source token (drop the COPY kw + dest).
    const tokens = t.slice(5).trim().split(/\s+/)
    for (const tok of tokens.slice(0, -1)) copied.add(path.basename(tok))
  }
  return copied
}

describe('agent-container Dockerfile COPY parity (#78)', () => {
  const serverSrc = fs.readFileSync(path.join(AGENT_DIR, 'agent-server.js'), 'utf-8')
  const dockerfile = fs.readFileSync(path.join(AGENT_DIR, 'Dockerfile'), 'utf-8')
  const required = localCjsRequires(serverSrc)
  const copied = dockerfileCopiedFiles(dockerfile)

  it('agent-server.js requires at least its known .cjs helpers (sanity)', () => {
    expect(required).toContain('runtime-check.cjs')
    expect(required.length).toBeGreaterThanOrEqual(3)
  })

  it('every local .cjs required by agent-server.js is COPYd into the image', () => {
    const missing = required.filter(f => !copied.has(f))
    expect(missing, `Dockerfile is missing COPY for: ${missing.join(', ')}`).toEqual([])
  })
})
