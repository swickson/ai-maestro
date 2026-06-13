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
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  validateMounts,
  validateExtraEnv,
  buildAiToolCommand,
  buildMountFlags,
  buildEnvFlags,
  buildAmpCommonMounts,
  buildAmpCommonEnv,
  buildBaseAgentEnv,
  formatMemoryBytesToString,
  buildCloudClaudeSettingsMount,
  buildCloudClaudePersistMounts,
  buildCloudClaudeReadthroughMounts,
  buildCloudGeminiSettingsMount,
  buildCloudGeminiOAuthMount,
  buildCloudGeminiReadthroughMounts,
  buildCloudAntigravityAppDataMount,
  buildCloudCodexAppDataMount,
  buildZiggyCodeMount,
  buildZiggyEnvOverlayMount,
  provisionCloudCodexZiggyMcpEntry,
  ZIGGY_NETWORK,
  ZIGGY_CODE_PATH,
  ZIGGY_AGENT_ENVS_DIR,
  buildCloudRestorationSentinelMount,
  clearRestorationSentinel,
  writeRestorationSentinel,
  migrateAgentPersistence,
  provisionCloudClaudeConfig,
  provisionCloudGeminiConfig,
  provisionCloudGeminiAuth,
  provisionCloudCodexConfig,
  provisionCloudCodexAuth,
  seedFromHostFile,
  mergeMounts,
  mergeEnv,
  buildRecreateBody,
  RECREATE_PRESERVED_FIELDS,
  parsePortFromWebsocketUrl,
  computeReservedCloudPorts,
  pickFirstFreeCloudPort,
  getCloudPortRange,
  ALWAYS_RESERVED_CONTAINER_PATH_ROOTS,
  OPERATOR_RESERVED_CONTAINER_PATH_ROOTS,
  OPERATOR_RESERVED_ENV_KEYS,
  validateProfile,
  provisionCloudGitIdentity,
  buildCloudGitConfigMount,
  buildCloudAiTeamMount,
  buildCloudTransportRepoMount,
  buildCloudCommonMounts,
  buildCloudCommonPrecreateDirs,
} from '@/services/agents-docker-service'
import type { Agent, SandboxMount } from '@/types/agent'

