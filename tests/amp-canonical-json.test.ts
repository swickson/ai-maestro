import { describe, it, expect } from 'vitest'
import crypto from 'crypto'
import { canonicalStringify } from '@/lib/amp-canonical-json'

describe('canonicalStringify', () => {
  it('sorts top-level object keys lexicographically', () => {
    expect(canonicalStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalStringify({ z: 1, a: 1, m: 1 })).toBe('{"a":1,"m":1,"z":1}')
  })

  it('produces compact separators (no spaces)', () => {
    expect(canonicalStringify({ a: 1, b: [2, 3] })).toBe('{"a":1,"b":[2,3]}')
  })

  it('sorts keys at all nesting levels', () => {
    const out = canonicalStringify({
      outer_b: { inner_b: 1, inner_a: 2 },
      outer_a: { inner_z: { deep_b: 1, deep_a: 2 } },
    })
    expect(out).toBe(
      '{"outer_a":{"inner_z":{"deep_a":2,"deep_b":1}},"outer_b":{"inner_a":2,"inner_b":1}}'
    )
  })

  it('preserves array order (arrays are data, not metadata)', () => {
    expect(canonicalStringify([3, 1, 2])).toBe('[3,1,2]')
    expect(canonicalStringify(['z', 'a', 'm'])).toBe('["z","a","m"]')
  })

  it('sorts keys inside objects within arrays', () => {
    expect(canonicalStringify([{ b: 1, a: 2 }, { d: 3, c: 4 }])).toBe(
      '[{"a":2,"b":1},{"c":4,"d":3}]'
    )
  })

  it('handles null, primitives, and empty containers', () => {
    expect(canonicalStringify(null)).toBe('null')
    expect(canonicalStringify(42)).toBe('42')
    expect(canonicalStringify('hello')).toBe('"hello"')
    expect(canonicalStringify(true)).toBe('true')
    expect(canonicalStringify({})).toBe('{}')
    expect(canonicalStringify([])).toBe('[]')
  })

  it('produces identical output for objects with same content but different insertion order', () => {
    const a = { from: 'alice', to: 'bob', subject: 'hi', priority: 'normal' }
    const b = { priority: 'normal', subject: 'hi', to: 'bob', from: 'alice' }
    expect(canonicalStringify(a)).toBe(canonicalStringify(b))
  })

  it('produces a stable signature input regardless of key insertion order', () => {
    // Pinned regression vector. Any future refactor that re-introduces bare
    // JSON.stringify() will break this hash.
    const payload = { type: 'task', body: 'do the thing', priority: 'high', sender: 'agent-x' }
    const expectedHash = crypto
      .createHash('sha256')
      .update(canonicalStringify(payload))
      .digest('base64')

    // Same content, different insertion order — must produce identical hash.
    const reordered = { sender: 'agent-x', priority: 'high', body: 'do the thing', type: 'task' }
    const reorderedHash = crypto
      .createHash('sha256')
      .update(canonicalStringify(reordered))
      .digest('base64')
    expect(reorderedHash).toBe(expectedHash)

    // Pin the exact canonical bytes + hash. Mint-our-own compliant vector
    // until a real crabmail-shaped reference vector is available.
    expect(canonicalStringify(payload)).toBe(
      '{"body":"do the thing","priority":"high","sender":"agent-x","type":"task"}'
    )
    expect(expectedHash).toBe('gj18mS8lzjuRPADL7h4ke5Ku5vFJaTUjElh/vC+aVCw=')
  })

  it('canonicalizes deeply-nested AMP-shaped envelope payloads', () => {
    const payload = {
      meta: { team: 'the-dev-team', host: 'the-laptop' },
      attachments: [{ size: 1234, name: 'log.txt', kind: 'amp-v1' }],
      body: 'check the run',
      type: 'notification',
    }
    expect(canonicalStringify(payload)).toBe(
      '{"attachments":[{"kind":"amp-v1","name":"log.txt","size":1234}],"body":"check the run","meta":{"host":"the-laptop","team":"the-dev-team"},"type":"notification"}'
    )
  })

  it('canonicalizes AMP envelope with legacy-shape attachment (pinned vector)', () => {
    // AMPAttachmentLegacy shape (kind: 'legacy') — pre-#48 path-based
    // attachment. Pinning the canonical bytes catches any refactor that
    // re-introduces JSON.stringify on the legacy signing path before the
    // shape is fully cut (kanban b2ab2a77 governs the cut trigger).
    const payload = {
      type: 'task',
      body: 'review the log',
      attachments: [
        {
          kind: 'legacy',
          name: 'run.log',
          path: '/tmp/run.log',
          type: 'text/plain',
          size: 4096,
        },
      ],
      sender: 'agent-x',
    }
    const canonical = canonicalStringify(payload)
    expect(canonical).toBe(
      '{"attachments":[{"kind":"legacy","name":"run.log","path":"/tmp/run.log","size":4096,"type":"text/plain"}],"body":"review the log","sender":"agent-x","type":"task"}'
    )
    const hash = crypto.createHash('sha256').update(canonical).digest('base64')
    expect(hash).toBe('MagzqE6+TV8I26zpEVONrPwNHokkVOrfNPRR7i2uB2E=')

    // Key insertion-order independence — same content, shuffled keys, same hash.
    const reordered = {
      sender: 'agent-x',
      attachments: [
        {
          size: 4096,
          type: 'text/plain',
          path: '/tmp/run.log',
          name: 'run.log',
          kind: 'legacy',
        },
      ],
      body: 'review the log',
      type: 'task',
    }
    const reorderedHash = crypto
      .createHash('sha256')
      .update(canonicalStringify(reordered))
      .digest('base64')
    expect(reorderedHash).toBe(hash)
  })

  it('canonicalizes AMP envelope with amp-v1-shape attachment (pinned vector)', () => {
    // AMPAttachmentV1 shape (kind: 'amp-v1') — server-routed attachment
    // landed in PR #119. All 11 fields exercised; any reorder must produce
    // identical canonical bytes and hash.
    const payload = {
      type: 'task',
      body: 'review the log',
      attachments: [
        {
          kind: 'amp-v1',
          id: 'att_1234567890_abcdef',
          filename: 'run.log',
          content_type: 'text/plain',
          size: 4096,
          digest: 'a3b5c7d9e1f2a3b5c7d9e1f2a3b5c7d9e1f2a3b5c7d9e1f2a3b5c7d9e1f2a3b5',
          url: 'https://host.example/api/v1/attachments/att_1234567890_abcdef/download?sig=stub',
          scan_status: 'clean',
          uploaded_at: '2026-05-09T10:00:00Z',
          expires_at: '2026-05-16T10:00:00Z',
        },
      ],
      sender: 'agent-x',
    }
    const canonical = canonicalStringify(payload)
    expect(canonical).toBe(
      '{"attachments":[{"content_type":"text/plain","digest":"a3b5c7d9e1f2a3b5c7d9e1f2a3b5c7d9e1f2a3b5c7d9e1f2a3b5c7d9e1f2a3b5","expires_at":"2026-05-16T10:00:00Z","filename":"run.log","id":"att_1234567890_abcdef","kind":"amp-v1","scan_status":"clean","size":4096,"uploaded_at":"2026-05-09T10:00:00Z","url":"https://host.example/api/v1/attachments/att_1234567890_abcdef/download?sig=stub"}],"body":"review the log","sender":"agent-x","type":"task"}'
    )
    const hash = crypto.createHash('sha256').update(canonical).digest('base64')
    expect(hash).toBe('0MjdtZ/JTGN1C8hXkK3hFJXM+8JguRMPMcanivv7Xhc=')

    // Key insertion-order independence on the inner attachment object.
    const reordered = {
      sender: 'agent-x',
      type: 'task',
      body: 'review the log',
      attachments: [
        {
          expires_at: '2026-05-16T10:00:00Z',
          uploaded_at: '2026-05-09T10:00:00Z',
          scan_status: 'clean',
          url: 'https://host.example/api/v1/attachments/att_1234567890_abcdef/download?sig=stub',
          digest: 'a3b5c7d9e1f2a3b5c7d9e1f2a3b5c7d9e1f2a3b5c7d9e1f2a3b5c7d9e1f2a3b5',
          size: 4096,
          content_type: 'text/plain',
          filename: 'run.log',
          id: 'att_1234567890_abcdef',
          kind: 'amp-v1',
        },
      ],
    }
    const reorderedHash = crypto
      .createHash('sha256')
      .update(canonicalStringify(reordered))
      .digest('base64')
    expect(reorderedHash).toBe(hash)
  })

  it('canonicalizes mixed-shape attachment array (legacy + amp-v1) deterministically', () => {
    // During the PR #119 → kanban b2ab2a77 cut window, payloads can carry
    // both shapes side-by-side. Array order is preserved (arrays are data),
    // but each object's keys must canonicalize independently.
    const payload = {
      type: 'task',
      attachments: [
        { kind: 'legacy', name: 'old.txt', type: 'text/plain', size: 100 },
        {
          kind: 'amp-v1',
          id: 'att_9876543210_zyxwvu',
          filename: 'new.txt',
          content_type: 'text/plain',
          size: 200,
          digest: 'b'.repeat(64),
          url: 'https://host.example/api/v1/attachments/att_9876543210_zyxwvu/download?sig=stub',
          scan_status: 'clean',
          uploaded_at: '2026-05-09T11:00:00Z',
          expires_at: '2026-05-16T11:00:00Z',
        },
      ],
    }
    expect(canonicalStringify(payload)).toBe(
      '{"attachments":[{"kind":"legacy","name":"old.txt","size":100,"type":"text/plain"},{"content_type":"text/plain","digest":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","expires_at":"2026-05-16T11:00:00Z","filename":"new.txt","id":"att_9876543210_zyxwvu","kind":"amp-v1","scan_status":"clean","size":200,"uploaded_at":"2026-05-09T11:00:00Z","url":"https://host.example/api/v1/attachments/att_9876543210_zyxwvu/download?sig=stub"}],"type":"task"}'
    )
  })

  it('canonicalizes the federated webhook delivery body shape', () => {
    // Pinned vector matching lib/message-delivery.ts:157 — the body fed into
    // the X-AMP-Signature webhook HMAC. Same key-order independence concern
    // as the AMP envelope signature, since a compliant peer that re-parses
    // and re-canonicalizes for verification would silently fail with bare
    // JSON.stringify on the sender side.
    const webhookBody = {
      sender_public_key: 'ed25519-public-hex',
      payload: { type: 'task', body: 'do the thing' },
      envelope: { to: 'bob@host', subject: 'hi', from: 'alice@host' },
    }
    expect(canonicalStringify(webhookBody)).toBe(
      '{"envelope":{"from":"alice@host","subject":"hi","to":"bob@host"},"payload":{"body":"do the thing","type":"task"},"sender_public_key":"ed25519-public-hex"}'
    )
  })
})
