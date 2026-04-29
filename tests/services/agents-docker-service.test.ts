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
  buildCloudClaudePersistMounts,
  migrateAgentPersistence,
  provisionCloudClaudeConfig,
  mergeMounts,
  mergeEnv,
  buildRecreateBody,
  RECREATE_PRESERVED_FIELDS,
} from '@/services/agents-docker-service'
import type { Agent, SandboxMount } from '@/types/agent'

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

  it('returns four mounts derived from the agent UUID + host shared paths', () => {
    const mounts = buildAmpCommonMounts(uuid, home)
    expect(mounts).toHaveLength(4)
    expect(mounts.map(m => m.containerPath)).toEqual([
      `/home/claude/.agent-messaging/agents/${uuid}`,
      `/home/claude/.aimaestro/agents/${uuid}`,
      '/home/claude/.local/bin',
      '/home/claude/.local/share/aimaestro/shell-helpers',
    ])
  })

  it('mirrors host paths under the supplied home', () => {
    const mounts = buildAmpCommonMounts(uuid, home)
    expect(mounts.map(m => m.hostPath)).toEqual([
      `${home}/.agent-messaging/agents/${uuid}`,
      `${home}/.aimaestro/agents/${uuid}`,
      `${home}/.local/bin`,
      `${home}/.local/share/aimaestro/shell-helpers`,
    ])
  })

  it('marks the AMP CLI mount read-only', () => {
    const mounts = buildAmpCommonMounts(uuid, home)
    const cli = mounts.find(m => m.containerPath === '/home/claude/.local/bin')
    expect(cli?.readOnly).toBe(true)
  })

  it('marks the shell-helpers mount read-only', () => {
    const mounts = buildAmpCommonMounts(uuid, home)
    const helpers = mounts.find(m => m.containerPath === '/home/claude/.local/share/aimaestro/shell-helpers')
    expect(helpers?.readOnly).toBe(true)
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

  it('is read-write — claude writes settings.json on bypass-accept and tool config flows', () => {
    expect(buildCloudClaudeSettingsMount(uuid, home).readOnly).toBeFalsy()
  })

  it('passes the SandboxMount validator', () => {
    expect(validateMounts([buildCloudClaudeSettingsMount(uuid, home)])).toBeNull()
  })
})