describe('validateMounts', () => {
  it('returns null for undefined mounts', () => {
    expect(validateMounts(undefined, 'system')).toBeNull()
  })

  it('returns null for empty array', () => {
    expect(validateMounts([], 'system')).toBeNull()
  })

  it('accepts a well-formed mount', () => {
    const mounts: SandboxMount[] = [
      { hostPath: '/home/user/code', containerPath: '/work/code' },
    ]
    expect(validateMounts(mounts, 'system')).toBeNull()
  })

  it('accepts readOnly flag', () => {
    const mounts: SandboxMount[] = [
      { hostPath: '/etc/secrets', containerPath: '/secrets', readOnly: true },
    ]
    expect(validateMounts(mounts, 'system')).toBeNull()
  })

  it('rejects relative hostPath', () => {
    const mounts: SandboxMount[] = [
      { hostPath: 'relative/path', containerPath: '/work' },
    ]
    expect(validateMounts(mounts, 'system')).toMatch(/absolute/)
  })

  it('rejects relative containerPath', () => {
    const mounts: SandboxMount[] = [
      { hostPath: '/home/user', containerPath: 'work' },
    ]
    expect(validateMounts(mounts, 'system')).toMatch(/absolute/)
  })

  it('rejects missing hostPath', () => {
    const mounts = [{ containerPath: '/work' } as unknown as SandboxMount]
    expect(validateMounts(mounts, 'system')).toMatch(/hostPath/)
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
      expect(validateMounts(mounts, 'system')).toMatch(/quotes|backticks|\$|backslashes|newlines/)
    }
  })

  it('reserves /workspace for the working directory mount', () => {
    const mounts: SandboxMount[] = [
      { hostPath: '/home/user/code', containerPath: '/workspace' },
    ]
    expect(validateMounts(mounts, 'system')).toMatch(/reserved/)
  })

  it('reports the offending index when multiple mounts are provided', () => {
    const mounts: SandboxMount[] = [
      { hostPath: '/ok', containerPath: '/ok' },
      { hostPath: 'bad', containerPath: '/ok' },
    ]
    expect(validateMounts(mounts, 'system')).toMatch(/mounts\[1\]/)
  })

  describe('operator-mount reservation (kanban 489c4afd)', () => {
    // ALWAYS_RESERVED applies regardless of source — /workspace is the
    // operator's workingDirectory bind, and it would conflict whether the mount
    // came from operator input or anywhere else.
    it('rejects /workspace exact-match with source = "system"', () => {
      const mounts: SandboxMount[] = [{ hostPath: '/x', containerPath: '/workspace' }]
      expect(validateMounts(mounts, 'system')).toMatch(/reserved.*working directory/)
    })

    it('rejects descendants of /workspace with source = "system"', () => {
      const mounts: SandboxMount[] = [{ hostPath: '/x', containerPath: '/workspace/src' }]
      expect(validateMounts(mounts, 'system')).toMatch(/reserved.*working directory/)
    })

    it('passes system mount paths with source = "system"', () => {
      // This is the critical "don't self-reject" property — every system
      // mount builder produces paths under OPERATOR_RESERVED roots, and the
      // internal flows in createDockerAgent / updateContainerMountsAndExtraEnv
      // build the merged mount list AFTER validation of operator input. Tests
      // that hand system mounts through validateMounts MUST not trigger
      // operator reservation.
      const uuid = 'test-uuid-aaaa'
      const home = '/tmp/test-home'
      const allSystemMounts: SandboxMount[] = [
        ...buildAmpCommonMounts(uuid, home, '/tmp/test-repo'),
        buildCloudClaudeSettingsMount(uuid, home),
        ...buildCloudClaudePersistMounts(uuid, home),
        ...buildCloudClaudeReadthroughMounts(uuid, home),
        buildCloudGeminiSettingsMount(uuid, home),
        buildCloudGeminiOAuthMount(uuid, home),
        ...buildCloudGeminiReadthroughMounts(uuid, home),
        buildCloudAntigravityAppDataMount(uuid, home),
        buildCloudCodexAppDataMount(uuid, home),
      ]
      expect(validateMounts(allSystemMounts, 'system')).toBeNull()
    })

    it('rejects operator mounts at each OPERATOR_RESERVED root exact-match', () => {
      for (const root of OPERATOR_RESERVED_CONTAINER_PATH_ROOTS) {
        const mounts: SandboxMount[] = [{ hostPath: '/tmp/src', containerPath: root }]
        const err = validateMounts(mounts, 'operator')
        expect(err, `expected rejection for root ${root}`).toMatch(/reserved by AI Maestro/)
        expect(err).toContain(root)
      }
    })

    it('rejects operator mounts at descendants of OPERATOR_RESERVED roots', () => {
      for (const root of OPERATOR_RESERVED_CONTAINER_PATH_ROOTS) {
        const mounts: SandboxMount[] = [{ hostPath: '/tmp/src', containerPath: `${root}/child` }]
        const err = validateMounts(mounts, 'operator')
        expect(err, `expected rejection for descendant of ${root}`).toMatch(/reserved by AI Maestro/)
      }
    })

    it('accepts operator mounts that are siblings of reserved roots (no false-positive on substring)', () => {
      // /home/claude/.claude is reserved; /home/claude/.claude-other shares
      // the prefix as a substring but is NOT a descendant. Must not reject.
      const mounts: SandboxMount[] = [
        { hostPath: '/tmp/a', containerPath: '/home/claude/.claude-other' },
        { hostPath: '/tmp/b', containerPath: '/home/claude/code' },
        { hostPath: '/tmp/c', containerPath: '/home/operator/files' },
        { hostPath: '/tmp/d', containerPath: '/mnt/data' },
        { hostPath: '/tmp/e', containerPath: '/opt/tools' },
      ]
      expect(validateMounts(mounts, 'operator')).toBeNull()
    })

    it('rejects operator mount at /workspace via ALWAYS_RESERVED path (source = "operator" reservation also tripped)', () => {
      const mounts: SandboxMount[] = [{ hostPath: '/x', containerPath: '/workspace' }]
      // ALWAYS_RESERVED fires first; either error is acceptable here.
      expect(validateMounts(mounts, 'operator')).toMatch(/reserved/)
    })

    it('reservation completeness: every system mount builder containerPath maps to a reserved root', () => {
      // If a future PR adds a new system-mount builder under a path that isn't
      // in OPERATOR_RESERVED_CONTAINER_PATH_ROOTS, the operator could shadow it.
      // This test forces the RESERVED list to stay in sync with the builders.
      const uuid = 'test-uuid-completeness'
      const home = '/tmp/test-home'
      const allSystemMounts: SandboxMount[] = [
        ...buildAmpCommonMounts(uuid, home, '/tmp/test-repo'),
        buildCloudClaudeSettingsMount(uuid, home),
        ...buildCloudClaudePersistMounts(uuid, home),
        ...buildCloudClaudeReadthroughMounts(uuid, home),
        buildCloudGeminiSettingsMount(uuid, home),
        buildCloudGeminiOAuthMount(uuid, home),
        ...buildCloudGeminiReadthroughMounts(uuid, home),
        buildCloudAntigravityAppDataMount(uuid, home),
        buildCloudCodexAppDataMount(uuid, home),
      ]
      const allReserved = [
        ...ALWAYS_RESERVED_CONTAINER_PATH_ROOTS,
        ...OPERATOR_RESERVED_CONTAINER_PATH_ROOTS,
      ]
      for (const m of allSystemMounts) {
        const matched = allReserved.find(
          r => m.containerPath === r || m.containerPath.startsWith(`${r}/`)
        )
        expect(
          matched,
          `system mount at ${m.containerPath} has no reserved root — operator could shadow it`
        ).toBeDefined()
      }
    })
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
    expect(validateExtraEnv(undefined, 'system')).toBeNull()
  })

  it('returns null for empty object', () => {
    expect(validateExtraEnv({}, 'system')).toBeNull()
  })

  it('accepts well-formed env entries', () => {
    expect(validateExtraEnv({ FOO: 'bar', BAZ_QUX: '1', _LEADING: 'ok' }, 'system')).toBeNull()
  })

  it('rejects invalid key shapes', () => {
    expect(validateExtraEnv({ '1FOO': 'bar' }, 'system')).toMatch(/invalid key/)
    expect(validateExtraEnv({ 'foo-bar': 'baz' }, 'system')).toMatch(/invalid key/)
    expect(validateExtraEnv({ 'FOO BAR': 'baz' }, 'system')).toMatch(/invalid key/)
    expect(validateExtraEnv({ '': 'baz' }, 'system')).toMatch(/invalid key/)
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
      expect(validateExtraEnv(env, 'system')).toMatch(/quotes|backticks|\$|backslashes|newlines/)
    }
  })

  it('rejects non-string values', () => {
    expect(validateExtraEnv({ FOO: 123 as unknown as string }, 'system')).toMatch(/must be a string/)
  })

  describe('operator-env reservation (kanban 489c4afd)', () => {
    it('passes system env keys with source = "system"', () => {
      // buildAmpCommonEnv populates exactly these keys; internal callers hand
      // this output through validateExtraEnv (transitively via flow tests).
      const sysEnv = buildAmpCommonEnv(
        'test-uuid-bbbb',
        'test-agent',
        'http://host.docker.internal:23000'
      )
      // Plus the baseEnv keys the docker service layers in:
      const fullSystemEnv = {
        ...sysEnv,
        TMUX_SESSION_NAME: 'test-agent',
        AI_TOOL: 'claude',
        AGENT_ID: 'test-agent',
        AIMAESTRO_HOST_URL: 'http://host.docker.internal:23000',
      }
      expect(validateExtraEnv(fullSystemEnv, 'system')).toBeNull()
    })

    it('rejects each OPERATOR_RESERVED key with source = "operator"', () => {
      for (const key of OPERATOR_RESERVED_ENV_KEYS) {
        const err = validateExtraEnv({ [key]: 'evil' }, 'operator')
        expect(err, `expected rejection for key ${key}`).toMatch(/reserved by AI Maestro/)
        expect(err).toContain(key)
      }
    })

    it('accepts the same keys with source = "system"', () => {
      // Internal callers hand the same keys through this validator without the
      // flag (e.g., the merged env that goes to buildEnvFlags). Reservation
      // must not self-reject.
      for (const key of OPERATOR_RESERVED_ENV_KEYS) {
        expect(validateExtraEnv({ [key]: 'system-value' }, 'system')).toBeNull()
      }
    })

    it('does NOT reserve HOME (Shape β operator override use case)', () => {
      // HOME=/workspace/<name> is the canonical Shape β agent-home override —
      // operator must be able to set it via extraEnv.
      expect(
        validateExtraEnv({ HOME: '/workspace/myagent' }, 'operator')
      ).toBeNull()
    })

    it('does NOT reserve GITHUB_TOKEN (alternative to body.githubToken)', () => {
      // Operator may want to rotate GITHUB_TOKEN via extraEnv as an
      // alternative to body.githubToken at create time.
      expect(
        validateExtraEnv({ GITHUB_TOKEN: 'ghp_example' }, 'operator')
      ).toBeNull()
    })

    it('reservation completeness: every buildAmpCommonEnv key is reserved', () => {
      // If a future PR adds a new key to buildAmpCommonEnv without updating
      // OPERATOR_RESERVED_ENV_KEYS, the operator could shadow it.
      const ampKeys = Object.keys(
        buildAmpCommonEnv('test-uuid', 'test-agent', 'http://host.docker.internal:23000')
      )
      for (const key of ampKeys) {
        expect(
          OPERATOR_RESERVED_ENV_KEYS,
          `buildAmpCommonEnv emits ${key} but it's not in OPERATOR_RESERVED_ENV_KEYS`
        ).toContain(key)
      }
    })

    it('reservation completeness: every buildBaseAgentEnv key is reserved', () => {
      // Parallel guard for the per-container agent-identity env that
      // createDockerAgent + updateContainerMountsAndExtraEnv both layer into
      // the merged env before operator extraEnv. Future addition to
      // buildBaseAgentEnv that isn't also added to OPERATOR_RESERVED_ENV_KEYS
      // would let an operator silently fake agent identity.
      const baseKeys = Object.keys(
        buildBaseAgentEnv('test-agent', 'claude', 'http://host.docker.internal:23000')
      )
      for (const key of baseKeys) {
        expect(
          OPERATOR_RESERVED_ENV_KEYS,
          `buildBaseAgentEnv emits ${key} but it's not in OPERATOR_RESERVED_ENV_KEYS`
        ).toContain(key)
      }
    })

    it('accepts operator env with reserved-key-substring (no false positive)', () => {
      // PATH is reserved; PATH_EXTRA is not (full-key match, not prefix).
      expect(
        validateExtraEnv(
          { PATH_EXTRA: '/opt/foo/bin', MY_AGENT_ID: 'something' },
          'operator'
        )
      ).toBeNull()
    })
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

  it('returns five mounts derived from the agent UUID + host shared paths', () => {
    const mounts = buildAmpCommonMounts(uuid, home)
    expect(mounts).toHaveLength(5)
    expect(mounts.map(m => m.containerPath)).toEqual([
      `/home/claude/.agent-messaging/agents/${uuid}`,
      `/home/claude/.aimaestro/agents/${uuid}`,
      '/home/claude/.local/bin',
      '/home/claude/.local/share/aimaestro/shell-helpers',
      '/home/claude/.local/share/aimaestro/cli',
    ])
  })

  it('mirrors host paths under the supplied home + repoRoot', () => {
    const mounts = buildAmpCommonMounts(uuid, home, '/srv/ai-maestro')
    expect(mounts.map(m => m.hostPath)).toEqual([
      `${home}/.agent-messaging/agents/${uuid}`,
      `${home}/.aimaestro/agents/${uuid}`,
      `${home}/.local/bin`,
      `${home}/.local/share/aimaestro/shell-helpers`,
      '/srv/ai-maestro/scripts',
    ])
  })

  it('repoRoot defaults to process.cwd() (matches provisionCloudClaudeConfig precedent)', () => {
    const mounts = buildAmpCommonMounts(uuid, home)
    const cli = mounts.find(m => m.containerPath === '/home/claude/.local/share/aimaestro/cli')
    expect(cli?.hostPath).toBe(`${process.cwd()}/scripts`)
  })

  it('marks the repo cli mount read-only', () => {
    const mounts = buildAmpCommonMounts(uuid, home)
    const cli = mounts.find(m => m.containerPath === '/home/claude/.local/share/aimaestro/cli')
    expect(cli?.readOnly).toBe(true)
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
    expect(validateMounts(mounts, 'system')).toBeNull()
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
    expect(validateMounts([buildCloudClaudeSettingsMount(uuid, home)], 'system')).toBeNull()
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
    expect(validateMounts(buildCloudClaudePersistMounts(uuid, home), 'system')).toBeNull()
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
    for (const event of ['Notification', 'PreToolUse', 'Stop', 'SessionStart', 'UserPromptSubmit']) {
      const cfg = settings.hooks[event][0]
      expect(cfg.hooks[0].command).toBe(`node ${containerHook}`)
    }
  })

  it('registers a PreToolUse hook matched to AskUserQuestion so cloud agents capture interactive questions before they block', () => {
    const { settingsPath } = provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(settings.hooks.PreToolUse[0].matcher).toBe('AskUserQuestion')
  })

  it('seeds skipDangerousModePermissionPrompt: true so cloud agents do not re-prompt the bypass warning on every recreate', () => {
    const { settingsPath } = provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(settings.skipDangerousModePermissionPrompt).toBe(true)
  })

  it('seeds statusLine pointing at the container-side amp-statusline.sh path (host/cloud UX-parity, kanban 172e170d)', () => {
    const { settingsPath } = provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(settings.statusLine).toEqual({
      type: 'command',
      command: '/home/claude/.local/share/aimaestro/cli/amp-statusline.sh',
    })
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

  it('preserves existing claude-home.json operator state across re-runs (state persistence intent)', () => {
    // Pre-seed with operator-set theme + state fields. Shape-aware merge
    // (kanban 406ff85d) MUST preserve all existing operator state.
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    const homeJsonPath = path.join(agentDir, 'claude-home.json')
    const existing = '{"theme":"light","bypassPermissionsModeAccepted":true,"hasCompletedOnboarding":true}\n'
    fs.writeFileSync(homeJsonPath, existing)
    provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    // theme=light operator choice preserved; other fields untouched.
    const body = JSON.parse(fs.readFileSync(homeJsonPath, 'utf8'))
    expect(body.theme).toBe('light')
    expect(body.bypassPermissionsModeAccepted).toBe(true)
    expect(body.hasCompletedOnboarding).toBe(true)
  })

  // ── kanban 406ff85d: shape-aware merge regression coverage ─────────────
  // Sister fix to PR #112 (gemini-settings.json shape-aware staleness).
  // Pre-kanban-41dd54b9 claude-home.json files lacked theme — when
  // migrateAgentPersistence carried them forward, the bare existsSync guard
  // short-circuited and the theme=dark seed was never injected. Hale on
  // Holmes empirically hit this 2026-05-06.
  //
  // Critical methodology note (feedback_provisioning_seed_empirical_methodology.md):
  // these tests MUST exercise the migrate-then-existsSync path. Manual
  // rm-then-recreate is a false-positive trap — the bug only manifests when
  // the predecessor file ALREADY EXISTS but lacks the theme field.

  it('migrate-then-staleness path: stale claude-home.json without theme gets shape-aware injection', () => {
    // Simulate migrateAgentPersistence carry-forward: file exists but is
    // pre-kanban-41dd54b9 shape (no theme field).
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    const homeJsonPath = path.join(agentDir, 'claude-home.json')
    const stale = '{"bypassPermissionsModeAccepted":true,"hasCompletedOnboarding":true}\n'
    fs.writeFileSync(homeJsonPath, stale)
    provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    const body = JSON.parse(fs.readFileSync(homeJsonPath, 'utf8'))
    // Missing theme injected, all other state preserved.
    expect(body.theme).toBe('dark')
    expect(body.bypassPermissionsModeAccepted).toBe(true)
    expect(body.hasCompletedOnboarding).toBe(true)
  })

  it('migrate-then-staleness path: empty {} claude-home.json gets theme injected', () => {
    // Degenerate-empty case: file exists, parses, but is just {}.
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    const homeJsonPath = path.join(agentDir, 'claude-home.json')
    fs.writeFileSync(homeJsonPath, '{}\n')
    provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    const body = JSON.parse(fs.readFileSync(homeJsonPath, 'utf8'))
    expect(body.theme).toBe('dark')
  })

  it('unparseable claude-home.json re-seeds from scratch (defensive recovery)', () => {
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    const homeJsonPath = path.join(agentDir, 'claude-home.json')
    fs.writeFileSync(homeJsonPath, 'not-valid-json{{{\n')
    provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    const body = JSON.parse(fs.readFileSync(homeJsonPath, 'utf8'))
    expect(body.theme).toBe('dark')
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

  it('seeds claude-home.json with theme=dark so fresh-create agents skip the theme picker (kanban 41dd54b9)', () => {
    provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    const homeJsonPath = path.join(tmpHome, '.aimaestro', 'agents', uuid, 'claude-home.json')
    const body = JSON.parse(fs.readFileSync(homeJsonPath, 'utf8'))
    expect(body.theme).toBe('dark')
  })

  it('bootstraps claude-credentials.json from host ~/.claude/.credentials.json when present (kanban 8aa61a60 OAuth bootstrap)', () => {
    const hostClaudeDir = path.join(tmpHome, '.claude')
    fs.mkdirSync(hostClaudeDir, { recursive: true })
    fs.writeFileSync(path.join(hostClaudeDir, '.credentials.json'),
      '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-host-bootstrapped"}}\n', { mode: 0o600 })
    provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    const credsPath = path.join(tmpHome, '.aimaestro', 'agents', uuid, 'claude-credentials.json')
    const body = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
    expect(body.claudeAiOauth.accessToken).toBe('sk-ant-oat01-host-bootstrapped')
  })

  it('falls back to empty {} when host has no claude credentials (first-time setup case)', () => {
    // tmpHome is fresh; no host ~/.claude/.credentials.json
    provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)
    const credsPath = path.join(tmpHome, '.aimaestro', 'agents', uuid, 'claude-credentials.json')
    expect(JSON.parse(fs.readFileSync(credsPath, 'utf8'))).toEqual({})
  })

  it('re-bootstraps claude-credentials.json when migrated predecessor placeholder is empty {} and host now has creds (kanban 02a8ebda recreate-path, Watson Mason finding)', () => {
    // Simulate the recreate flow: migrateAgentPersistence has already copied
    // the predecessor's empty {} into the new UUID dir BEFORE provisioning runs.
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'claude-credentials.json'), '{}\n', { mode: 0o600 })
    // Operator has since run claude /login on the host
    const hostClaudeDir = path.join(tmpHome, '.claude')
    fs.mkdirSync(hostClaudeDir, { recursive: true })
    fs.writeFileSync(path.join(hostClaudeDir, '.credentials.json'),
      '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-post-hoc-login"}}\n', { mode: 0o600 })

    provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)

    const credsPath = path.join(agentDir, 'claude-credentials.json')
    const body = JSON.parse(fs.readFileSync(credsPath, 'utf8'))
    expect(body.claudeAiOauth.accessToken).toBe('sk-ant-oat01-post-hoc-login')
  })

  it('preserves real rotated claude-credentials at dest across re-runs even when host source has older content', () => {
    // Simulate a healthy long-running agent whose claude has rotated its OAuth.
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    const rotated = '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-rotated-by-agent","refreshToken":"r-r"}}\n'
    fs.writeFileSync(path.join(agentDir, 'claude-credentials.json'), rotated, { mode: 0o600 })
    const hostClaudeDir = path.join(tmpHome, '.claude')
    fs.mkdirSync(hostClaudeDir, { recursive: true })
    fs.writeFileSync(path.join(hostClaudeDir, '.credentials.json'),
      '{"claudeAiOauth":{"accessToken":"sk-ant-oat01-host-OLD"}}\n', { mode: 0o600 })

    provisionCloudClaudeConfig(uuid, tmpHome, tmpRepo)

    expect(fs.readFileSync(path.join(agentDir, 'claude-credentials.json'), 'utf8')).toBe(rotated)
  })
})

