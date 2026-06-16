/**
 * Agent Path Resolvers Tests
 *
 * Pins the cloud-vs-host branching for conversation JSONL + chat-state file
 * lookups. Cloud agents read from the per-agent bind-mounted host path that
 * mirrors the in-container layout (claude-projects/-workspace/, chat-state/);
 * host agents read from the operator's host $HOME under the same conventions
 * Claude Code itself uses. (Kanban 2853e62d, sister to PR #115 / 7a94534e.)
 */

import { describe, it, expect } from 'vitest'
import * as crypto from 'crypto'
import * as path from 'path'

import { resolveConversationDir, resolveChatStateFile } from '@/lib/agent-paths'
import { CONTAINER_CWD, CONTAINER_CWD_ENCODED } from '@/lib/container-utils'

const HOST_HOME = '/home/operator'

function md5short(s: string): string {
  return crypto.createHash('md5').update(s).digest('hex').substring(0, 16)
}

describe('resolveConversationDir', () => {
  it('host agent: derives from operator $HOME and host workingDirectory', () => {
    const agent = {
      id: 'agent-host-1',
      workingDirectory: '/home/operator/code/n4-armory',
      deployment: { type: 'local' as const },
    }
    const dir = resolveConversationDir(agent, HOST_HOME)
    expect(dir).toBe(path.join(HOST_HOME, '.claude', 'projects', '-home-operator-code-n4-armory'))
  })

  it('host ANTIGRAVITY agent: resolves to operator ~/.gemini/antigravity-cli, NOT ~/.claude/projects (local-antigravity bug, host-branch counterpart to #219)', () => {
    const agent = {
      id: 'a499e31a-fake-ginger',
      program: 'antigravity',
      workingDirectory: '/home/operator/Documents/Development/n4safety-app',
      deployment: { type: 'local' as const },
    }
    const dir = resolveConversationDir(agent, HOST_HOME)
    expect(dir).toBe(path.join(HOST_HOME, '.gemini', 'antigravity-cli'))
    expect(dir).not.toMatch(/\.claude\/projects/)
  })

  it('host antigravity resolves even without a workingDirectory (history.jsonl is not cwd-keyed)', () => {
    const agent = { id: 'g2', program: 'antigravity', deployment: { type: 'local' as const } }
    expect(resolveConversationDir(agent, HOST_HOME)).toBe(path.join(HOST_HOME, '.gemini', 'antigravity-cli'))
  })

  it('host CODEX agent: resolves to operator ~/.codex/sessions, NOT ~/.claude/projects (host-codex bug, #225)', () => {
    const agent = {
      id: '537a41e8-fake-builder',
      program: 'codex',
      workingDirectory: '/home/operator/Documents/Development/n4safety-app',
      deployment: { type: 'local' as const },
    }
    const dir = resolveConversationDir(agent, HOST_HOME)
    // recursive date-nested rollout scan is applied downstream by resolveActiveTranscript
    expect(dir).toBe(path.join(HOST_HOME, '.codex', 'sessions'))
    expect(dir).not.toMatch(/\.claude\/projects/)
  })

  it('host codex resolves even without a workingDirectory (rollouts live under ~/.codex/sessions, not cwd-keyed)', () => {
    const agent = { id: 'c2', program: 'codex', deployment: { type: 'local' as const } }
    expect(resolveConversationDir(agent, HOST_HOME)).toBe(path.join(HOST_HOME, '.codex', 'sessions'))
  })

  it('host CLAUDE path is unchanged by the program switch (regression guard for #223/#225)', () => {
    const agent = { id: 'h1', workingDirectory: '/home/operator/code/x', deployment: { type: 'local' as const } }
    expect(resolveConversationDir(agent, HOST_HOME)).toBe(path.join(HOST_HOME, '.claude', 'projects', '-home-operator-code-x'))
    // a host claude agent with no workingDirectory still returns null
    expect(resolveConversationDir({ id: 'h2', deployment: { type: 'local' as const } }, HOST_HOME)).toBeNull()
  })

  it('cloud agent: derives from per-agent host path + CONTAINER_CWD_ENCODED, ignores host workingDirectory', () => {
    const agent = {
      id: '70b119e9-5793-44f5-b891-229aa330ff1c',
      // host registry stores the host-side path, but the cloud branch must
      // NOT use it — Claude Code inside the container runs in /workspace.
      workingDirectory: '/home/operator/Documents/Development/allianceos',
      deployment: { type: 'cloud' as const, cloud: { containerName: 'aim-dev-allianceos-luke' } },
    }
    const dir = resolveConversationDir(agent, HOST_HOME)
    expect(dir).toBe(
      path.join(
        HOST_HOME,
        '.aimaestro',
        'agents',
        '70b119e9-5793-44f5-b891-229aa330ff1c',
        'claude-projects',
        CONTAINER_CWD_ENCODED,
      ),
    )
  })

  it('cloud Gemini agent: derives from per-agent gemini-chats path, ignores host workingDirectory (kanban d937c33d)', () => {
    const agent = {
      id: 'a26f6822-fake-uuid-mason-on-holmes',
      program: 'gemini',
      workingDirectory: '/home/operator/code/n4-armory',
      deployment: { type: 'cloud' as const, cloud: { containerName: 'aim-ops-exec-mason' } },
    }
    const dir = resolveConversationDir(agent, HOST_HOME)
    expect(dir).toBe(
      path.join(
        HOST_HOME,
        '.aimaestro',
        'agents',
        'a26f6822-fake-uuid-mason-on-holmes',
        'gemini-chats',
      ),
    )
  })

  it('cloud Antigravity agent: derives from per-agent antigravity-app-data ROOT, not conversations/ (#219 — history.jsonl lives at root; conversations/ is .pb/.db black box)', () => {
    const agent = {
      id: 'b1c2d3e4-fake-uuid-antigravity-pilot',
      program: 'antigravity',
      workingDirectory: '/home/operator/code/n4-armory',
      deployment: { type: 'cloud' as const, cloud: { containerName: 'aim-pilot-antigravity' } },
    }
    const dir = resolveConversationDir(agent, HOST_HOME)
    expect(dir).toBe(
      path.join(
        HOST_HOME,
        '.aimaestro',
        'agents',
        'b1c2d3e4-fake-uuid-antigravity-pilot',
        'antigravity-app-data',
      ),
    )
    // Explicitly NOT the conversations/ subdir (the old stub target) — that
    // holds only protobuf/sqlite blobs the .jsonl scanner can't read.
    expect(dir).not.toMatch(/conversations$/)
  })

  it('cloud Codex agent: derives from per-agent codex-app-data/sessions path (kanban 01e11bf9, single-dir OPT-B mount)', () => {
    const agent = {
      id: 'future-codex-uuid',
      program: 'codex',
      deployment: { type: 'cloud' as const, cloud: { containerName: 'aim-future-codex' } },
    }
    expect(resolveConversationDir(agent, HOST_HOME)).toBe(
      path.join(
        HOST_HOME,
        '.aimaestro',
        'agents',
        'future-codex-uuid',
        'codex-app-data',
        'sessions',
      ),
    )
  })

  it('cloud agent with no explicit program defaults to claude path', () => {
    const agent = {
      id: 'pre-pr-117-no-program-field',
      deployment: { type: 'cloud' as const, cloud: { containerName: 'aim-legacy' } },
    }
    const dir = resolveConversationDir(agent, HOST_HOME)
    expect(dir).toBe(
      path.join(HOST_HOME, '.aimaestro', 'agents', 'pre-pr-117-no-program-field', 'claude-projects', CONTAINER_CWD_ENCODED),
    )
  })

  it('host agent: returns null when no working directory is configured', () => {
    const agent = {
      id: 'agent-host-2',
      deployment: { type: 'local' as const },
    }
    expect(resolveConversationDir(agent, HOST_HOME)).toBeNull()
  })

  it('host agent: falls back to sessions[0].workingDirectory and then preferences', () => {
    const fromSessions = resolveConversationDir(
      {
        id: 'a',
        sessions: [{ workingDirectory: '/home/operator/from-session' }],
      },
      HOST_HOME,
    )
    expect(fromSessions).toBe(path.join(HOST_HOME, '.claude', 'projects', '-home-operator-from-session'))

    const fromPrefs = resolveConversationDir(
      {
        id: 'b',
        preferences: { defaultWorkingDirectory: '/home/operator/from-prefs' },
      },
      HOST_HOME,
    )
    expect(fromPrefs).toBe(path.join(HOST_HOME, '.claude', 'projects', '-home-operator-from-prefs'))
  })
})

