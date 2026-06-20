import { describe, it, expect } from 'vitest'
// CJS interop: import the default object then destructure (works for
// `module.exports = {...}` regardless of named-export static analysis).
import runtimeCheck from '../agent-container/runtime-check.cjs'

const { parseAiToolBinary, runtimeMissingMessage } = runtimeCheck

describe('parseAiToolBinary (#78)', () => {
  it('extracts the binary from a bare program', () => {
    expect(parseAiToolBinary('claude')).toBe('claude')
  })

  it('extracts the binary from a program with flags', () => {
    expect(parseAiToolBinary('gemini --yolo')).toBe('gemini')
    expect(parseAiToolBinary('claude --permission-mode acceptEdits --model opus')).toBe('claude')
    expect(parseAiToolBinary('agy --dangerously-skip-permissions')).toBe('agy')
    expect(parseAiToolBinary('codex -p \'do the thing\'')).toBe('codex')
  })

  it('tolerates leading/trailing whitespace and collapses internal runs', () => {
    expect(parseAiToolBinary('   gemini   --yolo  ')).toBe('gemini')
    expect(parseAiToolBinary('claude\t--model opus')).toBe('claude')
  })

  it('returns empty string for empty / non-string input', () => {
    expect(parseAiToolBinary('')).toBe('')
    expect(parseAiToolBinary('   ')).toBe('')
    // The CJS default import is typed `any`, so undefined/null pass the
    // type-checker — these exercise the runtime guard against non-strings.
    // (No @ts-expect-error: it would be an unused directive → TS2578 under
    // `tsc --noEmit` in container:ci — PR-review-agent finding on #208.)
    expect(parseAiToolBinary(undefined)).toBe('')
    expect(parseAiToolBinary(null)).toBe('')
  })
})

describe('runtimeMissingMessage (#78)', () => {
  it('names the missing binary and both remediations', () => {
    const msg = runtimeMissingMessage('gemini')
    expect(msg).toContain("'gemini'")
    expect(msg).toContain('not found in agent container PATH')
    expect(msg).toContain('rebuild image')
    expect(msg).toContain('correct profile')
  })
})