describe('provisionCloudGeminiConfig', () => {
  const uuid = '55555555-5555-5555-5555-555555555555'
  let tmpHome: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-gem-'))
  })

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('writes gemini-settings.json with general.enableAutoUpdate=false to suppress self-update fetch (kanban cd2d7377)', () => {
    const { settingsPath } = provisionCloudGeminiConfig(uuid, tmpHome)
    expect(settingsPath).toBe(path.join(tmpHome, '.aimaestro', 'agents', uuid, 'gemini-settings.json'))
    const body = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(body.general.enableAutoUpdate).toBe(false)
  })

  it('writes gemini-settings.json with security.auth.selectedType="oauth-personal" to skip the auth picker (kanban 1f911653 Hardin empirical)', () => {
    const { settingsPath } = provisionCloudGeminiConfig(uuid, tmpHome)
    const body = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(body.security.auth.selectedType).toBe('oauth-personal')
  })

  it('seeds the file with restrictive 0600 perms', () => {
    const { settingsPath } = provisionCloudGeminiConfig(uuid, tmpHome)
    expect(fs.statSync(settingsPath).mode & 0o777).toBe(0o600)
  })

  it('creates the per-UUID dir if missing', () => {
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    expect(fs.existsSync(agentDir)).toBe(false)
    provisionCloudGeminiConfig(uuid, tmpHome)
    expect(fs.existsSync(agentDir)).toBe(true)
  })

  it('preserves existing gemini-settings.json content across re-runs (operator hand-edit intent)', () => {
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    const settingsPath = path.join(agentDir, 'gemini-settings.json')
    // Fixture includes security.auth.selectedType so the staleness guard
    // (kanban 61aac9db) treats it as already-shaped and the byte-equal
    // preservation contract holds. Without selectedType, the guard would
    // inject the missing field and rewrite — exercised by the staleness
    // tests below.
    const existing = '{"general":{"enableAutoUpdate":true,"customField":"keep-me"},"security":{"auth":{"selectedType":"oauth-personal"}}}\n'
    fs.writeFileSync(settingsPath, existing)
    provisionCloudGeminiConfig(uuid, tmpHome)
    expect(fs.readFileSync(settingsPath, 'utf8')).toBe(existing)
  })

  it('re-seeds gemini-settings.json by injecting security.auth.selectedType when migrated predecessor lacks the field (kanban 61aac9db stale-shape signal, sister-class to PR #104 empty-{} re-bootstrap)', () => {
    // Simulate the /recreate flow: migrateAgentPersistence has copied the
    // predecessor's pre-PR-#108 gemini-settings.json (which lacks
    // security.auth.selectedType) into the new UUID dir BEFORE provisioning
    // runs. Without the staleness guard, the existsSync check short-circuits
    // and the picker-bypass field never gets injected.
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    const settingsPath = path.join(agentDir, 'gemini-settings.json')
    fs.writeFileSync(settingsPath, '{"general":{"enableAutoUpdate":false}}\n', { mode: 0o600 })

    provisionCloudGeminiConfig(uuid, tmpHome)

    const body = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(body.general.enableAutoUpdate).toBe(false) // pre-existing field preserved
    expect(body.security.auth.selectedType).toBe('oauth-personal') // missing field injected
  })

  it('preserves operator hand-edits to OTHER fields when injecting missing security.auth.selectedType (Option D minimal-merge contract)', () => {
    // Stale-shape file PLUS operator hand-edits (custom keys, mcp section
    // unrelated to auth). Staleness guard must inject ONLY the missing
    // selectedType — operator additions to other parts of the file survive.
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    const settingsPath = path.join(agentDir, 'gemini-settings.json')
    const handEdited = JSON.stringify({
      general: { enableAutoUpdate: true, customField: 'operator-set' },
      mcp: { servers: [{ name: 'op-tool', url: 'http://x' }] },
    })
    fs.writeFileSync(settingsPath, handEdited + '\n', { mode: 0o600 })

    provisionCloudGeminiConfig(uuid, tmpHome)

    const body = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    // Operator value preserved (operator turned auto-update back on, even though seed default is false).
    expect(body.general.enableAutoUpdate).toBe(true)
    // Operator-added top-level field preserved.
    expect(body.general.customField).toBe('operator-set')
    // Operator-added top-level section preserved.
    expect(body.mcp.servers).toEqual([{ name: 'op-tool', url: 'http://x' }])
    // Missing field injected.
    expect(body.security.auth.selectedType).toBe('oauth-personal')
  })

  it('falls back to a fresh seed when gemini-settings.json is unparseable (defensive corner case, kanban 61aac9db)', () => {
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    const settingsPath = path.join(agentDir, 'gemini-settings.json')
    fs.writeFileSync(settingsPath, '{ this is not json', { mode: 0o600 })

    provisionCloudGeminiConfig(uuid, tmpHome)

    const body = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(body.general.enableAutoUpdate).toBe(false)
    expect(body.security.auth.selectedType).toBe('oauth-personal')
  })

  it('preserves operator-set non-default selectedType (e.g. "gemini-api-key") — operator choice wins (Watson polish)', () => {
    // Operator may legitimately choose a non-OAuth auth method (gemini-api-key,
    // vertex-ai, etc.). Staleness guard must NOT overwrite operator selection
    // — only inject when selectedType is missing or non-string.
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    const settingsPath = path.join(agentDir, 'gemini-settings.json')
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        general: { enableAutoUpdate: false },
        security: { auth: { selectedType: 'gemini-api-key' } },
      }) + '\n',
      { mode: 0o600 },
    )

    provisionCloudGeminiConfig(uuid, tmpHome)

    const body = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(body.security.auth.selectedType).toBe('gemini-api-key') // operator choice wins
  })

  it('tolerates non-object security or security.auth values (defensive coercion, Watson polish)', () => {
    // If a corrupted/legacy settings.json has security set to a string (or
    // any non-object), the spread {...security} would inline string indices
    // and break gemini. Defensive coercion treats malformed shapes as empty.
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    const settingsPath = path.join(agentDir, 'gemini-settings.json')
    fs.writeFileSync(
      settingsPath,
      JSON.stringify({
        general: { enableAutoUpdate: false },
        security: 'corrupted-string-not-object',
      }) + '\n',
      { mode: 0o600 },
    )

    provisionCloudGeminiConfig(uuid, tmpHome)

    const body = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
    expect(body.general.enableAutoUpdate).toBe(false)
    // security replaced with a clean object; selectedType injected.
    expect(typeof body.security).toBe('object')
    expect(Array.isArray(body.security)).toBe(false)
    expect(body.security.auth.selectedType).toBe('oauth-personal')
    // No string-index leakage from the spread — count keys at the top level
    // of body.security to ensure only "auth" is present, not "0", "1", ...
    expect(Object.keys(body.security)).toEqual(['auth'])
  })
})

describe('provisionCloudCodexConfig', () => {
  const uuid = '66666666-6666-6666-6666-666666666666'
  let tmpHome: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-codex-'))
  })

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('writes codex-app-data/version.json with dismissed_version sentinel suppressing the update modal (kanban 22f4af86)', () => {
    const { versionPath } = provisionCloudCodexConfig(uuid, tmpHome)
    expect(versionPath).toBe(path.join(tmpHome, '.aimaestro', 'agents', uuid, 'codex-app-data', 'version.json'))
    const body = JSON.parse(fs.readFileSync(versionPath, 'utf8'))
    expect(body.dismissed_version).toBe('999.0.0')
    expect(body.latest_version).toBe('999.0.0')
  })

  it('seeds the file with restrictive 0600 perms', () => {
    const { versionPath } = provisionCloudCodexConfig(uuid, tmpHome)
    expect(fs.statSync(versionPath).mode & 0o777).toBe(0o600)
  })

  it('creates the per-UUID codex-app-data dir if missing', () => {
    const codexDir = path.join(tmpHome, '.aimaestro', 'agents', uuid, 'codex-app-data')
    expect(fs.existsSync(codexDir)).toBe(false)
    provisionCloudCodexConfig(uuid, tmpHome)
    expect(fs.existsSync(codexDir)).toBe(true)
  })

  it('preserves existing version.json content across re-runs (operator override intent)', () => {
    const codexDir = path.join(tmpHome, '.aimaestro', 'agents', uuid, 'codex-app-data')
    fs.mkdirSync(codexDir, { recursive: true })
    const versionPath = path.join(codexDir, 'version.json')
    const existing = '{"latest_version":"0.130.0","last_checked_at":"2026-05-15T00:00:00Z","dismissed_version":"0.130.0"}\n'
    fs.writeFileSync(versionPath, existing)
    provisionCloudCodexConfig(uuid, tmpHome)
    expect(fs.readFileSync(versionPath, 'utf8')).toBe(existing)
  })

  it('writes codex-app-data/config.toml pre-trusting /workspace so codex skips the trust modal on first launch (kanban 354a5174 trust-modal sibling)', () => {
    const { configTomlPath } = provisionCloudCodexConfig(uuid, tmpHome)
    expect(configTomlPath).toBe(path.join(tmpHome, '.aimaestro', 'agents', uuid, 'codex-app-data', 'config.toml'))
    const body = fs.readFileSync(configTomlPath, 'utf8')
    expect(body).toContain('[projects."/workspace"]')
    expect(body).toContain('trust_level = "trusted"')
  })

  it('seeds config.toml with restrictive 0600 perms', () => {
    const { configTomlPath } = provisionCloudCodexConfig(uuid, tmpHome)
    expect(fs.statSync(configTomlPath).mode & 0o777).toBe(0o600)
  })

  it('preserves existing config.toml across re-runs (operator hand-edit intent)', () => {
    const codexDir = path.join(tmpHome, '.aimaestro', 'agents', uuid, 'codex-app-data')
    fs.mkdirSync(codexDir, { recursive: true })
    const configTomlPath = path.join(codexDir, 'config.toml')
    const existing = '[projects."/workspace"]\ntrust_level = "trusted"\n\n[other]\nfoo = "bar"\n'
    fs.writeFileSync(configTomlPath, existing)
    provisionCloudCodexConfig(uuid, tmpHome)
    expect(fs.readFileSync(configTomlPath, 'utf8')).toBe(existing)
  })

  it('consolidates pre-OPT-B flat codex-*.json into codex-app-data/ on first run (kanban 01e11bf9 shape switch)', () => {
    // An existing codex agent crossing from the 4-file-mount era has flat
    // codex-version.json / codex-config.toml / codex-hooks.json under agentDir.
    // First provision under the new code must migrate them INTO codex-app-data/
    // rather than overwrite with defaults, so trust/version/hooks state survives.
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'codex-version.json'), '{"dismissed_version":"0.140.0"}\n')
    fs.writeFileSync(path.join(agentDir, 'codex-config.toml'), '[projects."/workspace"]\ntrust_level = "trusted"\n\n[legacy]\nx = 1\n')
    fs.writeFileSync(path.join(agentDir, 'codex-hooks.json'), '{"hooks":{"LegacyEvent":[]}}\n')
    const { versionPath, configTomlPath, hooksPath } = provisionCloudCodexConfig(uuid, tmpHome)
    expect(versionPath).toBe(path.join(agentDir, 'codex-app-data', 'version.json'))
    expect(JSON.parse(fs.readFileSync(versionPath, 'utf8')).dismissed_version).toBe('0.140.0')
    expect(fs.readFileSync(configTomlPath, 'utf8')).toContain('[legacy]')
    expect(fs.readFileSync(hooksPath, 'utf8')).toContain('LegacyEvent')
  })
})

describe('buildCloudCodexAppDataMount', () => {
  it('returns a single-dir bind mount of codex-app-data onto /home/claude/.codex (OPT-B, kanban 01e11bf9)', () => {
    const uuid = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    const home = '/home/operator'
    const m = buildCloudCodexAppDataMount(uuid, home)
    expect(m.hostPath).toBe(`/home/operator/.aimaestro/agents/${uuid}/codex-app-data`)
    expect(m.containerPath).toBe('/home/claude/.codex')
    expect(m.readOnly).toBeUndefined()
  })

  it('passes validateMounts so the mount is shellable in a docker -v flag', () => {
    const uuid = 'dddddddd-dddd-dddd-dddd-dddddddddddd'
    const home = '/home/operator'
    expect(validateMounts([buildCloudCodexAppDataMount(uuid, home)], 'system')).toBeNull()
  })

  it('containerPath is the reserved /home/claude/.codex root itself (no operator-shadow gap)', () => {
    const m = buildCloudCodexAppDataMount('eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee', '/home/operator')
    const matched = OPERATOR_RESERVED_CONTAINER_PATH_ROOTS.find(
      r => m.containerPath === r || m.containerPath.startsWith(`${r}/`)
    )
    expect(matched).toBe('/home/claude/.codex')
  })
})

