/**
 * Codex Message Normalizer Tests
 *
 * Pins the Codex rollout-JSONL → Claude-shape transform so cloud-Codex
 * chat-panel rendering stays provider-agnostic in ChatView. Sample shapes are
 * empirically grounded from live cloud-Codex rollouts (an agent ca9d97c2,
 * the prod host 2026-06-15, issue #159).
 */

import { describe, it, expect } from 'vitest'

import { normalizeCodexLine } from '@/lib/codex-message-normalizer'

describe('normalizeCodexLine', () => {
  it('returns null for session_meta / turn_context / event_msg metadata lines', () => {
    expect(normalizeCodexLine({ timestamp: 't', type: 'session_meta', payload: { id: 's1', cwd: '/workspace' } })).toBeNull()
    expect(normalizeCodexLine({ timestamp: 't', type: 'turn_context', payload: { turn_id: '1', model: 'gpt-5' } })).toBeNull()
    expect(normalizeCodexLine({ timestamp: 't', type: 'event_msg', payload: { type: 'task_started', turn_id: '1' } })).toBeNull()
  })

  it('returns null for response_item reasoning / function_call / function_call_output items', () => {
    expect(normalizeCodexLine({ timestamp: 't', type: 'response_item', payload: { type: 'reasoning', summary: [] } })).toBeNull()
    expect(normalizeCodexLine({ timestamp: 't', type: 'response_item', payload: { type: 'function_call', name: 'shell' } })).toBeNull()
    expect(normalizeCodexLine({ timestamp: 't', type: 'response_item', payload: { type: 'function_call_output', output: 'x' } })).toBeNull()
  })

  it('returns null for developer (system/permissions) message turns', () => {
    const raw = {
      timestamp: '2026-06-15T19:19:22Z',
      type: 'response_item',
      payload: { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<permissions instructions>...' }] },
    }
    expect(normalizeCodexLine(raw)).toBeNull()
  })

  it('normalizes a user message (input_text) to Claude-shape user message', () => {
    const raw = {
      timestamp: '2026-06-15T19:19:30Z',
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'build the thing' }] },
    }
    expect(normalizeCodexLine(raw)).toEqual({
      type: 'user',
      message: { content: [{ type: 'text', text: 'build the thing' }] },
      timestamp: '2026-06-15T19:19:30Z',
    })
  })

  it('normalizes an assistant message (output_text) to Claude-shape assistant message', () => {
    const raw = {
      timestamp: '2026-06-15T19:20:00Z',
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done — PR is up.' }] },
    }
    expect(normalizeCodexLine(raw)).toEqual({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'done — PR is up.' }] },
      timestamp: '2026-06-15T19:20:00Z',
    })
  })

  it('joins multiple content blocks with double-newline (mirrors ChatView getMessageContent)', () => {
    const raw = {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'first' }, { type: 'output_text', text: 'second' }],
      },
    }
    expect(normalizeCodexLine(raw)?.message.content[0].text).toBe('first\n\nsecond')
  })

  it('returns null for empty / non-text content (no renderable text)', () => {
    expect(normalizeCodexLine({ type: 'response_item', payload: { type: 'message', role: 'user', content: [] } })).toBeNull()
    expect(normalizeCodexLine({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text' }] } })).toBeNull()
  })

  it('returns null for non-response_item types and malformed payloads', () => {
    expect(normalizeCodexLine({ type: 'something_else', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'x' }] } })).toBeNull()
    expect(normalizeCodexLine({ type: 'response_item' })).toBeNull()
    expect(normalizeCodexLine({ type: 'response_item', payload: null })).toBeNull()
  })

  it('returns null for non-object inputs', () => {
    expect(normalizeCodexLine(null)).toBeNull()
    expect(normalizeCodexLine('not-an-object')).toBeNull()
    expect(normalizeCodexLine(42)).toBeNull()
  })
})
