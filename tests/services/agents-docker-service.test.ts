/**
 * Agents Docker Service — pure helpers
 *
 * Covers the sandbox.mounts validation + docker `-v` flag construction.
 * The full createDockerAgent flow is integration-tested elsewhere; these tests
 * pin down the narrow contract that determines what gets shelled out.
 */

import { describe, it, expect } from 'vitest'
import { validateMounts, buildMountFlags } from '@/services/agents-docker-service'
import type { SandboxMount } from '@/types/agent'

describe('validateMounts', () => {
  it('returns null for undefined mounts', () => {
    expect(validateMounts(undefined)).toBeNull()
  })

  it('returns null for empty array', () => {
    expect(validateMounts([])).toBeNull()
  })

  it('accepts a well-formed mount', () => {
    const mounts: SandboxMount[] = [
      { hostPath: '/home/user/code', containerPath: '/work/code' },
    ]
    expect(validateMounts(mounts)).toBeNull()
  })

  it('accepts readOnly flag', () => {
    const mounts: SandboxMount[] = [
      { hostPath: '/etc/secrets', containerPath: '/secrets', readOnly: true },
    ]
    expect(validateMounts(mounts)).toBeNull()
  })

  it('rejects relative hostPath', () => {
    const mounts: SandboxMount[] = [
      { hostPath: 'relative/path', containerPath: '/work' },
    ]
    expect(validateMounts(mounts)).toMatch(/absolute/)
  })

  it('rejects relative containerPath', () => {
    const mounts: SandboxMount[] = [
      { hostPath: '/home/user', containerPath: 'work' },
    ]
    expect(validateMounts(mounts)).toMatch(/absolute/)
  })

  it('rejects missing hostPath', () => {
    const mounts = [{ containerPath: '/work' } as unknown as SandboxMount]
    expect(validateMounts(mounts)).toMatch(/hostPath/)
  })

  it('rejects shell-injection characters in paths', () => {
    const cases: SandboxMount[][] = [
      [{ hostPath: '/home/$(whoami)', containerPath: '/work' }],
      [{ hostPath: '/home/user', containerPath: '/work";rm -rf /;"' }],
      [{ hostPath: '/home/`id`', containerPath: '/work' }],
      [{ hostPath: "/home/'evil'", containerPath: '/work' }],
      [{ hostPath: '/home/user\nbad', containerPath: '/work' }],
      [{ hostPath: '/home/user\\evil', containerPath: '/work' }],
    ]
    for (const mounts of cases) {
      expect(validateMounts(mounts)).toMatch(/quotes|backticks|\$|backslashes|newlines/)
    }
  })

  it('reserves /workspace for the working directory mount', () => {
    const mounts: SandboxMount[] = [
      { hostPath: '/home/user/code', containerPath: '/workspace' },
    ]
    expect(validateMounts(mounts)).toMatch(/reserved/)
  })

  it('reports the offending index when multiple mounts are provided', () => {
    const mounts: SandboxMount[] = [
      { hostPath: '/ok', containerPath: '/ok' },
      { hostPath: 'bad', containerPath: '/ok' },
    ]
    expect(validateMounts(mounts)).toMatch(/mounts\[1\]/)
  })
})

describe('buildMountFlags', () => {
  it('returns empty array for undefined mounts', () => {
    expect(buildMountFlags(undefined)).toEqual([])
  })

  it('returns empty array for empty mounts', () => {
    expect(buildMountFlags([])).toEqual([])
  })

  it('produces a single -v flag per mount', () => {
    const mounts: SandboxMount[] = [
      { hostPath: '/home/user/code', containerPath: '/work/code' },
    ]
    expect(buildMountFlags(mounts)).toEqual([
      '-v "/home/user/code:/work/code"',
    ])
  })

  it('appends :ro for readOnly mounts', () => {
    const mounts: SandboxMount[] = [
      { hostPath: '/etc/ssl/certs', containerPath: '/certs', readOnly: true },
    ]
    expect(buildMountFlags(mounts)).toEqual([
      '-v "/etc/ssl/certs:/certs:ro"',
    ])
  })

  it('omits :ro when readOnly is false', () => {
    const mounts: SandboxMount[] = [
      { hostPath: '/home/user', containerPath: '/work', readOnly: false },
    ]
    expect(buildMountFlags(mounts)).toEqual([
      '-v "/home/user:/work"',
    ])
  })

  it('preserves order across multiple mounts', () => {
    const mounts: SandboxMount[] = [
      { hostPath: '/a', containerPath: '/x' },
      { hostPath: '/b', containerPath: '/y', readOnly: true },
      { hostPath: '/c', containerPath: '/z' },
    ]
    expect(buildMountFlags(mounts)).toEqual([
      '-v "/a:/x"',
      '-v "/b:/y:ro"',
      '-v "/c:/z"',
    ])
  })
})
