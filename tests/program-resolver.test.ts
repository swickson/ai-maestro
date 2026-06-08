/**
 * Program Resolver Tests
 *
 * Locks the single source of truth (lib/program-resolver) that collapses the
 * formerly-duplicated program→binary and program→kind translators. A future
 * reland that reverts the table must fail loudly HERE.
 *
 * Two load-bearing regressions are pinned:
 *   - antigravity → agy (the PR #149/#171 fix; reland reverted a private copy)
 *   - openclaw is NOT a launchable binary (deferred until verified post-scooter;
 *     openclaw is discover-and-attach, the create primitive has no -S socket)
 */
import { describe, it, expect } from 'vitest'
import { resolveBinary, resolveKind, type AgentKind } from '@/lib/program-resolver'

describe('resolveBinary (program → launch command)', () => {
  it.each([
    ['claude', 'claude'],
    ['claude-code', 'claude'],
    ['Claude Code', 'claude'],
    ['codex', 'codex'],
    ['codex-cli', 'codex'],
    ['gpt-5-codex', 'codex'], // gpt alias → codex (was claude-default in the binary copies pre-consolidation)
    ['aider', 'aider'],
    ['cursor', 'cursor'],
    ['antigravity', 'agy'], // outlier: binary is agy, not antigravity
    ['Antigravity CLI', 'agy'],
    ['antigravity-cli', 'agy'],
    ['gemini', 'gemini'],
    ['opencode', 'opencode'],
    ['vim', 'claude'], // unknown → claude default
    [undefined, 'claude'],
    [null, 'claude'],
    ['', 'claude'],
  ])('program "%s" → binary "%s"', (program, expected) => {
    expect(resolveBinary(program as any)).toBe(expected)
  })

  it('antigravity never falls through to the claude default (PR #171 regression)', () => {
    expect(resolveBinary('antigravity')).toBe('agy')
    expect(resolveBinary('antigravity')).not.toBe('claude')
  })

  it('antigravity is matched before gemini regardless of token order', () => {
    // The antigravity row precedes the gemini row, so a combined label still
    // resolves to agy — guards the ~/.gemini/antigravity-cli/ nesting note.
    expect(resolveBinary('gemini-antigravity')).toBe('agy')
    expect(resolveBinary('antigravity-gemini')).toBe('agy')
  })

  it('openclaw is NOT a launchable binary (deferral lock — see program-resolver.ts)', () => {
    // openclaw is discover-and-attach (clawdbot custom sockets); maestro cannot
    // launch it via the default-socket create primitive. A future edit that
    // wires a working openclaw launch must consciously break this test.
    expect(resolveBinary('openclaw')).not.toBe('openclaw')
    expect(resolveBinary('openclaw')).toBe('claude')
  })
})

describe('resolveKind (program → classification)', () => {
  // Default 'unknown' — the meeting-routing contract (inferKindFromProgram).
  it.each<[string | undefined | null, AgentKind]>([
    ['claude', 'claude'],
    ['claude-code', 'claude'],
    ['Claude Code', 'claude'],
    ['codex', 'codex'],
    ['gpt-5-codex', 'codex'],
    ['antigravity', 'antigravity'],
    ['gemini', 'gemini'],
    ['openclaw', 'openclaw'], // first-class kind (display/AMP/meeting), even though not launchable
    ['aider', 'unknown'], // has a binary but no meeting/cloud kind → caller default
    ['cursor', 'unknown'],
    ['opencode', 'unknown'],
    ['vim', 'unknown'],
    [undefined, 'unknown'],
    [null, 'unknown'],
    ['', 'unknown'],
  ])('program "%s" → kind "%s" (default unknown)', (program, expected) => {
    expect(resolveKind(program, { default: 'unknown' })).toBe(expected)
  })

  it('respects a caller-supplied default for unclassified programs', () => {
    // Cloud usage defaults to claude; aider/cursor/opencode have no kind.
    expect(resolveKind('aider', { default: 'claude' })).toBe('claude')
    expect(resolveKind('vim', { default: 'claude' })).toBe('claude')
    expect(resolveKind(undefined, { default: 'claude' })).toBe('claude')
    // …but a program WITH a kind ignores the default.
    expect(resolveKind('openclaw', { default: 'claude' })).toBe('openclaw')
    expect(resolveKind('antigravity', { default: 'claude' })).toBe('antigravity')
  })

  it('defaults to unknown when no opts provided', () => {
    expect(resolveKind('vim')).toBe('unknown')
    expect(resolveKind(undefined)).toBe('unknown')
  })
})
