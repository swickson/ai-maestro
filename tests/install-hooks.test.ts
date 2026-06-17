import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

// PR-B delivery half (Columbo #247): the authoritative busy edge is written in the
// hook's UserPromptSubmit case, so the installer MUST register UserPromptSubmit for
// host Claude agents — otherwise the hook never fires on a turn start and the
// busy-write is dead code (installer-provisioned agents silently fall back to the
// capture-pane probe). This guards against that registration being dropped again.
const INSTALLER = path.join(process.cwd(), 'scripts/claude-hooks/install-hooks.sh')

function claudeBlock(src: string): string {
  const start = src.indexOf('install_claude_hooks()')
  expect(start).toBeGreaterThan(-1)
  // end at the next install_* function (codex) or EOF
  const next = src.indexOf('install_codex_hooks', start)
  return src.slice(start, next > -1 ? next : src.length)
}

describe('install-hooks.sh — Claude event registration (PR-B)', () => {
  const src = fs.readFileSync(INSTALLER, 'utf8')
  const claude = claudeBlock(src)

  it('registers UserPromptSubmit so the authoritative busy edge actually fires', () => {
    expect(claude).toMatch(/"UserPromptSubmit"\s*:\s*\[/)
  })

  it('registers the full turn lifecycle (UserPromptSubmit start + Stop end + Notification + SessionStart)', () => {
    for (const evt of ['UserPromptSubmit', 'Stop', 'Notification', 'SessionStart']) {
      expect(claude).toContain(`"${evt}"`)
    }
  })

  it('the UserPromptSubmit registration uses the same hook command as the other events', () => {
    // the block between "UserPromptSubmit": [ and the next event key must invoke the hook
    const upsIdx = claude.indexOf('"UserPromptSubmit"')
    const after = claude.slice(upsIdx, upsIdx + 250)
    expect(after).toMatch(/node \$HOOK_SCRIPT/)
  })
})