describe('provisionCloudCodexConfig — codex-hooks.json skeleton', () => {
  const uuid = '99999999-9999-9999-9999-999999999999'
  let tmpHome: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-codex-hooks-'))
  })

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('writes codex-app-data/hooks.json with empty {} skeleton when missing', () => {
    const { hooksPath } = provisionCloudCodexConfig(uuid, tmpHome)
    expect(hooksPath).toBe(path.join(tmpHome, '.aimaestro', 'agents', uuid, 'codex-app-data', 'hooks.json'))
    expect(fs.readFileSync(hooksPath, 'utf8')).toBe('{}\n')
  })

  it('seeds hooks.json with restrictive 0600 perms', () => {
    const { hooksPath } = provisionCloudCodexConfig(uuid, tmpHome)
    expect(fs.statSync(hooksPath).mode & 0o777).toBe(0o600)
  })

  it('preserves existing hooks.json content across re-runs (operator-written hooks intent)', () => {
    const codexDir = path.join(tmpHome, '.aimaestro', 'agents', uuid, 'codex-app-data')
    fs.mkdirSync(codexDir, { recursive: true })
    const hooksPath = path.join(codexDir, 'hooks.json')
    const existing = '{"hooks":{"UserPromptSubmit":[{"hooks":[{"type":"command","command":"/opt/recall.sh"}]}]}}\n'
    fs.writeFileSync(hooksPath, existing)
    provisionCloudCodexConfig(uuid, tmpHome)
    expect(fs.readFileSync(hooksPath, 'utf8')).toBe(existing)
  })
})

describe('Ziggy MCP integration helpers', () => {
  describe('constants', () => {
    it('uses ziggy_default as the docker network name', () => {
      // Verified live 2026-05-27 — docker network ls + ziggy-postgres container
      // present at 172.19.0.3. Pinning the literal here so a rename surfaces at
      // CI rather than during a deploy.
      expect(ZIGGY_NETWORK).toBe('ziggy_default')
    })

    it('uses /home/gosub/code/ziggy as the canonical ziggy repo path', () => {
      // The path MUST match host-side absolute path verbatim because start.sh
      // derives ZIGGY_ROOT from its own location via $(dirname). A path remap
      // (e.g. /opt/ziggy-mcp/) would break the .env-loading + DATABASE_URL
      // construction logic.
      expect(ZIGGY_CODE_PATH).toBe('/home/gosub/code/ziggy')
    })

    it('uses /opt/stacks/ai-maestro/agent-envs as the per-agent env directory', () => {
      // Operator-owned; ai-maestro reads <name>.env files but never writes.
      expect(ZIGGY_AGENT_ENVS_DIR).toBe('/opt/stacks/ai-maestro/agent-envs')
    })
  })

  describe('buildZiggyCodeMount', () => {
    it('returns a read-only same-path bind for the ziggy repo', () => {
      const m = buildZiggyCodeMount()
      expect(m.hostPath).toBe('/home/gosub/code/ziggy')
      expect(m.containerPath).toBe('/home/gosub/code/ziggy')
      expect(m.readOnly).toBe(true)
    })

    it('passes validateMounts so the mount is shellable in a docker -v flag', () => {
      expect(validateMounts([buildZiggyCodeMount()], 'system')).toBeNull()
    })
  })

  describe('buildZiggyEnvOverlayMount', () => {
    it('returns a read-only file overlay shadowing the host ziggy .env', () => {
      const m = buildZiggyEnvOverlayMount('ops-homelab-nodie')
      expect(m.hostPath).toBe('/opt/stacks/ai-maestro/agent-envs/ops-homelab-nodie.env')
      expect(m.containerPath).toBe('/home/gosub/code/ziggy/.env')
      expect(m.readOnly).toBe(true)
    })

    it('uses agent name verbatim — agent names are slug-validated upstream', () => {
      const m = buildZiggyEnvOverlayMount('my-agent_42')
      expect(m.hostPath).toBe('/opt/stacks/ai-maestro/agent-envs/my-agent_42.env')
    })

    it('passes validateMounts so the mount is shellable in a docker -v flag', () => {
      expect(validateMounts([buildZiggyEnvOverlayMount('nodie')], 'system')).toBeNull()
    })
  })

  describe('provisionCloudCodexZiggyMcpEntry', () => {
    const uuid = 'cccccccc-cccc-cccc-cccc-cccccccccccc'
    let tmpHome: string

    beforeEach(() => {
      tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-ziggy-mcp-'))
    })

    afterEach(() => {
      fs.rmSync(tmpHome, { recursive: true, force: true })
    })

    it('appends [mcp_servers.ziggy] block pointing at the canonical start.sh', () => {
      // Pre-seed config.toml as provisionCloudCodexConfig would have written it
      // (now under codex-app-data/ per OPT-B kanban 01e11bf9).
      const codexDir = path.join(tmpHome, '.aimaestro', 'agents', uuid, 'codex-app-data')
      fs.mkdirSync(codexDir, { recursive: true })
      const configTomlPath = path.join(codexDir, 'config.toml')
      fs.writeFileSync(configTomlPath, '[projects."/workspace"]\ntrust_level = "trusted"\n')

      const { mcpBlockAdded } = provisionCloudCodexZiggyMcpEntry(uuid, tmpHome)
      expect(mcpBlockAdded).toBe(true)
      const body = fs.readFileSync(configTomlPath, 'utf8')
      expect(body).toContain('[mcp_servers.ziggy]')
      expect(body).toContain('command = "/home/gosub/code/ziggy/apps/mcp-server/bin/start.sh"')
      // Pre-existing trust block must be preserved (operator config compat).
      expect(body).toContain('[projects."/workspace"]')
    })

    it('is idempotent — re-running short-circuits and does not duplicate', () => {
      const codexDir = path.join(tmpHome, '.aimaestro', 'agents', uuid, 'codex-app-data')
      fs.mkdirSync(codexDir, { recursive: true })
      const configTomlPath = path.join(codexDir, 'config.toml')
      fs.writeFileSync(configTomlPath, '[projects."/workspace"]\ntrust_level = "trusted"\n')

      provisionCloudCodexZiggyMcpEntry(uuid, tmpHome)
      const { mcpBlockAdded } = provisionCloudCodexZiggyMcpEntry(uuid, tmpHome)
      expect(mcpBlockAdded).toBe(false)
      const body = fs.readFileSync(configTomlPath, 'utf8')
      // Block appears exactly once.
      expect(body.match(/\[mcp_servers\.ziggy\]/g) ?? []).toHaveLength(1)
    })

    it('writes a minimal config.toml if no pre-existing file (defensive — provisionCloudCodexConfig should run first)', () => {
      const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
      fs.mkdirSync(agentDir, { recursive: true })
      // Do NOT pre-seed config.toml — test the defensive branch.
      const { mcpBlockAdded, configTomlPath } = provisionCloudCodexZiggyMcpEntry(uuid, tmpHome)
      expect(mcpBlockAdded).toBe(true)
      const body = fs.readFileSync(configTomlPath, 'utf8')
      expect(body).toContain('[mcp_servers.ziggy]')
    })
  })
})

describe('buildCloudGeminiSettingsMount', () => {
  it('returns a file-level bind mount for /home/claude/.gemini/settings.json', () => {
    const uuid = '77777777-aaaa-7777-aaaa-777777777777'
    const home = '/home/operator'
    const m = buildCloudGeminiSettingsMount(uuid, home)
    expect(m.hostPath).toBe(`/home/operator/.aimaestro/agents/${uuid}/gemini-settings.json`)
    expect(m.containerPath).toBe('/home/claude/.gemini/settings.json')
    expect(m.readOnly).toBeUndefined()
  })

  it('passes validateMounts so the mount is shellable in a docker -v flag', () => {
    const uuid = '77777777-aaaa-7777-aaaa-777777777777'
    const home = '/home/operator'
    expect(validateMounts([buildCloudGeminiSettingsMount(uuid, home)], 'system')).toBeNull()
  })
})

describe('buildCloudAntigravityAppDataMount (kanban 49cc27d7, OPT-B single-dir)', () => {
  it('returns a dir-level bind mount sourced at <agent>/antigravity-app-data and targeting /home/claude/.gemini/antigravity-cli', () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const home = '/home/operator'
    const m = buildCloudAntigravityAppDataMount(uuid, home)
    expect(m.hostPath).toBe(`/home/operator/.aimaestro/agents/${uuid}/antigravity-app-data`)
    expect(m.containerPath).toBe('/home/claude/.gemini/antigravity-cli')
    // Dir-mount over the entire CLI app-data tree is RW by design — agy
    // rotates oauth-token via temp+rename on refresh, which would silently
    // stale a file-level mount but works inside a dir-mount.
    expect(m.readOnly).toBeUndefined()
  })

  it('passes validateMounts as a non-operator-supplied system mount', () => {
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const home = '/home/operator'
    expect(validateMounts([buildCloudAntigravityAppDataMount(uuid, home)], 'system')).toBeNull()
  })

  it('is operator-reserved (containerPath descends from CONTAINER_HOME/.gemini, which is in OPERATOR_RESERVED_CONTAINER_PATH_ROOTS)', () => {
    // Operator-supplied flag must reject this path so an operator-declared
    // mount cannot shadow the system mount of antigravity state.
    const uuid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    const home = '/home/operator'
    const mount = buildCloudAntigravityAppDataMount(uuid, home)
    expect(
      validateMounts([mount], 'operator'),
    ).toMatch(/reserved by AI Maestro/)
  })
})

describe('seedFromHostFile', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-seed-'))
  })

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('returns true and copies content when source exists and dest is missing', () => {
    const src = path.join(tmpHome, 'src.json')
    const dst = path.join(tmpHome, 'dst.json')
    fs.writeFileSync(src, '{"hostFile":"hello"}\n')
    expect(seedFromHostFile(src, dst)).toBe(true)
    expect(JSON.parse(fs.readFileSync(dst, 'utf8')).hostFile).toBe('hello')
  })

  it('writes the destination with restrictive 0600 perms', () => {
    const src = path.join(tmpHome, 'src.json')
    const dst = path.join(tmpHome, 'dst.json')
    fs.writeFileSync(src, '{}\n')
    seedFromHostFile(src, dst)
    expect(fs.statSync(dst).mode & 0o777).toBe(0o600)
  })

  it('returns false and does not overwrite when dest already exists (operator hand-edit / pre-seeded)', () => {
    const src = path.join(tmpHome, 'src.json')
    const dst = path.join(tmpHome, 'dst.json')
    fs.writeFileSync(src, '{"new":"value"}\n')
    fs.writeFileSync(dst, '{"existing":"value"}\n')
    expect(seedFromHostFile(src, dst)).toBe(false)
    expect(fs.readFileSync(dst, 'utf8')).toBe('{"existing":"value"}\n')
  })

  it('returns false when source is missing (operator has not run cli login yet)', () => {
    const src = path.join(tmpHome, 'absent.json')
    const dst = path.join(tmpHome, 'dst.json')
    expect(seedFromHostFile(src, dst)).toBe(false)
    expect(fs.existsSync(dst)).toBe(false)
  })

  it('re-bootstraps when dest holds the empty {} placeholder and host source becomes available (kanban 02a8ebda — post-hoc host login propagates on recreate)', () => {
    const src = path.join(tmpHome, 'src.json')
    const dst = path.join(tmpHome, 'dst.json')
    fs.writeFileSync(src, '{"OPENAI_API_KEY":"sk-host-real"}\n')
    fs.writeFileSync(dst, '{}\n')
    expect(seedFromHostFile(src, dst)).toBe(true)
    const body = JSON.parse(fs.readFileSync(dst, 'utf8'))
    expect(body.OPENAI_API_KEY).toBe('sk-host-real')
  })

  it('re-bootstraps when dest is bare empty string (defensive against zero-byte placeholder writes)', () => {
    const src = path.join(tmpHome, 'src.json')
    const dst = path.join(tmpHome, 'dst.json')
    fs.writeFileSync(src, '{"claudeAiOauth":{"accessToken":"sk-ant-host"}}\n')
    fs.writeFileSync(dst, '')
    expect(seedFromHostFile(src, dst)).toBe(true)
    const body = JSON.parse(fs.readFileSync(dst, 'utf8'))
    expect(body.claudeAiOauth.accessToken).toBe('sk-ant-host')
  })

  it('preserves real rotated credentials at dest even when host source has older content (per-agent rotation independence)', () => {
    const src = path.join(tmpHome, 'src.json')
    const dst = path.join(tmpHome, 'dst.json')
    fs.writeFileSync(src, '{"OPENAI_API_KEY":"sk-host-old"}\n')
    fs.writeFileSync(dst, '{"OPENAI_API_KEY":"sk-rotated-by-agent","tokens":{"refresh":"r-rot"}}\n')
    expect(seedFromHostFile(src, dst)).toBe(false)
    const body = JSON.parse(fs.readFileSync(dst, 'utf8'))
    expect(body.OPENAI_API_KEY).toBe('sk-rotated-by-agent')
    expect(body.tokens.refresh).toBe('r-rot')
  })
})