describe('buildCloudClaudePersistMounts', () => {
  const uuid = '55555555-5555-5555-5555-555555555555'
  const home = '/home/gosub'

  it('returns three mounts under the per-agent state dir', () => {
    const mounts = buildCloudClaudePersistMounts(uuid, home)
    expect(mounts).toHaveLength(3)
    expect(mounts.map(m => m.containerPath)).toEqual([
      '/home/claude/.claude.json',
      '/home/claude/.claude/.credentials.json',
      '/home/claude/.config/gh',
    ])
  })

  it('sources every mount from ~/.aimaestro/agents/<id>/', () => {
    const mounts = buildCloudClaudePersistMounts(uuid, home)
    const agentDir = `${home}/.aimaestro/agents/${uuid}`
    expect(mounts.map(m => m.hostPath)).toEqual([
      `${agentDir}/claude-home.json`,
      `${agentDir}/claude-credentials.json`,
      `${agentDir}/gh-config`,
    ])
  })

  it('keeps all persistence mounts read-write (claude/gh need to write state back)', () => {
    const mounts = buildCloudClaudePersistMounts(uuid, home)
    for (const m of mounts) {
      expect(m.readOnly).toBeFalsy()
    }
  })

  it('does not leak host operator state — paths are per-agent, not host ~/.claude or ~/.config', () => {
    const mounts = buildCloudClaudePersistMounts(uuid, home)
    for (const m of mounts) {
      expect(m.hostPath.startsWith(`${home}/.aimaestro/agents/${uuid}/`)).toBe(true)
      expect(m.hostPath).not.toBe(`${home}/.claude.json`)
      expect(m.hostPath).not.toBe(`${home}/.claude/.credentials.json`)
      expect(m.hostPath).not.toBe(`${home}/.config/gh`)
    }
  })

  it('isolates per-agent state across UUIDs', () => {
    const a = buildCloudClaudePersistMounts('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', home)
    const b = buildCloudClaudePersistMounts('bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb', home)
    for (let i = 0; i < a.length; i++) {
      expect(a[i].hostPath).not.toBe(b[i].hostPath)
    }
  })

  it('passes the SandboxMount validator', () => {
    expect(validateMounts(buildCloudClaudePersistMounts(uuid, home))).toBeNull()
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

  it('seeds skipDangerousModePermissionPrompt: true so cloud agents do not re-prompt the bypass warning on every recreate', () => {
    const { settingsPath } = provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(settings.skipDangerousModePermissionPrompt).toBe(true)
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

  it('seeds claude-home.json with valid empty JSON so docker-create finds a file (not auto-mat dir) at the bind target', () => {
    provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    const homeJsonPath = path.join(tmpHome, '.aimaestro', 'agents', uuid, 'claude-home.json')
    expect(fs.statSync(homeJsonPath).isFile()).toBe(true)
    expect(() => JSON.parse(fs.readFileSync(homeJsonPath, 'utf8'))).not.toThrow()
  })

  it('seeds claude-credentials.json with valid empty JSON', () => {
    provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    const credsPath = path.join(tmpHome, '.aimaestro', 'agents', uuid, 'claude-credentials.json')
    expect(fs.statSync(credsPath).isFile()).toBe(true)
    expect(() => JSON.parse(fs.readFileSync(credsPath, 'utf8'))).not.toThrow()
  })

  it('creates the gh-config directory for the gh auth bind mount', () => {
    provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    const ghDir = path.join(tmpHome, '.aimaestro', 'agents', uuid, 'gh-config')
    expect(fs.statSync(ghDir).isDirectory()).toBe(true)
  })

  it('preserves existing claude-home.json content across re-runs (state persistence intent)', () => {
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    const homeJsonPath = path.join(agentDir, 'claude-home.json')
    const existing = '{"bypassPermissionsModeAccepted":true,"hasCompletedOnboarding":true}\n'
    fs.writeFileSync(homeJsonPath, existing)
    provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    expect(fs.readFileSync(homeJsonPath, 'utf8')).toBe(existing)
  })

  it('preserves existing claude-credentials.json content across re-runs (login persistence intent)', () => {
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    const credsPath = path.join(agentDir, 'claude-credentials.json')
    const existing = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-stub"}}\n'
    fs.writeFileSync(credsPath, existing)
    provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    expect(fs.readFileSync(credsPath, 'utf8')).toBe(existing)
  })

  it('writes seeded persistence files with restrictive 0600 perms', () => {
    provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    const homeMode = fs.statSync(path.join(agentDir, 'claude-home.json')).mode & 0o777
    const credsMode = fs.statSync(path.join(agentDir, 'claude-credentials.json')).mode & 0o777
    expect(homeMode).toBe(0o600)
    expect(credsMode).toBe(0o600)
  })
})

describe('migrateAgentPersistence', () => {
  let tmpHome: string
  const fromId = '77777777-7777-7777-7777-777777777777'
  const toId = '88888888-8888-8888-8888-888888888888'

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-mig-'))
    const fromDir = path.join(tmpHome, '.aimaestro', 'agents', fromId)
    fs.mkdirSync(path.join(fromDir, 'gh-config'), { recursive: true })
    fs.writeFileSync(path.join(fromDir, 'claude-home.json'),
      '{"hasCompletedOnboarding":true,"projects":{"/workspace":{"hasTrustDialogAccepted":true}}}\n', { mode: 0o600 })
    fs.writeFileSync(path.join(fromDir, 'claude-credentials.json'),
      '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-from-pred"}}\n', { mode: 0o600 })
    fs.writeFileSync(path.join(fromDir, 'gh-config', 'hosts.yml'),
      'github.com:\n    user: test\n', { mode: 0o600 })
  })

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('copies claude-home.json content from predecessor', () => {
    migrateAgentPersistence(fromId, toId, tmpHome)
    const dst = path.join(tmpHome, '.aimaestro', 'agents', toId, 'claude-home.json')
    const body = JSON.parse(fs.readFileSync(dst, 'utf8'))
    expect(body.hasCompletedOnboarding).toBe(true)
    expect(body.projects['/workspace'].hasTrustDialogAccepted).toBe(true)
  })

  it('copies claude-credentials.json content from predecessor', () => {
    migrateAgentPersistence(fromId, toId, tmpHome)
    const dst = path.join(tmpHome, '.aimaestro', 'agents', toId, 'claude-credentials.json')
    const body = JSON.parse(fs.readFileSync(dst, 'utf8'))
    expect(body.claudeAiOauth.accessToken).toBe('sk-ant-oat01-from-pred')
  })

  it('migrates gh-config recursively (hosts.yml etc.)', () => {
    migrateAgentPersistence(fromId, toId, tmpHome)
    const dst = path.join(tmpHome, '.aimaestro', 'agents', toId, 'gh-config', 'hosts.yml')
    expect(fs.existsSync(dst)).toBe(true)
    expect(fs.readFileSync(dst, 'utf8')).toContain('github.com:')
  })

  it('preserves restrictive 0600 mode on copied JSON files', () => {
    migrateAgentPersistence(fromId, toId, tmpHome)
    const home = path.join(tmpHome, '.aimaestro', 'agents', toId, 'claude-home.json')
    const creds = path.join(tmpHome, '.aimaestro', 'agents', toId, 'claude-credentials.json')
    expect(fs.statSync(home).mode & 0o777).toBe(0o600)
    expect(fs.statSync(creds).mode & 0o777).toBe(0o600)
  })

  it('no-ops when fromAgentId is empty', () => {
    migrateAgentPersistence('', toId, tmpHome)
    const dst = path.join(tmpHome, '.aimaestro', 'agents', toId)
    expect(fs.existsSync(dst)).toBe(false)
  })

  it('no-ops when fromAgentId equals toAgentId', () => {
    expect(() => migrateAgentPersistence(fromId, fromId, tmpHome)).not.toThrow()
    // Source files unchanged
    const home = path.join(tmpHome, '.aimaestro', 'agents', fromId, 'claude-home.json')
    expect(fs.readFileSync(home, 'utf8')).toContain('hasCompletedOnboarding')
  })

  it('no-ops gracefully when predecessor dir is absent (legacy agent recreate)', () => {
    expect(() => migrateAgentPersistence('00000000-0000-0000-0000-000000000000', toId, tmpHome)).not.toThrow()
    const dst = path.join(tmpHome, '.aimaestro', 'agents', toId)
    // Migration short-circuits before mkdir when source is missing — new dir
    // will be (re-)created later by provisionCloudClaudeConfig.
    expect(fs.existsSync(dst)).toBe(false)
  })

  it('skips individual asset copies that error without aborting the whole migration', () => {
    // Predecessor has only claude-home.json; credentials + gh missing
    const partialFromId = 'aaaaaaaa-1111-1111-1111-111111111111'
    const partialDir = path.join(tmpHome, '.aimaestro', 'agents', partialFromId)
    fs.mkdirSync(partialDir, { recursive: true })
    fs.writeFileSync(path.join(partialDir, 'claude-home.json'), '{"keep":true}\n', { mode: 0o600 })

    migrateAgentPersistence(partialFromId, toId, tmpHome)
    const newDir = path.join(tmpHome, '.aimaestro', 'agents', toId)
    expect(fs.existsSync(path.join(newDir, 'claude-home.json'))).toBe(true)
    expect(fs.existsSync(path.join(newDir, 'claude-credentials.json'))).toBe(false)
    expect(fs.existsSync(path.join(newDir, 'gh-config'))).toBe(false)
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

// ─── buildRecreateBody — registry → DockerCreateRequest field mapping ───
//
// This is the unit that closes the cluster surfaced 2026-04-28 (kanban
// 5e4ebdd5): post-recreate cloud agents had `programArgs: --yolo` in their
// registry profile but no --yolo in the container's AI_TOOL env. Root cause
// was the operator-assembled docker-create body dropping fields the operator
// didn't remember to forward. The recreate endpoint now builds the body
// server-side via this helper, so the registry → container mapping is
// exhaustive by construction.
describe('buildRecreateBody', () => {
  function makeCloudAgent(overrides: Partial<Agent> = {}): Agent {
    return {
      id: 'old-uuid-aaaaaaaa',
      name: 'ops-exec-test',
      label: 'TestAgent',
      avatar: '🧪',
      sessions: [],
      hostId: 'test-host',
      program: 'claude',
      taskDescription: 'test',
      tools: { claude: true },
      status: 'online',
      createdAt: '2026-04-28T00:00:00Z',
      lastActive: '2026-04-28T00:00:00Z',
      deployment: {
        type: 'cloud',
        cloud: {
          provider: 'local-container',
          containerName: 'aim-ops-exec-test',
          status: 'running',
        },
      },
      ...overrides,
    } as Agent
  }

  it('maps programArgs from registry into the create body', () => {
    const agent = makeCloudAgent({ programArgs: '--yolo' })
    expect(buildRecreateBody(agent).programArgs).toBe('--yolo')
  })

  it('maps model from registry into the create body', () => {
    const agent = makeCloudAgent({ model: 'claude-sonnet-4-6' })
    expect(buildRecreateBody(agent).model).toBe('claude-sonnet-4-6')
  })

  it('maps workingDirectory from registry', () => {
    const agent = makeCloudAgent({ workingDirectory: '/home/gosub/distill' })
    expect(buildRecreateBody(agent).workingDirectory).toBe('/home/gosub/distill')
  })

  it('maps sandbox.mounts from deployment into top-level body.mounts', () => {
    const mounts: SandboxMount[] = [
      { hostPath: '/mnt/agents/hardin', containerPath: '/mnt/agents/hardin' },
    ]
    const agent = makeCloudAgent({
      deployment: {
        type: 'cloud',
        cloud: { provider: 'local-container', containerName: 'aim-x', status: 'running' },
        sandbox: { mounts },
      },
    })
    expect(buildRecreateBody(agent).mounts).toEqual(mounts)
  })

  it('preserves identity fields (name, label, avatar, hostId, program)', () => {
    const agent = makeCloudAgent()
    const body = buildRecreateBody(agent)
    expect(body.name).toBe('ops-exec-test')
    expect(body.label).toBe('TestAgent')
    expect(body.avatar).toBe('🧪')
    expect(body.hostId).toBe('test-host')
    expect(body.program).toBe('claude')
  })

  it('omits container-derived fields (containerName/port/websocketUrl regenerate at create)', () => {
    const agent = makeCloudAgent()
    const body = buildRecreateBody(agent)
    // No keys at the top of DockerCreateRequest carry container-state — they're
    // recomputed by createDockerAgent from `name` + auto-allocated port.
    expect(body).not.toHaveProperty('containerName')
    expect(body).not.toHaveProperty('port')
    expect(body).not.toHaveProperty('websocketUrl')
  })

  it('handles missing optional fields cleanly', () => {
    const agent = makeCloudAgent({
      label: undefined,
      avatar: undefined,
      programArgs: undefined,
      model: undefined,
      workingDirectory: undefined,
    })
    const body = buildRecreateBody(agent)
    // Required fields stay; optional fields are undefined (createDockerAgent
    // applies its own defaults — workDir → /tmp, program → 'claude' etc.)
    expect(body.name).toBe('ops-exec-test')
    expect(body.programArgs).toBeUndefined()
    expect(body.model).toBeUndefined()
    expect(body.workingDirectory).toBeUndefined()
  })

  it('handles missing deployment.sandbox without throwing', () => {
    const agent = makeCloudAgent() // no sandbox key at all
    expect(buildRecreateBody(agent).mounts).toBeUndefined()
  })
})

describe('RECREATE_PRESERVED_FIELDS', () => {
  it('lists agent-record fields that are NOT part of DockerCreateRequest', () => {
    // Pin the contract: these fields live on Agent but not DockerCreateRequest,
    // so recreate must patch them onto the new agent post-create. Adding to
    // this list = adding a preservation; removing = an explicit drop.
    expect(RECREATE_PRESERVED_FIELDS).toEqual([
      'hooks',
      'taskDescription',
      'tags',
      'capabilities',
      'role',
      'team',
      'documentation',
      'metadata',
      'skills',
      'preferences',
      'meshAware',
      'owner',
    ])
  })

  it('does not include fields that re-derive at create time', () => {
    // Container/host-state fields must NOT be in this list. If any of these
    // appear, recreate would copy stale values from the dead agent onto the
    // new one (e.g. old containerName, old AMP fingerprint).
    const mustNotInclude = [
      'id', 'sessions', 'createdAt', 'lastActive', 'status',
      'deployment', 'ampIdentity', 'launchCount',
      'hostName', 'hostUrl', 'isSelf',
    ]
    for (const field of mustNotInclude) {
      expect(RECREATE_PRESERVED_FIELDS).not.toContain(field)
    }
  })
})
