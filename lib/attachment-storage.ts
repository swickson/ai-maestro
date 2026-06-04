/**
 * AMP attachment storage primitive — filesystem layout under
 * `~/.aimaestro/attachments/<att_id>/`. Each attachment occupies a directory
 * with `meta.json` (immutable post-confirm) + `blob` (the raw bytes).
 *
 * Single-use att_id semantics: confirm transitions `meta.json` from
 * pending → clean (or rejected); subsequent confirm calls are no-ops on a
 * confirmed attachment. The att_id itself is never reused.
 *
 * Mirrors `~/.aimaestro/messages/` layout (kanban #48 spec).
 */

import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import * as crypto from 'crypto'

export interface AttachmentMeta {
  id: string
  filename: string
  content_type: string
  size: number
  digest: string | null // populated after upload PUT
  // `basic_clean` = passed all required MUSTs (size/digest/exec/type-match) but
  // no AV / injection-pattern scan was run (spec v0.1.2 §5, table line 429).
  // We don't run AV — terminal success state is `basic_clean`, not `clean`.
  scan_status: 'pending' | 'clean' | 'basic_clean' | 'suspicious' | 'rejected'
  uploaded_at: string | null // populated after confirm
  expires_at: string
  // Audit fields
  initiated_at: string
  initiator_agent_id: string
}

function attachRoot(): string {
  // Lazy-resolve from os.homedir() so tests can override HOME at beforeEach.
  return path.join(os.homedir(), '.aimaestro', 'attachments')
}

export function ensureRoot(): void {
  const root = attachRoot()
  fs.mkdirSync(root, { recursive: true, mode: 0o700 })
  // mkdirSync `mode` is no-op for already-existing dirs; an explicit chmod
  // tightens an existing root that was created with looser perms (spec v0.1.2
  // §10 requires 0700 owner-only on attachment storage).
  try {
    fs.chmodSync(root, 0o700)
  } catch {
    // chmod can fail on filesystems that don't honor POSIX perms (e.g. some
    // Windows / network mounts). The mkdir mode is the best-effort path on
    // those; silent fallback keeps Linux/macOS behavior strict.
  }
}

export function attachmentDir(id: string): string {
  return path.join(attachRoot(), id)
}

export function generateAttachmentId(): string {
  // Format: `att_<ms-timestamp>_<8-byte hex>`. Three-part shape required by
  // `~/.local/bin/amp-helper.sh:validate_attachment_id` which matches
  // `^att[_-][0-9]+[_-][a-zA-Z0-9]+$` — designed against the legacy
  // client-generated id format and shipped to operators via the AMP CLI
  // package. A bare `att_<32-hex>` form (one separator) is rejected by that
  // regex and silently falls back to client-generated ids + local-only
  // delivery, breaking cross-host attachments end-to-end despite the server
  // endpoints working under direct probe (kanban 094594ac, KAI empirical
  // 2026-05-06 post-PR-#119-merge).
  //
  // Bonus property: monotonic timestamp prefix sorts ids by creation time,
  // useful for debugging + log-grep. 8 bytes random / 16 hex chars provides
  // sufficient entropy against collisions within the same millisecond.
  return `att_${Date.now()}_${crypto.randomBytes(8).toString('hex')}`
}

export function writeMeta(meta: AttachmentMeta): void {
  ensureRoot()
  const dir = attachmentDir(meta.id)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const metaPath = path.join(dir, 'meta.json')
  fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 })
}

export function readMeta(id: string): AttachmentMeta | null {
  try {
    const metaPath = path.join(attachmentDir(id), 'meta.json')
    return JSON.parse(fs.readFileSync(metaPath, 'utf-8')) as AttachmentMeta
  } catch {
    return null
  }
}

export function blobPath(id: string): string {
  return path.join(attachmentDir(id), 'blob')
}

export function writeBlob(id: string, data: Buffer): void {
  ensureRoot()
  const dir = attachmentDir(id)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  fs.writeFileSync(blobPath(id), data, { mode: 0o600 })
}

export function readBlob(id: string): Buffer | null {
  try {
    return fs.readFileSync(blobPath(id))
  } catch {
    return null
  }
}

export function hasBlob(id: string): boolean {
  try {
    return fs.statSync(blobPath(id)).size > 0
  } catch {
    return false
  }
}

export function blobSize(id: string): number {
  try {
    return fs.statSync(blobPath(id)).size
  } catch {
    return 0
  }
}

export function digestBlob(id: string): string | null {
  try {
    const data = readBlob(id)
    if (!data) return null
    return crypto.createHash('sha256').update(data).digest('hex')
  } catch {
    return null
  }
}

export const DEFAULT_EXPIRES_DAYS = 7

export function defaultExpiresAt(now: Date = new Date()): string {
  const t = new Date(now.getTime() + DEFAULT_EXPIRES_DAYS * 24 * 60 * 60 * 1000)
  return t.toISOString()
}
