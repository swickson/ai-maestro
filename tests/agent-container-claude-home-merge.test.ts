/**
 * Regression coverage for agent-container/claude-home-merge.cjs.
 *
 * This is the container-side defense-in-depth mirror of the host-side
 * shape-aware merge in services/agents-docker-service.ts:413-438
 * (provisionCloudClaudeConfig, kanban 406ff85d / PR #120). The host seeds
 * theme=dark at create + at /recreate-via-migrateAgentPersistence; the
 * container-side merge re-runs the same logic on every container start so
 * claude-code's post-launch rewrites (which drop the field — see commit
 * description for empirical evidence) don't leave us defenseless against
 * future claude behavior that re-triggers the picker on missing theme.
 *
 * Source-of-truth shape parity with the host helper is intentional:
 *   - inject theme=dark only if missing or non-string
 *   - preserve operator-set theme (any string)
 *   - preserve unparseable JSON rather than clobber (host re-seeds on next
 *     /recreate; we don't want to race that)
 *   - write 0o600 to match the host seed's permissions
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

import { ensureClaudeHomeTheme, DEFAULT_THEME } from '../agent-container/claude-home-merge.cjs'

describe('ensureClaudeHomeTheme', () => {
  let tmpDir: string
  let claudeHomePath: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-claude-home-merge-'))
    claudeHomePath = path.join(tmpDir, '.claude.json')
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  // ── Real-world shape: an-agent-on-prod-host 2026-05-22 (numStartups=23, theme dropped) ──
  it('injects theme=dark on agent-shape post-launch file, preserving all other fields', () => {
    const original = {
      numStartups: 23,
      tipsHistory: {
        'new-user-warmup': 9,
        'memory-command': 17,
        'theme-command': 22,
      },
      installMethod: 'unknown',
    }
    fs.writeFileSync(claudeHomePath, JSON.stringify(original))

    const result = ensureClaudeHomeTheme(claudeHomePath)

    expect(result).toEqual({ changed: true, reason: 'injected' })
    const after = JSON.parse(fs.readFileSync(claudeHomePath, 'utf8'))
    expect(after.theme).toBe(DEFAULT_THEME)
    expect(after.numStartups).toBe(23)
    expect(after.tipsHistory).toEqual(original.tipsHistory)
    expect(after.installMethod).toBe('unknown')
  })

  it('idempotent — no rewrite when theme is already a string', () => {
    fs.writeFileSync(claudeHomePath, JSON.stringify({ theme: 'dark', numStartups: 1 }))
    const beforeMtime = fs.statSync(claudeHomePath).mtimeMs

    const result = ensureClaudeHomeTheme(claudeHomePath)

    expect(result).toEqual({ changed: false, reason: 'present' })
    expect(fs.statSync(claudeHomePath).mtimeMs).toBe(beforeMtime)
  })

  it('preserves operator-set non-default theme (light)', () => {
    fs.writeFileSync(claudeHomePath, JSON.stringify({ theme: 'light', numStartups: 5 }))

    const result = ensureClaudeHomeTheme(claudeHomePath)

    expect(result).toEqual({ changed: false, reason: 'present' })
    const after = JSON.parse(fs.readFileSync(claudeHomePath, 'utf8'))
    expect(after.theme).toBe('light')
  })

  it('replaces non-string theme (null / number) with default', () => {
    fs.writeFileSync(claudeHomePath, JSON.stringify({ theme: null, numStartups: 5 }))

    const result = ensureClaudeHomeTheme(claudeHomePath)

    expect(result).toEqual({ changed: true, reason: 'injected' })
    expect(JSON.parse(fs.readFileSync(claudeHomePath, 'utf8')).theme).toBe(DEFAULT_THEME)
  })

  it('seeds theme=dark into an empty-object file (fresh-but-touched edge case)', () => {
    fs.writeFileSync(claudeHomePath, JSON.stringify({}))

    const result = ensureClaudeHomeTheme(claudeHomePath)

    expect(result).toEqual({ changed: true, reason: 'injected' })
    expect(JSON.parse(fs.readFileSync(claudeHomePath, 'utf8'))).toEqual({ theme: DEFAULT_THEME })
  })

  it('skips missing file without creating one', () => {
    const result = ensureClaudeHomeTheme(claudeHomePath)

    expect(result.changed).toBe(false)
    expect(result.reason).toBe('missing')
    expect(fs.existsSync(claudeHomePath)).toBe(false)
  })

  it('skips unparseable JSON without clobbering — host /recreate path owns re-seed', () => {
    const corrupted = '{ this is not json'
    fs.writeFileSync(claudeHomePath, corrupted)

    const result = ensureClaudeHomeTheme(claudeHomePath)

    expect(result.changed).toBe(false)
    expect(result.reason).toBe('unparseable')
    expect(fs.readFileSync(claudeHomePath, 'utf8')).toBe(corrupted)
  })

  it('skips non-object JSON roots (array)', () => {
    fs.writeFileSync(claudeHomePath, JSON.stringify(['not', 'an', 'object']))

    const result = ensureClaudeHomeTheme(claudeHomePath)

    expect(result.changed).toBe(false)
    expect(result.reason).toBe('non-object')
  })

  it('skips non-object JSON roots (bare string)', () => {
    fs.writeFileSync(claudeHomePath, JSON.stringify('hello'))

    const result = ensureClaudeHomeTheme(claudeHomePath)

    expect(result.changed).toBe(false)
    expect(result.reason).toBe('non-object')
  })

  it('writes the file with mode 0o600 (matches host seed perms)', () => {
    fs.writeFileSync(claudeHomePath, JSON.stringify({ numStartups: 5 }), { mode: 0o644 })

    ensureClaudeHomeTheme(claudeHomePath)

    expect(fs.statSync(claudeHomePath).mode & 0o777).toBe(0o600)
  })

  it('running twice on the same agent-shape file is a no-op the second time', () => {
    fs.writeFileSync(claudeHomePath, JSON.stringify({ numStartups: 23, tipsHistory: {} }))

    const first = ensureClaudeHomeTheme(claudeHomePath)
    const second = ensureClaudeHomeTheme(claudeHomePath)

    expect(first.changed).toBe(true)
    expect(second).toEqual({ changed: false, reason: 'present' })
  })
})
