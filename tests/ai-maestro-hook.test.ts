/**
 * AI Maestro Agent Hook — AskUserQuestion capture tests
 *
 * Locks the chat-hang fix (kanban ca761370). Claude Code DEFERS writing the
 * assistant turn (preamble + AskUserQuestion tool_use) to the transcript JSONL
 * until AFTER the user answers, so the transcript-driven chat view has nothing
 * to render and paints a blank spinner. The PreToolUse hook fires BEFORE the
 * block and carries tool_input.questions; we capture that into a question_prompt
 * hook state the chat view renders inline.
 *
 * Two load-bearing behaviors are pinned:
 *   1. PreToolUse(AskUserQuestion) writes status=question_prompt + questions[].
 *   2. The content-free Notification that follows MUST NOT downgrade a recent
 *      question_prompt to waiting_for_input (that clobber is the hang).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'

const HOOK = path.join(__dirname, '..', 'scripts', 'claude-hooks', 'ai-maestro-hook.cjs')
const CWD = '/tmp/aimaestro-hook-test-wd'

function stateFileFor(home: string): string {
  const hash = crypto.createHash('md5').update(CWD).digest('hex').substring(0, 16)
  return path.join(home, '.aimaestro', 'chat-state', `${hash}.json`)
}

function runHook(home: string, input: Record<string, unknown>) {
  // AIMAESTRO_HOST_URL points at a dead port so the fire-and-forget broadcast
  // fails fast instead of hitting a real maestro server during the test.
  return spawnSync('node', [HOOK], {
    input: JSON.stringify(input),
    env: { ...process.env, HOME: home, AIMAESTRO_HOST_URL: 'http://127.0.0.1:1' },
    encoding: 'utf8',
  })
}

describe('ai-maestro-hook AskUserQuestion capture', () => {
  let home: string

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-hook-'))
    // install-hooks.sh creates this dir; replicate so debugLog has somewhere to write
    fs.mkdirSync(path.join(home, '.aimaestro', 'chat-state'), { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('PreToolUse(AskUserQuestion) writes a question_prompt state carrying the questions payload', () => {
    runHook(home, {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      cwd: CWD,
      session_id: 's1',
      tool_input: {
        questions: [
          { question: 'Use A or B?', header: 'Approach', options: [{ label: 'A', description: 'do A' }, { label: 'B' }] },
        ],
      },
    })

    const state = JSON.parse(fs.readFileSync(stateFileFor(home), 'utf8'))
    expect(state.status).toBe('question_prompt')
    expect(state.questions).toHaveLength(1)
    expect(state.questions[0].question).toBe('Use A or B?')
    expect(state.questions[0].options[0].label).toBe('A')
  })

  it('ignores PreToolUse for non-AskUserQuestion tools (no question_prompt written)', () => {
    runHook(home, {
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      cwd: CWD,
      tool_input: { command: 'ls' },
    })
    // No state file should be created for an unmatched tool
    expect(fs.existsSync(stateFileFor(home))).toBe(false)
  })

  it('a following content-free Notification PRESERVES a recent question_prompt (does not downgrade to waiting_for_input)', () => {
    runHook(home, {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      cwd: CWD,
      tool_input: { questions: [{ question: 'Q?', options: [{ label: 'A' }, { label: 'B' }] }] },
    })
    runHook(home, {
      hook_event_name: 'Notification',
      notification_type: 'idle_prompt',
      cwd: CWD,
      message: 'waiting',
    })

    const state = JSON.parse(fs.readFileSync(stateFileFor(home), 'utf8'))
    expect(state.status).toBe('question_prompt')
    expect(state.questions).toHaveLength(1)
  })

  it('a permission_prompt Notification also preserves a recent question_prompt', () => {
    runHook(home, {
      hook_event_name: 'PreToolUse',
      tool_name: 'AskUserQuestion',
      cwd: CWD,
      tool_input: { questions: [{ question: 'Q?', options: [{ label: 'A' }] }] },
    })
    runHook(home, {
      hook_event_name: 'Notification',
      notification_type: 'permission_prompt',
      cwd: CWD,
      message: 'waiting',
    })

    const state = JSON.parse(fs.readFileSync(stateFileFor(home), 'utf8'))
    expect(state.status).toBe('question_prompt')
  })
})