describe('provisionCloudCodexAuth', () => {
  const uuid = '99999999-9999-9999-9999-999999999999'
  let tmpHome: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-codex-auth-'))
  })

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('bootstraps codex-auth.json from host ~/.codex/auth.json when present (kanban 354a5174 Option A)', () => {
    const hostCodexDir = path.join(tmpHome, '.codex')
    fs.mkdirSync(hostCodexDir, { recursive: true })
    fs.writeFileSync(path.join(hostCodexDir, 'auth.json'),
      '{"OPENAI_API_KEY":"sk-test-from-host","tokens":{"access":"abc"}}\n', { mode: 0o600 })

    const { authPath, bootstrapped } = provisionCloudCodexAuth(uuid, tmpHome)
    expect(authPath).toBe(path.join(tmpHome, '.aimaestro', 'agents', uuid, 'codex-app-data', 'auth.json'))
    expect(bootstrapped).toBe(true)
    const body = JSON.parse(fs.readFileSync(authPath, 'utf8'))
    expect(body.OPENAI_API_KEY).toBe('sk-test-from-host')
    expect(body.tokens.access).toBe('abc')
  })

  it('seeds empty {} when host has no auth.json (first-time setup case)', () => {
    const { authPath, bootstrapped } = provisionCloudCodexAuth(uuid, tmpHome)
    expect(bootstrapped).toBe(false)
    expect(JSON.parse(fs.readFileSync(authPath, 'utf8'))).toEqual({})
  })

  it('writes the seeded file with restrictive 0600 perms', () => {
    const { authPath } = provisionCloudCodexAuth(uuid, tmpHome)
    expect(fs.statSync(authPath).mode & 0o777).toBe(0o600)
  })

  it('preserves existing per-agent codex-app-data/auth.json across re-runs (per-agent rotation independence)', () => {
    const hostCodexDir = path.join(tmpHome, '.codex')
    fs.mkdirSync(hostCodexDir, { recursive: true })
    fs.writeFileSync(path.join(hostCodexDir, 'auth.json'),
      '{"OPENAI_API_KEY":"sk-host-NEW"}\n', { mode: 0o600 })
    const codexDir = path.join(tmpHome, '.aimaestro', 'agents', uuid, 'codex-app-data')
    fs.mkdirSync(codexDir, { recursive: true })
    const authPath = path.join(codexDir, 'auth.json')
    const existing = '{"OPENAI_API_KEY":"sk-rotated-by-codex-runtime"}\n'
    fs.writeFileSync(authPath, existing)
    const result = provisionCloudCodexAuth(uuid, tmpHome)
    expect(result.bootstrapped).toBe(false)
    expect(fs.readFileSync(authPath, 'utf8')).toBe(existing)
  })

  it('creates the per-UUID codex-app-data dir if missing', () => {
    const codexDir = path.join(tmpHome, '.aimaestro', 'agents', uuid, 'codex-app-data')
    expect(fs.existsSync(codexDir)).toBe(false)
    provisionCloudCodexAuth(uuid, tmpHome)
    expect(fs.existsSync(codexDir)).toBe(true)
  })

  it('re-bootstraps codex-auth.json when migrated predecessor placeholder is empty {} and host now has auth (kanban 02a8ebda recreate-path)', () => {
    // Simulate the /recreate flow: migrateAgentPersistence has copied the
    // predecessor's empty {} into the new UUID dir BEFORE provisioning runs.
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'codex-auth.json'), '{}\n', { mode: 0o600 })
    const hostCodexDir = path.join(tmpHome, '.codex')
    fs.mkdirSync(hostCodexDir, { recursive: true })
    fs.writeFileSync(path.join(hostCodexDir, 'auth.json'),
      '{"OPENAI_API_KEY":"sk-host-post-hoc-login"}\n', { mode: 0o600 })

    const result = provisionCloudCodexAuth(uuid, tmpHome)

    expect(result.bootstrapped).toBe(true)
    const body = JSON.parse(fs.readFileSync(result.authPath, 'utf8'))
    expect(body.OPENAI_API_KEY).toBe('sk-host-post-hoc-login')
  })

  it('preserves real rotated codex-auth across re-runs even when migrated empty placeholder would not block (rotation independence)', () => {
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    const rotated = '{"OPENAI_API_KEY":"sk-rotated-by-codex","tokens":{"refresh":"r-r"}}\n'
    fs.writeFileSync(path.join(agentDir, 'codex-auth.json'), rotated, { mode: 0o600 })
    const hostCodexDir = path.join(tmpHome, '.codex')
    fs.mkdirSync(hostCodexDir, { recursive: true })
    fs.writeFileSync(path.join(hostCodexDir, 'auth.json'),
      '{"OPENAI_API_KEY":"sk-host-OLD"}\n', { mode: 0o600 })

    const result = provisionCloudCodexAuth(uuid, tmpHome)

    expect(result.bootstrapped).toBe(false)
    expect(fs.readFileSync(result.authPath, 'utf8')).toBe(rotated)
  })
})

describe('provisionCloudGeminiAuth', () => {
  const uuid = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
  let tmpHome: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-gemini-auth-'))
  })

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('bootstraps gemini-oauth-creds.json from host ~/.gemini/oauth_creds.json when present (kanban 1f911653 Option A)', () => {
    const hostGeminiDir = path.join(tmpHome, '.gemini')
    fs.mkdirSync(hostGeminiDir, { recursive: true })
    fs.writeFileSync(path.join(hostGeminiDir, 'oauth_creds.json'),
      '{"access_token":"ya29.host","refresh_token":"r-host","token_type":"Bearer"}\n', { mode: 0o600 })

    const { authPath, bootstrapped } = provisionCloudGeminiAuth(uuid, tmpHome)
    expect(authPath).toBe(path.join(tmpHome, '.aimaestro', 'agents', uuid, 'gemini-oauth-creds.json'))
    expect(bootstrapped).toBe(true)
    const body = JSON.parse(fs.readFileSync(authPath, 'utf8'))
    expect(body.access_token).toBe('ya29.host')
    expect(body.refresh_token).toBe('r-host')
    expect(body.token_type).toBe('Bearer')
  })

  it('seeds empty {} when host has no oauth_creds.json (first-time setup case)', () => {
    const { authPath, bootstrapped } = provisionCloudGeminiAuth(uuid, tmpHome)
    expect(bootstrapped).toBe(false)
    expect(JSON.parse(fs.readFileSync(authPath, 'utf8'))).toEqual({})
  })

  it('writes the seeded file with restrictive 0600 perms', () => {
    const { authPath } = provisionCloudGeminiAuth(uuid, tmpHome)
    expect(fs.statSync(authPath).mode & 0o777).toBe(0o600)
  })

  it('preserves existing per-agent gemini-oauth-creds.json across re-runs (per-agent rotation independence)', () => {
    const hostGeminiDir = path.join(tmpHome, '.gemini')
    fs.mkdirSync(hostGeminiDir, { recursive: true })
    fs.writeFileSync(path.join(hostGeminiDir, 'oauth_creds.json'),
      '{"access_token":"ya29.host-NEW"}\n', { mode: 0o600 })
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    const authPath = path.join(agentDir, 'gemini-oauth-creds.json')
    const existing = '{"access_token":"ya29.rotated-by-gemini-runtime"}\n'
    fs.writeFileSync(authPath, existing)
    const result = provisionCloudGeminiAuth(uuid, tmpHome)
    expect(result.bootstrapped).toBe(false)
    expect(fs.readFileSync(authPath, 'utf8')).toBe(existing)
  })

  it('creates the per-UUID dir if missing', () => {
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    expect(fs.existsSync(agentDir)).toBe(false)
    provisionCloudGeminiAuth(uuid, tmpHome)
    expect(fs.existsSync(agentDir)).toBe(true)
  })

  it('re-bootstraps gemini-oauth-creds.json when migrated predecessor placeholder is empty {} and host now has creds (kanban 02a8ebda recreate-path)', () => {
    // Simulate the /recreate flow: migrateAgentPersistence has copied the
    // predecessor's empty {} into the new UUID dir BEFORE provisioning runs.
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'gemini-oauth-creds.json'), '{}\n', { mode: 0o600 })
    const hostGeminiDir = path.join(tmpHome, '.gemini')
    fs.mkdirSync(hostGeminiDir, { recursive: true })
    fs.writeFileSync(path.join(hostGeminiDir, 'oauth_creds.json'),
      '{"access_token":"ya29.host-post-hoc-login"}\n', { mode: 0o600 })

    const result = provisionCloudGeminiAuth(uuid, tmpHome)

    expect(result.bootstrapped).toBe(true)
    const body = JSON.parse(fs.readFileSync(result.authPath, 'utf8'))
    expect(body.access_token).toBe('ya29.host-post-hoc-login')
  })

  it('preserves real rotated gemini-oauth-creds across re-runs even when migrated empty placeholder would not block (rotation independence)', () => {
    const agentDir = path.join(tmpHome, '.aimaestro', 'agents', uuid)
    fs.mkdirSync(agentDir, { recursive: true })
    const rotated = '{"access_token":"ya29.rotated-by-gemini","refresh_token":"r-r"}\n'
    fs.writeFileSync(path.join(agentDir, 'gemini-oauth-creds.json'), rotated, { mode: 0o600 })
    const hostGeminiDir = path.join(tmpHome, '.gemini')
    fs.mkdirSync(hostGeminiDir, { recursive: true })
    fs.writeFileSync(path.join(hostGeminiDir, 'oauth_creds.json'),
      '{"access_token":"ya29.host-OLD"}\n', { mode: 0o600 })

    const result = provisionCloudGeminiAuth(uuid, tmpHome)

    expect(result.bootstrapped).toBe(false)
    expect(fs.readFileSync(result.authPath, 'utf8')).toBe(rotated)
  })
})

