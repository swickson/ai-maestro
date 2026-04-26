/**
 * Agents Docker Service — pure helpers
 *
 * Covers the sandbox.mounts validation + docker `-v` flag construction.
 * The full createDockerAgent flow is integration-tested elsewhere; these tests
 * pin down the narrow contract that determines what gets shelled out.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  validateMounts,
  validateExtraEnv,
  buildMountFlags,
  buildEnvFlags,
  buildAmpCommonMounts,
  buildAmpCommonEnv,
  buildCloudClaudeSettingsMount,
  provisionCloudClaudeConfig,
  mergeMounts,
  mergeEnv,
} from '@/services/agents-docker-service'
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

describe('validateExtraEnv', () => {
  it('returns null for undefined', () => {
    expect(validateExtraEnv(undefined)).toBeNull()
  })

  it('returns null for empty object', () => {
    expect(validateExtraEnv({})).toBeNull()
  })

  it('accepts well-formed env entries', () => {
    expect(validateExtraEnv({ FOO: 'bar', BAZ_QUX: '1', _LEADING: 'ok' })).toBeNull()
  })

  it('rejects invalid key shapes', () => {
    expect(validateExtraEnv({ '1FOO': 'bar' })).toMatch(/invalid key/)
    expect(validateExtraEnv({ 'foo-bar': 'baz' })).toMatch(/invalid key/)
    expect(validateExtraEnv({ 'FOO BAR': 'baz' })).toMatch(/invalid key/)
    expect(validateExtraEnv({ '': 'baz' })).toMatch(/invalid key/)
  })

  it('rejects shell-injection characters in values', () => {
    const cases: Record<string, string>[] = [
      { FOO: '$(whoami)' },
      { FOO: 'a"b' },
      { FOO: "a'b" },
      { FOO: 'a`b' },
      { FOO: 'a\nb' },
      { FOO: 'a\\b' },
    ]
    for (const env of cases) {
      expect(validateExtraEnv(env)).toMatch(/quotes|backticks|\$|backslashes|newlines/)
    }
  })

  it('rejects non-string values', () => {
    expect(validateExtraEnv({ FOO: 123 as unknown as string })).toMatch(/must be a string/)
  })
})

describe('buildEnvFlags', () => {
  it('returns empty array for undefined', () => {
    expect(buildEnvFlags(undefined)).toEqual([])
  })

  it('returns empty array for empty object', () => {
    expect(buildEnvFlags({})).toEqual([])
  })

  it('produces a single -e flag per entry', () => {
    expect(buildEnvFlags({ FOO: 'bar', BAZ: 'qux' })).toEqual([
      '-e FOO="bar"',
      '-e BAZ="qux"',
    ])
  })
})

describe('buildAmpCommonMounts', () => {
  const uuid = '11111111-1111-1111-1111-111111111111'
  const home = '/home/gosub'

  it('returns three mounts derived from the agent UUID', () => {
    const mounts = buildAmpCommonMounts(uuid, home)
    expect(mounts).toHaveLength(3)
    expect(mounts.map(m => m.containerPath)).toEqual([
      `/home/claude/.agent-messaging/agents/${uuid}`,
      `/home/claude/.aimaestro/agents/${uuid}`,
      '/home/claude/.local/bin',
    ])
  })

  it('mirrors host paths under the supplied home', () => {
    const mounts = buildAmpCommonMounts(uuid, home)
    expect(mounts.map(m => m.hostPath)).toEqual([
      `${home}/.agent-messaging/agents/${uuid}`,
      `${home}/.aimaestro/agents/${uuid}`,
      `${home}/.local/bin`,
    ])
  })

  it('marks the AMP CLI mount read-only', () => {
    const mounts = buildAmpCommonMounts(uuid, home)
    const cli = mounts.find(m => m.containerPath === '/home/claude/.local/bin')
    expect(cli?.readOnly).toBe(true)
  })

  it('leaves identity mounts read-write', () => {
    const mounts = buildAmpCommonMounts(uuid, home)
    const idAmp = mounts.find(m => m.containerPath === `/home/claude/.agent-messaging/agents/${uuid}`)
    const idMaestro = mounts.find(m => m.containerPath === `/home/claude/.aimaestro/agents/${uuid}`)
    expect(idAmp?.readOnly).toBeFalsy()
    expect(idMaestro?.readOnly).toBeFalsy()
  })

  it('does not include a wholesale ~/.claude mount', () => {
    const mounts = buildAmpCommonMounts(uuid, home)
    expect(mounts.find(m => m.containerPath === '/home/claude/.claude')).toBeUndefined()
    expect(mounts.find(m => m.hostPath === `${home}/.claude`)).toBeUndefined()
  })

  it('passes the SandboxMount validator', () => {
    const mounts = buildAmpCommonMounts(uuid, home)
    expect(validateMounts(mounts)).toBeNull()
  })
})

describe('buildCloudClaudeSettingsMount', () => {
  const uuid = '33333333-3333-3333-3333-333333333333'
  const home = '/home/gosub'

  it('returns a file-level mount targeting /home/claude/.claude/settings.json', () => {
    const m = buildCloudClaudeSettingsMount(uuid, home)
    expect(m.hostPath).toBe(`${home}/.aimaestro/agents/${uuid}/claude-settings.json`)
    expect(m.containerPath).toBe('/home/claude/.claude/settings.json')
  })

  it('is read-only', () => {
    expect(buildCloudClaudeSettingsMount(uuid, home).readOnly).toBe(true)
  })

  it('passes the SandboxMount validator', () => {
    expect(validateMounts([buildCloudClaudeSettingsMount(uuid, home)])).toBeNull()
  })
})

describe('provisionCloudClaudeConfig', () => {
  const uuid = '44444444-4444-4444-4444-444444444444'
  let tmpHome: string
  let tmpRepo: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-home-'))
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-repo-'))
    const hookSrcDir = path.join(tmpRepo, 'scripts', 'claude-hooks')
    fs.mkdirSync(hookSrcDir, { recursive: true })
    fs.writeFileSync(path.join(hookSrcDir, 'ai-maestro-hook.cjs'), '// stub hook\nprocess.exit(0)\n')
  })

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
    fs.rmSync(tmpRepo, { recursive: true, force: true })
  })

  it('snapshots the hook script into the per-UUID dir', () => {
    const { hookPath } = provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    expect(hookPath).toBe(path.join(tmpHome, '.aimaestro', 'agents', uuid, 'claude-hook.cjs'))
    expect(fs.existsSync(hookPath)).toBe(true)
    expect(fs.readFileSync(hookPath, 'utf8')).toContain('stub hook')
  })

  it('makes the snapshotted hook executable', () => {
    const { hookPath } = provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    expect(fs.statSync(hookPath).mode & 0o111).not.toBe(0)
  })

  it('writes a settings.json with hook paths pointing at the container-side hook location', () => {
    const { settingsPath } = provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    const containerHook = `/home/claude/.aimaestro/agents/${uuid}/claude-hook.cjs`
    for (const event of ['Notification', 'Stop', 'SessionStart', 'UserPromptSubmit']) {
      const cfg = settings.hooks[event][0]
      expect(cfg.hooks[0].command).toBe(`node ${containerHook}`)
    }
  })

  it('does not reference the host repo path in the generated settings', () => {
    const { settingsPath } = provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    const body = fs.readFileSync(settingsPath, 'utf8')
    expect(body).not.toContain(tmpRepo)
    expect(body).not.toContain(tmpHome)
  })

  it('creates the per-UUID dir if missing', () => {
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    expect(fs.existsSync(agentDir)).toBe(false)
    provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    expect(fs.existsSync(agentDir)).toBe(true)
  })
})

describe('buildAmpCommonEnv', () => {
  const uuid = '22222222-2222-2222-2222-222222222222'
  const name = 'ops-exec-test'
  const hostUrl = 'http://host.docker.internal:23000'

  it('returns the five identity/name/routing/path envs', () => {
    expect(buildAmpCommonEnv(uuid, name, hostUrl)).toEqual({
      CLAUDE_AGENT_ID: uuid,
      CLAUDE_AGENT_NAME: name,
      AMP_DIR: `/home/claude/.agent-messaging/agents/${uuid}`,
      AMP_MAESTRO_URL: hostUrl,
      PATH: '/home/claude/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    })
  })

  it('puts the AMP CLI dir ahead of the standard path', () => {
    const env = buildAmpCommonEnv(uuid, name, hostUrl)
    expect(env.PATH.split(':')[0]).toBe('/home/claude/.local/bin')
  })

  it('passes the extraEnv validator', () => {
    expect(validateExtraEnv(buildAmpCommonEnv(uuid, name, hostUrl))).toBeNull()
  })
})

describe('mergeMounts', () => {
  it('returns common mounts when operator is undefined', () => {
    const common: SandboxMount[] = [{ hostPath: '/a', containerPath: '/x' }]
    expect(mergeMounts(common, undefined)).toEqual(common)
  })

  it('returns common mounts when operator is empty', () => {
    const common: SandboxMount[] = [{ hostPath: '/a', containerPath: '/x' }]
    expect(mergeMounts(common, [])).toEqual(common)
  })

  it('preserves operator order then appends untouched common mounts', () => {
    const common: SandboxMount[] = [
      { hostPath: '/a', containerPath: '/x' },
      { hostPath: '/b', containerPath: '/y' },
    ]
    const operator: SandboxMount[] = [{ hostPath: '/c', containerPath: '/z' }]
    expect(mergeMounts(common, operator)).toEqual([
      { hostPath: '/c', containerPath: '/z' },
      { hostPath: '/a', containerPath: '/x' },
      { hostPath: '/b', containerPath: '/y' },
    ])
  })

  it('lets operator override a common mount at the same containerPath', () => {
    const common: SandboxMount[] = [
      { hostPath: '/host/default', containerPath: '/x', readOnly: true },
    ]
    const operator: SandboxMount[] = [
      { hostPath: '/host/override', containerPath: '/x' },
    ]
    expect(mergeMounts(common, operator)).toEqual([
      { hostPath: '/host/override', containerPath: '/x' },
    ])
  })
})

describe('mergeEnv', () => {
  it('returns common env when operator is undefined', () => {
    expect(mergeEnv({ FOO: 'bar' }, undefined)).toEqual({ FOO: 'bar' })
  })

  it('lets operator override a common key', () => {
    expect(mergeEnv({ FOO: 'common' }, { FOO: 'operator' })).toEqual({ FOO: 'operator' })
  })

  it('union-merges disjoint keys', () => {
    expect(mergeEnv({ FOO: 'a' }, { BAR: 'b' })).toEqual({ FOO: 'a', BAR: 'b' })
  })

  // Precedence chain image-default < auto-injected < operator. The image's
  // ENV is the docker baseline; -e flags override it; mergeEnv layers operator
  // overrides on top of auto. This test pins the auto-vs-operator step.
  it('preserves operator override of an auto-injected AMP env', () => {
    const uuid = '33333333-3333-3333-3333-333333333333'
    const auto = buildAmpCommonEnv(uuid, 'ops-exec-test', 'http://host.docker.internal:23000')
    const operator = { AMP_MAESTRO_URL: 'http://operator-override:9999' }
    const merged = mergeEnv(auto, operator)
    expect(merged.AMP_MAESTRO_URL).toBe('http://operator-override:9999')
    expect(merged.CLAUDE_AGENT_ID).toBe(uuid) // un-overridden auto values stay
  })
})
