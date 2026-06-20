import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execSync } from 'child_process'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

// End-to-end test for scripts/reseed-skip-dangerous-mode.cjs.
// Spawns the script as a subprocess against a fixture registry to validate the
// full path: arg parsing → registry walk → per-agent settings read/merge/write.

const SCRIPT = path.join(__dirname, '..', 'scripts', 'reseed-skip-dangerous-mode.cjs')

function runScript(registryPath: string, args: string[] = []): { stdout: string; status: number } {
  try {
    const stdout = execSync(`node ${SCRIPT} --registry ${registryPath} ${args.join(' ')}`, {
      encoding: 'utf8',
    })
    return { stdout, status: 0 }
  } catch (err: any) {
    return { stdout: err.stdout?.toString() || '', status: err.status ?? 1 }
  }
}

describe('reseed-skip-dangerous-mode.cjs', () => {
  let fixtureDir: string
  let registryPath: string

  beforeEach(() => {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reseed-test-'))
    registryPath = path.join(fixtureDir, 'agents', 'registry.json')
    fs.mkdirSync(path.dirname(registryPath), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(fixtureDir, { recursive: true, force: true })
  })

  function seedAgent(id: string, settings: Record<string, unknown> | null) {
    const agentDir = path.join(fixtureDir, 'agents', id)
    fs.mkdirSync(agentDir, { recursive: true })
    if (settings !== null) {
      fs.writeFileSync(path.join(agentDir, 'claude-settings.json'), JSON.stringify(settings))
    }
  }

  function writeRegistry(agents: any[]) {
    fs.writeFileSync(registryPath, JSON.stringify(agents))
  }

  it('reseeds a cloud claude agent missing skipDangerousModePermissionPrompt', () => {
    writeRegistry([
      { id: 'aaa', name: 'agent-one', program: 'claude', deployment: { type: 'cloud' } },
    ])
    seedAgent('aaa', { hooks: { Stop: [] } })

    const { stdout, status } = runScript(registryPath)
    expect(status).toBe(0)
    expect(stdout).toContain('1 reseeded')

    const result = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'agents', 'aaa', 'claude-settings.json'), 'utf8'))
    expect(result.skipDangerousModePermissionPrompt).toBe(true)
    // Existing keys are preserved
    expect(result.hooks).toEqual({ Stop: [] })
  })

  it('is idempotent — second run does not mutate already-seeded agents', () => {
    writeRegistry([
      { id: 'bbb', name: 'agent-two', program: 'claude-code', deployment: { type: 'cloud' } },
    ])
    seedAgent('bbb', { skipDangerousModePermissionPrompt: true, hooks: {} })

    const before = fs.readFileSync(path.join(fixtureDir, 'agents', 'bbb', 'claude-settings.json'), 'utf8')
    const { stdout, status } = runScript(registryPath)
    expect(status).toBe(0)
    expect(stdout).toContain('1 already-seeded')
    const after = fs.readFileSync(path.join(fixtureDir, 'agents', 'bbb', 'claude-settings.json'), 'utf8')
    expect(after).toBe(before)
  })

  it('skips non-cloud (host) agents and non-claude programs', () => {
    writeRegistry([
      { id: 'host-agent', name: 'host-one', program: 'claude', deployment: { type: 'local' } },
      { id: 'gemini-cloud', name: 'gemini-one', program: 'gemini', deployment: { type: 'cloud' } },
    ])
    seedAgent('host-agent', { hooks: {} })
    seedAgent('gemini-cloud', { someGeminiKey: true })

    const { stdout, status } = runScript(registryPath)
    expect(status).toBe(0)
    expect(stdout).toContain('No cloud claude agents')

    // Both files untouched
    const host = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'agents', 'host-agent', 'claude-settings.json'), 'utf8'))
    expect(host.skipDangerousModePermissionPrompt).toBeUndefined()
    const gemini = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'agents', 'gemini-cloud', 'claude-settings.json'), 'utf8'))
    expect(gemini.skipDangerousModePermissionPrompt).toBeUndefined()
  })

  it('--dry-run does not mutate the file', () => {
    writeRegistry([
      { id: 'ccc', name: 'agent-three', program: 'claude', deployment: { type: 'cloud' } },
    ])
    const original = { hooks: { Notification: [] } }
    seedAgent('ccc', original)

    const { stdout, status } = runScript(registryPath, ['--dry-run'])
    expect(status).toBe(0)
    expect(stdout).toContain('would-reseed')

    const onDisk = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'agents', 'ccc', 'claude-settings.json'), 'utf8'))
    expect(onDisk).toEqual(original)
    expect(onDisk.skipDangerousModePermissionPrompt).toBeUndefined()
  })

  it('reports no-settings-file when the per-agent settings.json is absent', () => {
    writeRegistry([
      { id: 'no-settings', name: 'phantom', program: 'claude', deployment: { type: 'cloud' } },
    ])
    // No seedAgent call — agent dir + settings file do not exist.

    const { stdout, status } = runScript(registryPath)
    expect(status).toBe(0)
    expect(stdout).toContain('1 no-settings-file')
  })

  it('handles unparseable claude-settings.json without crashing', () => {
    writeRegistry([
      { id: 'corrupt', name: 'corrupt', program: 'claude', deployment: { type: 'cloud' } },
    ])
    const agentDir = path.join(fixtureDir, 'agents', 'corrupt')
    fs.mkdirSync(agentDir, { recursive: true })
    fs.writeFileSync(path.join(agentDir, 'claude-settings.json'), '{not json')

    const { stdout, status } = runScript(registryPath)
    expect(status).toBe(0)
    expect(stdout).toContain('unparseable')
  })

  it('exits 2 when the registry file is missing', () => {
    const { status } = runScript('/tmp/this-path-definitely-does-not-exist.json')
    expect(status).toBe(2)
  })

  it('preserves operator-set keys alongside the new field', () => {
    writeRegistry([
      { id: 'rich', name: 'agent-four', program: 'claude', deployment: { type: 'cloud' } },
    ])
    const original = {
      allowedTools: ['Bash', 'Read'],
      model: 'claude-sonnet-4-6',
      hooks: { Stop: [{ hooks: [] }] },
    }
    seedAgent('rich', original)

    const { stdout, status } = runScript(registryPath)
    expect(status).toBe(0)
    expect(stdout).toContain('1 reseeded')

    const result = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'agents', 'rich', 'claude-settings.json'), 'utf8'))
    expect(result.skipDangerousModePermissionPrompt).toBe(true)
    expect(result.allowedTools).toEqual(['Bash', 'Read'])
    expect(result.model).toBe('claude-sonnet-4-6')
    expect(result.hooks).toEqual({ Stop: [{ hooks: [] }] })
  })
})