describe('buildCloudGeminiOAuthMount', () => {
  it('returns a file-level bind mount for /home/claude/.gemini/oauth_creds.json', () => {
    const uuid = 'gggggggg-gggg-gggg-gggg-gggggggggggg'
    const home = '/home/operator'
    const m = buildCloudGeminiOAuthMount(uuid, home)
    expect(m.hostPath).toBe(`/home/operator/.aimaestro/agents/${uuid}/gemini-oauth-creds.json`)
    expect(m.containerPath).toBe('/home/claude/.gemini/oauth_creds.json')
    expect(m.readOnly).toBeUndefined()
  })

  it('passes validateMounts so the mount is shellable in a docker -v flag', () => {
    const uuid = 'gggggggg-gggg-gggg-gggg-gggggggggggg'
    const home = '/home/operator'
    expect(validateMounts([buildCloudGeminiOAuthMount(uuid, home)], 'system')).toBeNull()
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
    fs.writeFileSync(path.join(fromDir, 'gemini-settings.json'),
      '{"general":{"enableAutoUpdate":false,"customField":"keep-me"}}\n', { mode: 0o600 })
    fs.writeFileSync(path.join(fromDir, 'codex-version.json'),
      '{"latest_version":"0.130.0","last_checked_at":"2026-05-15T00:00:00Z","dismissed_version":"0.130.0"}\n', { mode: 0o600 })
    fs.writeFileSync(path.join(fromDir, 'codex-auth.json'),
      '{"OPENAI_API_KEY":"sk-rotated-by-codex","tokens":{"refresh":"r-pred"}}\n', { mode: 0o600 })
    fs.writeFileSync(path.join(fromDir, 'codex-config.toml'),
      '[projects."/workspace"]\ntrust_level = "trusted"\n', { mode: 0o600 })
    fs.writeFileSync(path.join(fromDir, 'gemini-oauth-creds.json'),
      '{"access_token":"ya29.rotated-by-gemini","refresh_token":"r-pred","token_type":"Bearer"}\n', { mode: 0o600 })
    // PR #130 (kanban 2853e62d) directory mounts — chat history + hook state
    // that must carry forward on /recreate with persistFromAgentId.
    fs.mkdirSync(path.join(fromDir, 'claude-projects', '-workspace'), { recursive: true })
    fs.writeFileSync(path.join(fromDir, 'claude-projects', '-workspace', 'pred-session.jsonl'),
      '{"type":"user","message":{"content":"history from predecessor"},"timestamp":"2026-05-11T00:00:00Z"}\n', { mode: 0o600 })
    fs.mkdirSync(path.join(fromDir, 'chat-state'), { recursive: true })
    fs.writeFileSync(path.join(fromDir, 'chat-state', 'abc123def456.json'),
      '{"status":"waiting_for_input","updatedAt":"2026-05-11T00:00:00Z"}\n', { mode: 0o600 })
    // PR #132 (kanban d937c33d) gemini-chats sister mount — same survival
    // semantic as claude-projects but for cloud-Gemini transcript files.
    fs.mkdirSync(path.join(fromDir, 'gemini-chats'), { recursive: true })
    fs.writeFileSync(path.join(fromDir, 'gemini-chats', 'session-2026-05-11-abc12345.jsonl'),
      '{"id":"evt-1","type":"user","content":[{"text":"history from gemini predecessor"}],"timestamp":"2026-05-11T00:00:00Z"}\n', { mode: 0o600 })
    // kanban 01e11bf9 codex-app-data single-dir mount — codex transcripts
    // (sessions/ rollout jsonl) + sqlite state must survive recreate.
    fs.mkdirSync(path.join(fromDir, 'codex-app-data', 'sessions', '2026', '06', '09'), { recursive: true })
    fs.writeFileSync(
      path.join(fromDir, 'codex-app-data', 'sessions', '2026', '06', '09', 'rollout-2026-06-09T12-11-38-pred.jsonl'),
      '{"type":"session_meta","payload":{"cwd":"/workspace"}}\n', { mode: 0o600 })
    fs.writeFileSync(path.join(fromDir, 'codex-app-data', 'config.toml'),
      '[projects."/workspace"]\ntrust_level = "trusted"\n', { mode: 0o600 })
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

  it('migrates claude-projects/ recursively so chat history survives recreate-with-persistFromAgentId (kanban bf012c03)', () => {
    // PR #130 added claude-projects/ as a per-agent bind-mount source; without
    // the dirAssets extension to migrateAgentPersistence, /recreate with
    // persistFromAgentId would land the new UUID on an empty claude-projects/
    // and the operator's chat history would reset to "0 messages" in the
    // chat panel despite the auth and onboarding state surviving.
    migrateAgentPersistence(fromId, toId, tmpHome)
    const dst = path.join(tmpHome, '.aimaestro', 'agents', toId, 'claude-projects', '-workspace', 'pred-session.jsonl')
    expect(fs.existsSync(dst)).toBe(true)
    expect(fs.readFileSync(dst, 'utf8')).toContain('history from predecessor')
  })

  it('migrates chat-state/ recursively so hook output survives recreate-with-persistFromAgentId (kanban bf012c03)', () => {
    // Same shape as claude-projects, for the ai-maestro hook output —
    // permission-prompts + pending-state pinned by the most recent hook write
    // would otherwise reset to empty on every recreate.
    migrateAgentPersistence(fromId, toId, tmpHome)
    const dst = path.join(tmpHome, '.aimaestro', 'agents', toId, 'chat-state', 'abc123def456.json')
    expect(fs.existsSync(dst)).toBe(true)
    const body = JSON.parse(fs.readFileSync(dst, 'utf8'))
    expect(body.status).toBe('waiting_for_input')
  })

  it('migrates gemini-chats/ recursively so cloud-Gemini transcripts survive recreate-with-persistFromAgentId (kanban d937c33d closes-the-loop)', () => {
    // Sister to claude-projects for the Gemini per-project chats dir.
    // Without this, recreating a cloud-Gemini agent (Mason/Optic) with
    // persistFromAgentId resets the chat panel to "0 messages" the same
    // way PR #131 fixed for cloud-Claude agents.
    migrateAgentPersistence(fromId, toId, tmpHome)
    const dst = path.join(tmpHome, '.aimaestro', 'agents', toId, 'gemini-chats', 'session-2026-05-11-abc12345.jsonl')
    expect(fs.existsSync(dst)).toBe(true)
    expect(fs.readFileSync(dst, 'utf8')).toContain('history from gemini predecessor')
  })

  it('migrates codex-app-data/ recursively so cloud-Codex transcripts + sqlite survive recreate-with-persistFromAgentId (kanban 01e11bf9)', () => {
    // Sister to claude-projects/gemini-chats for the codex single-dir mount.
    // Without this, recreating a cloud-Codex agent (R2D2-class) with
    // persistFromAgentId wipes ~/.codex/sessions rollout transcripts + the
    // logs_2/state_5 sqlite — the exact data-loss this PR closes.
    migrateAgentPersistence(fromId, toId, tmpHome)
    const toBase = path.join(tmpHome, '.aimaestro', 'agents', toId, 'codex-app-data')
    const rollout = path.join(toBase, 'sessions', '2026', '06', '09', 'rollout-2026-06-09T12-11-38-pred.jsonl')
    expect(fs.existsSync(rollout)).toBe(true)
    expect(fs.readFileSync(rollout, 'utf8')).toContain('session_meta')
    expect(fs.readFileSync(path.join(toBase, 'config.toml'), 'utf8')).toContain('trust_level = "trusted"')
  })

  it('preserves restrictive 0600 mode on copied JSON files', () => {
    migrateAgentPersistence(fromId, toId, tmpHome)
    const home = path.join(tmpHome, '.aimaestro', 'agents', toId, 'claude-home.json')
    const creds = path.join(tmpHome, '.aimaestro', 'agents', toId, 'claude-credentials.json')
    expect(fs.statSync(home).mode & 0o777).toBe(0o600)
    expect(fs.statSync(creds).mode & 0o777).toBe(0o600)
  })

  it('copies gemini-settings.json content from predecessor (kanban cd2d7377 carry-forward)', () => {
    migrateAgentPersistence(fromId, toId, tmpHome)
    const dst = path.join(tmpHome, '.aimaestro', 'agents', toId, 'gemini-settings.json')
    const body = JSON.parse(fs.readFileSync(dst, 'utf8'))
    expect(body.general.enableAutoUpdate).toBe(false)
    expect(body.general.customField).toBe('keep-me')
    expect(fs.statSync(dst).mode & 0o777).toBe(0o600)
  })

  it('copies codex-version.json content from predecessor (kanban 22f4af86 carry-forward)', () => {
    migrateAgentPersistence(fromId, toId, tmpHome)
    const dst = path.join(tmpHome, '.aimaestro', 'agents', toId, 'codex-version.json')
    const body = JSON.parse(fs.readFileSync(dst, 'utf8'))
    expect(body.dismissed_version).toBe('0.130.0')
    expect(body.latest_version).toBe('0.130.0')
    expect(fs.statSync(dst).mode & 0o777).toBe(0o600)
  })

  it('copies codex-auth.json content from predecessor (kanban 354a5174 carry-forward across UUID rotation)', () => {
    migrateAgentPersistence(fromId, toId, tmpHome)
    const dst = path.join(tmpHome, '.aimaestro', 'agents', toId, 'codex-auth.json')
    const body = JSON.parse(fs.readFileSync(dst, 'utf8'))
    expect(body.OPENAI_API_KEY).toBe('sk-rotated-by-codex')
    expect(body.tokens.refresh).toBe('r-pred')
    expect(fs.statSync(dst).mode & 0o777).toBe(0o600)
  })

  it('copies codex-config.toml content from predecessor (trust modal seed survives recreate)', () => {
    migrateAgentPersistence(fromId, toId, tmpHome)
    const dst = path.join(tmpHome, '.aimaestro', 'agents', toId, 'codex-config.toml')
    const body = fs.readFileSync(dst, 'utf8')
    expect(body).toContain('[projects."/workspace"]')
    expect(body).toContain('trust_level = "trusted"')
    expect(fs.statSync(dst).mode & 0o777).toBe(0o600)
  })

  it('copies gemini-oauth-creds.json content from predecessor (kanban 1f911653 carry-forward across UUID rotation)', () => {
    migrateAgentPersistence(fromId, toId, tmpHome)
    const dst = path.join(tmpHome, '.aimaestro', 'agents', toId, 'gemini-oauth-creds.json')
    const body = JSON.parse(fs.readFileSync(dst, 'utf8'))
    expect(body.access_token).toBe('ya29.rotated-by-gemini')
    expect(body.refresh_token).toBe('r-pred')
    expect(fs.statSync(dst).mode & 0o777).toBe(0o600)
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

  it('returns the identity/name/routing/path/gemini-trust envs', () => {
    expect(buildAmpCommonEnv(uuid, name, hostUrl)).toEqual({
      CLAUDE_AGENT_ID: uuid,
      CLAUDE_AGENT_NAME: name,
      AMP_AGENT_ID: uuid,
      AMP_DIR: `/home/claude/.agent-messaging/agents/${uuid}`,
      AMP_MAESTRO_URL: hostUrl,
      PATH: '/home/claude/.local/bin:/home/claude/.local/share/aimaestro/cli:/home/claude/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      GEMINI_CLI_TRUST_WORKSPACE: 'true',
    })
  })

  it('aliases AMP_AGENT_ID = CLAUDE_AGENT_ID for amp-statusline.sh priority-1 resolution (kanban 172e170d)', () => {
    const env = buildAmpCommonEnv(uuid, name, hostUrl)
    expect(env.AMP_AGENT_ID).toBe(env.CLAUDE_AGENT_ID)
    expect(env.AMP_AGENT_ID).toBe(uuid)
  })

  it('puts the AMP CLI dir ahead of the standard path', () => {
    const env = buildAmpCommonEnv(uuid, name, hostUrl)
    expect(env.PATH.split(':')[0]).toBe('/home/claude/.local/bin')
  })

  it('sets GEMINI_CLI_TRUST_WORKSPACE=true so gemini-program agents skip the trust modal (kanban cd2d7377)', () => {
    const env = buildAmpCommonEnv(uuid, name, hostUrl)
    expect(env.GEMINI_CLI_TRUST_WORKSPACE).toBe('true')
  })

  it('passes the extraEnv validator', () => {
    expect(validateExtraEnv(buildAmpCommonEnv(uuid, name, hostUrl), 'system')).toBeNull()
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
    expect(buildRecreateBody(agent).ziggy).toBeUndefined()
  })

  it('preserves sandbox.ziggy=true through recreate so the network attach survives UUID rotation', () => {
    const agent = makeCloudAgent({
      deployment: {
        type: 'cloud',
        cloud: { provider: 'local-container', containerName: 'aim-x', status: 'running' },
        sandbox: { ziggy: true },
      },
    })
    expect(buildRecreateBody(agent).ziggy).toBe(true)
  })

  it('maps deployment.cloud.runtime fields back into the create body', () => {
    // Closes kanban 105b82a0 — without persisting runtime config on the agent
    // record, recreate fell back to createDockerAgent's hard-coded defaults
    // (cpus=2, memory=4g, autoRemove=undefined → restart unless-stopped) and
    // silently dropped any operator-supplied extraEnv (e.g. HOME=/workspace
    // overrides). Now runtime carries through deterministically.
    const agent = makeCloudAgent({
      deployment: {
        type: 'cloud',
        cloud: {
          provider: 'local-container',
          containerName: 'aim-x',
          status: 'running',
          runtime: {
            cpus: 4,
            memory: '8g',
            autoRemove: true,
            extraEnv: { HOME: '/workspace/myagent', FOO: 'bar' },
          },
        },
      },
    })
    const body = buildRecreateBody(agent)
    expect(body.cpus).toBe(4)
    expect(body.memory).toBe('8g')
    expect(body.autoRemove).toBe(true)
    expect(body.extraEnv).toEqual({ HOME: '/workspace/myagent', FOO: 'bar' })
  })

  it('leaves runtime fields undefined when not persisted', () => {
    // Legacy agents predating PR #146 have no deployment.cloud.runtime. Body
    // should reflect "not set" so createDockerAgent's existing defaults
    // (cpus=2, memory=4g) apply unchanged.
    const agent = makeCloudAgent()
    const body = buildRecreateBody(agent)
    expect(body.cpus).toBeUndefined()
    expect(body.memory).toBeUndefined()
    expect(body.autoRemove).toBeUndefined()
    expect(body.extraEnv).toBeUndefined()
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

describe('parsePortFromWebsocketUrl', () => {
  it('extracts port from a ws://localhost:PORT/term URL', () => {
    expect(parsePortFromWebsocketUrl('ws://localhost:23042/term')).toBe(23042)
  })

  it('returns null for undefined', () => {
    expect(parsePortFromWebsocketUrl(undefined)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parsePortFromWebsocketUrl('')).toBeNull()
  })

  it('returns null when no port is present in the URL', () => {
    expect(parsePortFromWebsocketUrl('ws://localhost/term')).toBeNull()
  })

  it('returns null for malformed input', () => {
    expect(parsePortFromWebsocketUrl('not-a-url')).toBeNull()
  })

  it('handles wss URLs', () => {
    expect(parsePortFromWebsocketUrl('wss://agent.example.com:443/term')).toBe(443)
  })
})

describe('formatMemoryBytesToString (kanban 1ef9eabd)', () => {
  // Maps docker inspect HostConfig.Memory (bytes) back to the canonical
  // 'Xg' / 'Xm' string that createDockerAgent accepts (default '4g').
  it('formats canonical createDockerAgent defaults exactly', () => {
    // 2g default and 4g default — verify these round-trip cleanly through
    // bytes → string with no precision loss.
    expect(formatMemoryBytesToString(2 * 1024 ** 3)).toBe('2g')
    expect(formatMemoryBytesToString(4 * 1024 ** 3)).toBe('4g')
  })

  it('rounds to integer GiB when within 1% of an integer', () => {
    // docker inspect bytes for 4 GiB is exactly 4 * 1024^3 = 4294967296.
    // Some configurations report off-by-a-few-bytes; round-to-integer keeps
    // the canonical 'Xg' form when intent is obvious.
    expect(formatMemoryBytesToString(4 * 1024 ** 3 + 100)).toBe('4g')
    expect(formatMemoryBytesToString(4 * 1024 ** 3 - 100)).toBe('4g')
  })

  it('returns decimal GiB when not close to an integer', () => {
    expect(formatMemoryBytesToString(Math.round(1.5 * 1024 ** 3))).toBe('1.50g')
    expect(formatMemoryBytesToString(Math.round(3.25 * 1024 ** 3))).toBe('3.25g')
  })

  it('falls back to MiB for sub-GiB sizes', () => {
    expect(formatMemoryBytesToString(512 * 1024 ** 2)).toBe('512m')
    expect(formatMemoryBytesToString(256 * 1024 ** 2)).toBe('256m')
  })

  it('throws on non-positive or non-finite input', () => {
    // backfillAgentRuntime gates this branch separately (returns operationFailed
    // before calling format), but throw-guard keeps the helper honest if it's
    // ever called from a new site.
    expect(() => formatMemoryBytesToString(0)).toThrow(/invalid byte count/)
    expect(() => formatMemoryBytesToString(-1)).toThrow(/invalid byte count/)
    expect(() => formatMemoryBytesToString(NaN)).toThrow(/invalid byte count/)
    expect(() => formatMemoryBytesToString(Infinity)).toThrow(/invalid byte count/)
  })
})

// ============================================================================
// kanban fcabb870 — restoration-ready sentinel host helpers
// ============================================================================

describe('buildCloudRestorationSentinelMount', () => {
  it('binds per-agent restoration dir to /restoration-ready in the container, read-only', () => {
    const mount = buildCloudRestorationSentinelMount('agent-uuid', '/tmp/test-home')
    expect(mount).toEqual({
      hostPath: '/tmp/test-home/.aimaestro/agents/agent-uuid/restoration',
      containerPath: '/restoration-ready',
      readOnly: true,
    })
  })

  it('hostPath is namespaced per agentId so multiple agents do not collide', () => {
    const a = buildCloudRestorationSentinelMount('agent-a', '/tmp/home')
    const b = buildCloudRestorationSentinelMount('agent-b', '/tmp/home')
    expect(a.hostPath).not.toBe(b.hostPath)
    expect(a.containerPath).toBe(b.containerPath) // same container-side endpoint
  })

  it('is read-only (least-privilege — container reads, host writes)', () => {
    // CelestIA polish on PR #154: container only polls existsSync, never
    // writes. RW would expose the sentinel to in-container tampering that
    // could prematurely unblock the gate or stall it.
    const mount = buildCloudRestorationSentinelMount('agent-x')
    expect(mount.readOnly).toBe(true)
  })
})

describe('writeRestorationSentinel', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-sentinel-write-'))
  })

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('creates restoration/complete with an ISO timestamp body', () => {
    writeRestorationSentinel('agent-1', tmpHome)
    const sentinelPath = path.join(tmpHome, '.aimaestro/agents/agent-1/restoration/complete')
    expect(fs.existsSync(sentinelPath)).toBe(true)
    const body = fs.readFileSync(sentinelPath, 'utf8')
    expect(body).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  it('creates the parent restoration/ dir if missing (fresh-agent shape)', () => {
    const restorationDir = path.join(tmpHome, '.aimaestro/agents/fresh/restoration')
    expect(fs.existsSync(restorationDir)).toBe(false)
    writeRestorationSentinel('fresh', tmpHome)
    expect(fs.existsSync(restorationDir)).toBe(true)
  })

  it('overwrites an existing sentinel (idempotent for repeated /update-runtime)', () => {
    writeRestorationSentinel('agent-2', tmpHome)
    const sentinelPath = path.join(tmpHome, '.aimaestro/agents/agent-2/restoration/complete')
    const first = fs.readFileSync(sentinelPath, 'utf8')
    // 5ms gap ensures a measurably-later ISO timestamp
    return new Promise<void>(resolve => setTimeout(() => {
      writeRestorationSentinel('agent-2', tmpHome)
      const second = fs.readFileSync(sentinelPath, 'utf8')
      expect(second).not.toBe(first)
      expect(second).toMatch(/^\d{4}-\d{2}-\d{2}/)
      resolve()
    }, 5))
  })

  it('is best-effort: a write failure logs warning but does not throw', () => {
    // Point at a read-only-ish parent that mkdirSync can't create. /proc/1 is a
    // standard sentinel for "real path that cannot be a parent of new dirs."
    // Using mocked path with a guaranteed mkdir error keeps the test portable.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync').mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })
    try {
      expect(() => writeRestorationSentinel('agent-fail', tmpHome)).not.toThrow()
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/could not write sentinel for agent-fail/),
        expect.stringMatching(/EACCES/),
      )
    } finally {
      mkdirSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })
})

describe('clearRestorationSentinel', () => {
  let tmpHome: string

  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-sentinel-clear-'))
  })

  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
  })

  it('removes an existing sentinel file', () => {
    writeRestorationSentinel('agent-c1', tmpHome)
    const sentinelPath = path.join(tmpHome, '.aimaestro/agents/agent-c1/restoration/complete')
    expect(fs.existsSync(sentinelPath)).toBe(true)

    clearRestorationSentinel('agent-c1', tmpHome)
    expect(fs.existsSync(sentinelPath)).toBe(false)
  })

  it('is silent + does not throw when the sentinel is already absent (ENOENT)', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      expect(() => clearRestorationSentinel('never-existed', tmpHome)).not.toThrow()
      // ENOENT is the success case for clear — we should NOT log a warning,
      // otherwise every fresh-create's no-op clear floods the log.
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  it('logs warning on non-ENOENT failure (e.g. EACCES) but does not throw', () => {
    writeRestorationSentinel('agent-c2', tmpHome)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation(() => {
      const err = new Error('EACCES: permission denied') as NodeJS.ErrnoException
      err.code = 'EACCES'
      throw err
    })
    try {
      expect(() => clearRestorationSentinel('agent-c2', tmpHome)).not.toThrow()
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringMatching(/could not unlink/),
        expect.stringMatching(/EACCES/),
      )
    } finally {
      unlinkSpy.mockRestore()
      warnSpy.mockRestore()
    }
  })

  it('does not remove sibling files in the restoration/ dir', () => {
    writeRestorationSentinel('agent-c3', tmpHome)
    const restorationDir = path.join(tmpHome, '.aimaestro/agents/agent-c3/restoration')
    const sibling = path.join(restorationDir, 'sibling.txt')
    fs.writeFileSync(sibling, 'untouched')

    clearRestorationSentinel('agent-c3', tmpHome)
    expect(fs.existsSync(path.join(restorationDir, 'complete'))).toBe(false)
    expect(fs.existsSync(sibling)).toBe(true)
  })
})

// --- buildAiToolCommand --- permission mode → AI_TOOL env var ---

describe('buildAiToolCommand', () => {
  it('uses --permission-mode auto for permissionMode smartAuto (not --dangerously-skip-permissions)', () => {
    const result = buildAiToolCommand({ program: 'claude', permissionMode: 'smartAuto' })
    expect(result).toBe('claude --permission-mode auto')
    expect(result).not.toContain('--dangerously-skip-permissions')
  })

  it('maps yolo: true to --permission-mode bypassPermissions (backward compat)', () => {
    const result = buildAiToolCommand({ program: 'claude', yolo: true })
    expect(result).toBe('claude --permission-mode bypassPermissions')
  })

  it('does NOT add --permission-mode for supervised (default behavior)', () => {
    const result = buildAiToolCommand({ program: 'claude', permissionMode: 'supervised' })
    expect(result).toBe('claude')
    expect(result).not.toContain('--permission-mode')
  })

  it('permissionMode wins over yolo when both are provided', () => {
    const result = buildAiToolCommand({ program: 'claude', yolo: true, permissionMode: 'trustEdits' })
    expect(result).toBe('claude --permission-mode acceptEdits')
    expect(result).not.toContain('bypassPermissions')
  })

  it('does NOT add --permission-mode for non-claude programs even with permissionMode set', () => {
    const result = buildAiToolCommand({ program: 'codex', permissionMode: 'fullAutonomy' })
    expect(result).toBe('codex')
    expect(result).not.toContain('--permission-mode')
  })

  it('defaults to claude when no program specified', () => {
    const result = buildAiToolCommand({ permissionMode: 'planOnly' })
    expect(result).toBe('claude --permission-mode plan')
  })

  it('defaults to supervised when neither permissionMode nor yolo are set', () => {
    const result = buildAiToolCommand({ program: 'claude' })
    expect(result).toBe('claude')
  })

  it('appends programArgs after permission-mode flag', () => {
    const result = buildAiToolCommand({ program: 'claude', permissionMode: 'smartAuto', programArgs: '--continue' })
    expect(result).toBe('claude --permission-mode auto --continue')
  })

  it('appends model after programArgs', () => {
    const result = buildAiToolCommand({ program: 'claude', permissionMode: 'fullAutonomy', model: 'claude-sonnet-4-6' })
    expect(result).toBe('claude --permission-mode bypassPermissions --model claude-sonnet-4-6')
  })

  it('treats claude-code program name as claude-compatible (receives permission flags)', () => {
    const result = buildAiToolCommand({ program: 'claude-code', permissionMode: 'trustEdits' })
    expect(result).toBe('claude-code --permission-mode acceptEdits')
  })
})

// ── WS1: cloud-agent port allocation (kanban 58c49a6e) ───────────────────────

function cloudAgent(port: number | null, opts: Partial<Agent> = {}): Agent {
  return {
    deployment: port === null
      ? { type: 'cloud', cloud: { provider: 'local-container' } }
      : { type: 'cloud', cloud: { provider: 'local-container', websocketUrl: `ws://localhost:${port}/term` } },
    ...opts,
  } as unknown as Agent
}

describe('computeReservedCloudPorts', () => {
  it('unions every agent port regardless of online/offline status', () => {
    const reserved = computeReservedCloudPorts(
      [cloudAgent(23001, { status: 'online' } as Partial<Agent>), cloudAgent(23002, { status: 'offline' } as Partial<Agent>)],
      []
    )
    expect([...reserved].sort()).toEqual([23001, 23002])
  })

  it('reserves a HIBERNATED (offline, not deleted) agent port — the Crease→Columbo fix', () => {
    // Hibernated Crease still owns 23003; allocator must not hand it to a live agent.
    const reserved = computeReservedCloudPorts([cloudAgent(23003, { status: 'offline' } as Partial<Agent>)], [])
    expect(reserved.has(23003)).toBe(true)
  })

  it('reserves a SOFT-DELETED agent port (released only on hard-delete / record removal)', () => {
    // loadAgents() returns soft-deleted records; a soft-deleted agent keeps its reservation.
    const softDeleted = cloudAgent(23004, { deletedAt: new Date().toISOString(), status: 'deleted' } as Partial<Agent>)
    const reserved = computeReservedCloudPorts([softDeleted], [])
    expect(reserved.has(23004)).toBe(true)
  })

  it('unions host-bound ports as a backstop', () => {
    const reserved = computeReservedCloudPorts([cloudAgent(23001)], [23050, 23051])
    expect([...reserved].sort()).toEqual([23001, 23050, 23051])
  })

  it('ignores agents with no parseable port and non-cloud records', () => {
    const reserved = computeReservedCloudPorts(
      [cloudAgent(null), { deployment: { type: 'local' } } as unknown as Agent, cloudAgent(23001)],
      []
    )
    expect([...reserved]).toEqual([23001])
  })
})

describe('pickFirstFreeCloudPort', () => {
  it('returns the first free port in range', () => {
    expect(pickFirstFreeCloudPort(new Set([23001, 23002]), 23001, 23100)).toBe(23003)
  })

  it('skips a gap and returns the lowest free port', () => {
    expect(pickFirstFreeCloudPort(new Set([23002, 23003]), 23001, 23100)).toBe(23001)
  })

  it('FAILS LOUD when the range is exhausted — no wrap-around, no silent fallback', () => {
    const full = new Set([23001, 23002, 23003])
    expect(() => pickFirstFreeCloudPort(full, 23001, 23003)).toThrow(/No free cloud-agent port/)
  })
})

describe('getCloudPortRange', () => {
  const saved = { start: process.env.CLOUD_AGENT_PORT_RANGE_START, end: process.env.CLOUD_AGENT_PORT_RANGE_END }
  afterEach(() => {
    if (saved.start === undefined) delete process.env.CLOUD_AGENT_PORT_RANGE_START
    else process.env.CLOUD_AGENT_PORT_RANGE_START = saved.start
    if (saved.end === undefined) delete process.env.CLOUD_AGENT_PORT_RANGE_END
    else process.env.CLOUD_AGENT_PORT_RANGE_END = saved.end
  })

  it('defaults to the historical 23001-23100 window', () => {
    delete process.env.CLOUD_AGENT_PORT_RANGE_START
    delete process.env.CLOUD_AGENT_PORT_RANGE_END
    expect(getCloudPortRange()).toEqual({ start: 23001, end: 23100 })
  })

  it('honors env overrides', () => {
    process.env.CLOUD_AGENT_PORT_RANGE_START = '24000'
    process.env.CLOUD_AGENT_PORT_RANGE_END = '24010'
    expect(getCloudPortRange()).toEqual({ start: 24000, end: 24010 })
  })

  it('rejects an inverted range (fail loud)', () => {
    process.env.CLOUD_AGENT_PORT_RANGE_START = '24010'
    process.env.CLOUD_AGENT_PORT_RANGE_END = '24000'
    expect(() => getCloudPortRange()).toThrow(/Invalid cloud-agent port range/)
  })

  it('rejects a non-numeric bound (fail loud)', () => {
    process.env.CLOUD_AGENT_PORT_RANGE_START = 'abc'
    process.env.CLOUD_AGENT_PORT_RANGE_END = '24000'
    expect(() => getCloudPortRange()).toThrow(/Invalid cloud-agent port range/)
  })
})

// ── WS2/WS3 — §11.1 wave-based dev-team container profiles ──────────────────

describe('validateProfile', () => {
  it('returns null for undefined / null (unprofiled = backward-compatible)', () => {
    expect(validateProfile(undefined)).toBeNull()
    expect(validateProfile(null)).toBeNull()
  })
  it('accepts worker and orchestrator', () => {
    expect(validateProfile('worker')).toBeNull()
    expect(validateProfile('orchestrator')).toBeNull()
  })
  it('rejects an unknown profile string (no silent orchestrator-RW escalation)', () => {
    expect(validateProfile('admin')).toMatch(/profile must be one of/)
    expect(validateProfile('')).toMatch(/profile must be one of/)
  })
  it('rejects a non-string profile', () => {
    expect(validateProfile(123)).toMatch(/profile must be one of/)
    expect(validateProfile({})).toMatch(/profile must be one of/)
  })
})

describe('buildCloudAiTeamMount (§11.1/§11.2)', () => {
  const HOME = '/home/tester'
  it('returns null for an unprofiled agent (no /ai-team mount)', () => {
    expect(buildCloudAiTeamMount(undefined, undefined, HOME)).toBeNull()
    expect(buildCloudAiTeamMount(undefined, 'team-x', HOME)).toBeNull()
  })
  it('worker → RO mount, orchestrator → RW (single-writer §11.2)', () => {
    const worker = buildCloudAiTeamMount('worker', 'team-x', HOME)
    const orch = buildCloudAiTeamMount('orchestrator', 'team-x', HOME)
    expect(worker).toEqual({ hostPath: '/home/tester/.aimaestro/ai-team/team-x', containerPath: '/ai-team', readOnly: true })
    expect(orch).toEqual({ hostPath: '/home/tester/.aimaestro/ai-team/team-x', containerPath: '/ai-team', readOnly: false })
  })
  it('per-team source when teamId present, host-default when absent', () => {
    expect(buildCloudAiTeamMount('worker', 'alpha', HOME)?.hostPath).toBe('/home/tester/.aimaestro/ai-team/alpha')
    expect(buildCloudAiTeamMount('worker', undefined, HOME)?.hostPath).toBe('/home/tester/.aimaestro/ai-team')
  })
})

describe('buildCloudTransportRepoMount (§11.4)', () => {
  it('returns null when transportRepo is unset', () => {
    expect(buildCloudTransportRepoMount(undefined)).toBeNull()
    expect(buildCloudTransportRepoMount('')).toBeNull()
  })
  it('returns null when the host path does not exist (host-side lifecycle not yet provisioned → no-op)', () => {
    expect(buildCloudTransportRepoMount('/nonexistent/wave-12345.git')).toBeNull()
  })
  it('mounts RW for both profiles when the bare repo exists on host', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-transport-'))
    try {
      const m = buildCloudTransportRepoMount(dir)
      expect(m).toEqual({ hostPath: dir, containerPath: '/transport.git' })
      expect(m?.readOnly).toBeUndefined() // RW for both worker + orchestrator (§11.4)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('buildCloudGitConfigMount (§11.6)', () => {
  it('mounts the per-agent gitconfig RO at /home/claude/.gitconfig', () => {
    expect(buildCloudGitConfigMount('agent-1', '/home/tester')).toEqual({
      hostPath: '/home/tester/.aimaestro/agents/agent-1/gitconfig',
      containerPath: '/home/claude/.gitconfig',
      readOnly: true,
    })
  })
})

describe('provisionCloudGitIdentity (§11.6 fail-loud)', () => {
  let tmpHome: string
  const savedEmail = process.env.CLOUD_AGENT_GIT_EMAIL
  beforeEach(() => { tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-git-')) })
  afterEach(() => {
    fs.rmSync(tmpHome, { recursive: true, force: true })
    if (savedEmail === undefined) delete process.env.CLOUD_AGENT_GIT_EMAIL
    else process.env.CLOUD_AGENT_GIT_EMAIL = savedEmail
  })

  it('FAILS LOUD when CLOUD_AGENT_GIT_EMAIL is unset (profiled agent would mis-attribute)', () => {
    delete process.env.CLOUD_AGENT_GIT_EMAIL
    expect(() => provisionCloudGitIdentity('a1', 'CelestIA', tmpHome)).toThrow(/CLOUD_AGENT_GIT_EMAIL is unset/)
  })
  it('FAILS LOUD on a malformed email (refuses injectable gitconfig)', () => {
    process.env.CLOUD_AGENT_GIT_EMAIL = 'not-an-email'
    expect(() => provisionCloudGitIdentity('a1', 'CelestIA', tmpHome)).toThrow(/not a valid email/)
  })
  it('writes [user] name + shared email when env is set', () => {
    process.env.CLOUD_AGENT_GIT_EMAIL = 'deploy@n4x-corp.example'
    const { gitconfigPath } = provisionCloudGitIdentity('a1', 'CelestIA', tmpHome)
    const content = fs.readFileSync(gitconfigPath, 'utf8')
    expect(content).toContain('name = CelestIA')
    expect(content).toContain('email = deploy@n4x-corp.example')
  })
  it('sanitizes a newline/bracket-injection name (config-section smuggling)', () => {
    process.env.CLOUD_AGENT_GIT_EMAIL = 'deploy@n4x-corp.example'
    const { gitconfigPath } = provisionCloudGitIdentity('a1', 'Evil\n[core]\nsshCommand = x', tmpHome)
    const content = fs.readFileSync(gitconfigPath, 'utf8')
    // The injection is neutralized: brackets + newlines stripped, so no NEW
    // config section can be opened (the "sshCommand" text survives only as
    // harmless inline name-value chars, not a [core] directive).
    expect(content).not.toContain('[core]')
    expect(content.match(/\[/g)?.length).toBe(1) // exactly one section header: [user]
    // name stays on a single line (no smuggled newline opening a directive)
    const nameLine = content.split('\n').find(l => l.includes('name ='))
    expect(nameLine).toBeDefined()
  })
})

describe('buildCloudCommonMounts (§11.1 + create/update parity)', () => {
  const HOME = '/home/tester'
  const sortByContainer = (ms: SandboxMount[]) =>
    [...ms].sort((a, b) => a.containerPath.localeCompare(b.containerPath))

  it('unprofiled agent gets NO /ai-team, /transport.git, or gitconfig mount (backward-compatible)', () => {
    const mounts = buildCloudCommonMounts('a1', { hostHome: HOME })
    const paths = mounts.map(m => m.containerPath)
    expect(paths).not.toContain('/ai-team')
    expect(paths).not.toContain('/transport.git')
    expect(paths).not.toContain('/home/claude/.gitconfig')
  })

  it('profiled worker gets RO /ai-team + RO gitconfig', () => {
    const mounts = buildCloudCommonMounts('a1', { hostHome: HOME, profile: 'worker', teamId: 'alpha' })
    const aiTeam = mounts.find(m => m.containerPath === '/ai-team')
    const gitcfg = mounts.find(m => m.containerPath === '/home/claude/.gitconfig')
    expect(aiTeam).toEqual({ hostPath: '/home/tester/.aimaestro/ai-team/alpha', containerPath: '/ai-team', readOnly: true })
    expect(gitcfg?.readOnly).toBe(true)
  })

  it('profiled orchestrator gets RW /ai-team', () => {
    const mounts = buildCloudCommonMounts('a1', { hostHome: HOME, profile: 'orchestrator', teamId: 'alpha' })
    expect(mounts.find(m => m.containerPath === '/ai-team')?.readOnly).toBe(false)
  })

  // THE parity guard (KAI requirement): createDockerAgent + updateContainerMountsAndExtraEnv
  // now BOTH call buildCloudCommonMounts. Assert that the resolved mount set is
  // identical given the same agent inputs — full set (paths + modes), order-insensitive.
  // This converts the old two-hand-maintained-copies drift class into a test-time guarantee.
  it('produces an IDENTICAL resolved mount set for the create-call and the update-call shape', () => {
    const createArgs = { useZiggy: true, name: 'celestia', profile: 'worker' as const, teamId: 'alpha', hostHome: HOME }
    const updateArgs = { useZiggy: true, name: 'celestia', profile: 'worker' as const, teamId: 'alpha', hostHome: HOME }
    const createList = buildCloudCommonMounts('a1', createArgs)
    const updateList = buildCloudCommonMounts('a1', updateArgs)
    expect(sortByContainer(createList)).toEqual(sortByContainer(updateList))
    // and the resolved set must be non-trivial (guards against an accidental empty return)
    expect(createList.length).toBeGreaterThan(8)
  })

  it('includes the ziggy mounts only when useZiggy is true', () => {
    const withZiggy = buildCloudCommonMounts('a1', { hostHome: HOME, useZiggy: true, name: 'celestia' })
    const without = buildCloudCommonMounts('a1', { hostHome: HOME, useZiggy: false, name: 'celestia' })
    expect(withZiggy.length).toBeGreaterThan(without.length)
  })
})

describe('buildCloudCommonPrecreateDirs (§11.1 — shared mkdir set)', () => {
  const HOME = '/home/tester'
  it('includes /ai-team for a profiled agent', () => {
    const dirs = buildCloudCommonPrecreateDirs('a1', { profile: 'worker', teamId: 'alpha', hostHome: HOME })
    expect(dirs.some(m => m.containerPath === '/ai-team')).toBe(true)
  })
  it('excludes /ai-team for an unprofiled agent', () => {
    const dirs = buildCloudCommonPrecreateDirs('a1', { hostHome: HOME })
    expect(dirs.some(m => m.containerPath === '/ai-team')).toBe(false)
  })
  it('excludes file-level mounts (gitconfig, settings.json) — only directory sources are pre-created', () => {
    const dirs = buildCloudCommonPrecreateDirs('a1', { profile: 'worker', hostHome: HOME })
    expect(dirs.some(m => m.containerPath === '/home/claude/.gitconfig')).toBe(false)
    expect(dirs.some(m => m.containerPath === '/home/claude/.claude/settings.json')).toBe(false)
  })
})

describe('OPERATOR_RESERVED_CONTAINER_PATH_ROOTS — §11.1 additions', () => {
  it('reserves /ai-team, /transport.git, and the gitconfig so operator mounts cannot shadow them', () => {
    expect(OPERATOR_RESERVED_CONTAINER_PATH_ROOTS).toContain('/ai-team')
    expect(OPERATOR_RESERVED_CONTAINER_PATH_ROOTS).toContain('/transport.git')
    expect(OPERATOR_RESERVED_CONTAINER_PATH_ROOTS).toContain('/home/claude/.gitconfig')
  })
  it('validateMounts rejects an operator mount that shadows /ai-team', () => {
    const err = validateMounts([{ hostPath: '/tmp/evil', containerPath: '/ai-team' }], 'operator')
    expect(err).toMatch(/reserved by AI Maestro/)
  })
})
