/**
 * AMP attachment tests (kanban #48).
 *
 * Covers the load-bearing security + protocol surfaces:
 * - Filename sanitization rejects/coerces non-allowed shapes
 * - MIME sniff blocks executables regardless of declared content_type
 * - Signed URL HMAC verifies + uses canonical-stringify for cross-impl
 *   compatibility (pinned regression vector)
 * - Storage primitive round-trips meta + blob
 *
 * Route-level integration tests deferred to follow-up — these cover the
 * primitives that the routes thinly wrap.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

import { isValid, sanitize } from '@/lib/attachment-filename'
import { sniff } from '@/lib/attachment-mime'
import {
  signToken,
  verifyToken,
  buildSignedUrl,
  verifySignedRequest,
} from '@/lib/attachment-signer'
import {
  generateAttachmentId,
  writeMeta,
  readMeta,
  writeBlob,
  readBlob,
  blobSize,
  digestBlob,
  defaultExpiresAt,
  attachmentDir,
  type AttachmentMeta,
} from '@/lib/attachment-storage'

describe('attachment-filename sanitization', () => {
  it('accepts plain alphanumeric + dot/underscore/hyphen', () => {
    expect(isValid('photo.png')).toBe(true)
    expect(isValid('log_2026-05-05.txt')).toBe(true)
    expect(isValid('a.b.c')).toBe(true)
  })

  it('rejects path separators + parent traversal', () => {
    expect(isValid('../etc/passwd')).toBe(false)
    expect(isValid('foo/bar.txt')).toBe(false)
    expect(isValid('foo\\bar.txt')).toBe(false)
    expect(isValid('..')).toBe(false)
    expect(isValid('.')).toBe(false)
  })

  it('rejects double-encoded separators', () => {
    expect(isValid('foo%2Fbar')).toBe(false)
    expect(isValid('foo%5Cbar')).toBe(false)
    expect(isValid('foo%2fbar')).toBe(false) // case-insensitive
  })

  it('rejects null bytes + empty', () => {
    expect(isValid('foo\0bar')).toBe(false)
    expect(isValid('')).toBe(false)
  })

  it('rejects Windows reserved device names (with or without extension)', () => {
    expect(isValid('CON')).toBe(false)
    expect(isValid('PRN.txt')).toBe(false)
    expect(isValid('COM1')).toBe(false)
    expect(isValid('LPT9.log')).toBe(false)
  })

  it('rejects names exceeding 255 chars', () => {
    expect(isValid('a'.repeat(256))).toBe(false)
    expect(isValid('a'.repeat(255))).toBe(true)
  })

  it('sanitize coerces disallowed chars to underscores', () => {
    expect(sanitize('hello world.txt')).toBe('hello_world.txt')
    expect(sanitize('foo@bar.png')).toBe('foo_bar.png')
  })

  it('sanitize strips leading/trailing dots and dashes', () => {
    expect(sanitize('..hidden.png')).toBe('hidden.png')
    expect(sanitize('-trailing-')).toBe('trailing')
  })

  it('sanitize returns null for unrecoverable inputs', () => {
    expect(sanitize('')).toBeNull()
    expect(sanitize('...')).toBeNull()
    expect(sanitize('CON')).toBeNull()
  })
})

describe('attachment-mime sniff', () => {
  it('detects PNG by magic bytes', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    const r = sniff(png)
    expect(r.detected_type).toBe('image/png')
    expect(r.is_executable).toBe(false)
  })

  it('flags Linux ELF as executable', () => {
    const elf = Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 0, 0, 0])
    const r = sniff(elf)
    expect(r.is_executable).toBe(true)
    expect(r.detected_type).toBe('application/x-executable')
  })

  it('flags Windows PE (MZ) as executable even if client declares image/png', () => {
    const mz = Buffer.from([0x4d, 0x5a, 0, 0, 0, 0, 0, 0])
    const r = sniff(mz, 'image/png')
    expect(r.is_executable).toBe(true)
    expect(r.detected_type).toBe('application/x-msdownload')
  })

  it('flags shebang script as executable (#!)', () => {
    const sh = Buffer.from('#!/bin/sh\necho rm -rf /')
    const r = sniff(sh)
    expect(r.is_executable).toBe(true)
    expect(r.detected_type).toBe('application/x-sh')
  })

  it('falls back to declared type for unknown magic', () => {
    const unknown = Buffer.from([0x42, 0x42, 0x42, 0x42])
    const r = sniff(unknown, 'application/custom')
    expect(r.detected_type).toBe('application/custom')
    expect(r.is_executable).toBe(false)
  })

  it('falls back to octet-stream when declared is null', () => {
    const r = sniff(Buffer.from([0x42, 0x42, 0x42, 0x42]))
    expect(r.detected_type).toBe('application/octet-stream')
  })
})

describe('attachment-signer', () => {
  // Use a fixed env secret so the tests are deterministic regardless of
  // host-side ~/.aimaestro/attachment-signing-secret state.
  beforeEach(() => {
    process.env.AMP_ATTACHMENT_SIGNING_SECRET = 'test-secret-32-bytes-AAAAAAAAAAAA'
  })

  it('signToken is deterministic for same payload', () => {
    const a = signToken({ action: 'download', att_id: 'att_abc', exp: 1700000000000 })
    const b = signToken({ action: 'download', att_id: 'att_abc', exp: 1700000000000 })
    expect(a).toBe(b)
  })

  it('signToken differs across actions even with same att_id and exp', () => {
    const u = signToken({ action: 'upload', att_id: 'att_abc', exp: 1700000000000 })
    const d = signToken({ action: 'download', att_id: 'att_abc', exp: 1700000000000 })
    expect(u).not.toBe(d)
  })

  it('verifyToken accepts matching signature', () => {
    const sig = signToken({ action: 'download', att_id: 'att_xyz', exp: 1700000000000 })
    expect(verifyToken({ action: 'download', att_id: 'att_xyz', exp: 1700000000000 }, sig)).toBe(true)
  })

  it('verifyToken rejects tampered signature', () => {
    const sig = signToken({ action: 'download', att_id: 'att_xyz', exp: 1700000000000 })
    expect(verifyToken({ action: 'download', att_id: 'att_xyz', exp: 1700000000001 }, sig)).toBe(false)
    expect(verifyToken({ action: 'upload', att_id: 'att_xyz', exp: 1700000000000 }, sig)).toBe(false)
    expect(verifyToken({ action: 'download', att_id: 'att_other', exp: 1700000000000 }, sig)).toBe(false)
  })

  it('PINNED VECTOR: signature byte-for-byte stable for canonical payload shape', () => {
    // Any future refactor that re-introduces bare JSON.stringify in the
    // signing path will break this hash. Same load-bearing role as the
    // canonical-stringify pinned hash in tests/amp-canonical-json.test.ts.
    const sig = signToken({ action: 'download', att_id: 'att_pinned', exp: 1700000000000 })
    expect(sig).toBe('ABOQsz_f6gBFFt-RVuT9vJkP0Ym2WFqOuB7Yz9yrbXg')
  })

  it('buildSignedUrl includes sig + exp query params', () => {
    const url = buildSignedUrl('http://example.com:23000', 'download', 'att_abc', '2026-05-12T00:00:00.000Z')
    expect(url).toContain('http://example.com:23000/api/v1/attachments/att_abc/download')
    expect(url).toMatch(/[?&]sig=/)
    expect(url).toMatch(/[?&]exp=\d+/)
  })

  it('verifySignedRequest accepts valid signed URL', () => {
    const exp = Date.now() + 60_000
    const sig = signToken({ action: 'download', att_id: 'att_abc', exp })
    expect(verifySignedRequest('download', 'att_abc', sig, String(exp))).toBeNull()
  })

  it('verifySignedRequest rejects expired URL', () => {
    const exp = Date.now() - 1000
    const sig = signToken({ action: 'download', att_id: 'att_abc', exp })
    expect(verifySignedRequest('download', 'att_abc', sig, String(exp))).toMatch(/expired/)
  })

  it('verifySignedRequest rejects missing sig or exp', () => {
    expect(verifySignedRequest('download', 'att_abc', null, '123')).toMatch(/missing/)
    expect(verifySignedRequest('download', 'att_abc', 'sig', null)).toMatch(/missing/)
  })

  it('verifySignedRequest rejects tampered sig', () => {
    const exp = Date.now() + 60_000
    const sig = signToken({ action: 'download', att_id: 'att_abc', exp })
    expect(verifySignedRequest('download', 'att_other', sig, String(exp))).toMatch(/verification failed/)
  })
})

describe('attachment-storage', () => {
  // Use a per-test temp HOME so the storage primitive does not pollute the
  // real ~/.aimaestro/attachments dir.
  let tmpHome: string
  beforeEach(() => {
    tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-attach-test-'))
    process.env.HOME = tmpHome
  })

  it('generateAttachmentId produces unique att_ prefixed ids', () => {
    const a = generateAttachmentId()
    const b = generateAttachmentId()
    // Format: att_<ms-timestamp>_<16 hex chars> — three-part shape pinned by
    // amp-helper.sh:validate_attachment_id (kanban 094594ac). A bare two-part
    // shape silently breaks cross-host attachments via local-only fallback.
    expect(a).toMatch(/^att_\d+_[a-f0-9]{16}$/)
    expect(b).toMatch(/^att_\d+_[a-f0-9]{16}$/)
    expect(a).not.toBe(b)
  })

  it('generateAttachmentId matches amp-helper.sh:validate_attachment_id regex', () => {
    // Pinned regex from ~/.local/bin/amp-helper.sh:1478:
    //   ^att[_-][0-9]+[_-][a-zA-Z0-9]+$
    // Must match or amp-send falls back to local-only delivery (kanban 094594ac).
    const ampClientRegex = /^att[_-][0-9]+[_-][a-zA-Z0-9]+$/
    for (let i = 0; i < 10; i++) {
      const id = generateAttachmentId()
      expect(id).toMatch(ampClientRegex)
    }
  })

  it('writeMeta + readMeta round-trips', () => {
    const id = generateAttachmentId()
    const meta: AttachmentMeta = {
      id,
      filename: 'test.png',
      content_type: 'image/png',
      size: 100,
      digest: null,
      scan_status: 'pending',
      uploaded_at: null,
      expires_at: defaultExpiresAt(),
      initiated_at: new Date().toISOString(),
      initiator_agent_id: 'agent-uuid-1',
    }
    writeMeta(meta)
    const round = readMeta(id)
    expect(round).toEqual(meta)
  })

  it('readMeta returns null for unknown id', () => {
    expect(readMeta('att_does_not_exist')).toBeNull()
  })

  it('writeBlob + readBlob + digestBlob round-trip', () => {
    const id = generateAttachmentId()
    const data = Buffer.from('hello world')
    writeBlob(id, data)
    expect(readBlob(id)?.toString()).toBe('hello world')
    expect(blobSize(id)).toBe(11)
    const expected = crypto.createHash('sha256').update(data).digest('hex')
    expect(digestBlob(id)).toBe(expected)
  })

  it('defaultExpiresAt returns ISO 7+ days in the future', () => {
    const now = new Date('2026-05-05T00:00:00.000Z')
    expect(defaultExpiresAt(now)).toBe('2026-05-12T00:00:00.000Z')
  })

  it('attachmentDir + writeMeta create dir under HOME-relative path', () => {
    const id = generateAttachmentId()
    writeMeta({
      id, filename: 'x', content_type: 'application/octet-stream', size: 1,
      digest: null, scan_status: 'pending', uploaded_at: null,
      expires_at: defaultExpiresAt(), initiated_at: new Date().toISOString(),
      initiator_agent_id: 'agent-uuid-1',
    })
    expect(attachmentDir(id).startsWith(tmpHome)).toBe(true)
    expect(fs.existsSync(path.join(attachmentDir(id), 'meta.json'))).toBe(true)
  })
})