describe('resolveChatStateFile', () => {
  it('host agent: hashes the host workingDirectory + reads from shared host chat-state dir', () => {
    const workingDir = '/home/operator/code/n4-armory'
    const agent = {
      id: 'agent-host-1',
      workingDirectory: workingDir,
      deployment: { type: 'local' as const },
    }
    const expected = path.join(HOST_HOME, '.aimaestro', 'chat-state', `${md5short(workingDir)}.json`)
    expect(resolveChatStateFile(agent, HOST_HOME)).toBe(expected)
  })

  it('cloud agent: hashes CONTAINER_CWD ("/workspace") + reads from per-agent chat-state dir', () => {
    const agent = {
      id: 'cloud-1',
      workingDirectory: '/home/operator/Documents/Development/allianceos',
      deployment: { type: 'cloud' as const, cloud: { containerName: 'aim-dev-allianceos-luke' } },
    }
    // The hook runs inside the container at cwd=/workspace, so its file
    // name is hash('/workspace'), and the dir is the per-agent bind-mounted
    // chat-state directory — NOT the operator's shared chat-state.
    const expected = path.join(
      HOST_HOME,
      '.aimaestro',
      'agents',
      'cloud-1',
      'chat-state',
      `${md5short(CONTAINER_CWD)}.json`,
    )
    expect(resolveChatStateFile(agent, HOST_HOME)).toBe(expected)
  })

  it('host agent: returns null when no working directory is configured', () => {
    const agent = {
      id: 'agent-host-noop',
      deployment: { type: 'local' as const },
    }
    expect(resolveChatStateFile(agent, HOST_HOME)).toBeNull()
  })
})
