/**
 * AMP attachment MIME sniff + executable rejection.
 *
 * Server-authoritative per spec: client may declare a content_type at upload
 * initiation, but the server MUST verify on confirm. Reject executables
 * regardless of client-declared type.
 *
 * Magic-byte detection covers the major executable formats. Not exhaustive
 * (intentional — full mime detection is out of scope per #48 issue body),
 * just enough to block the obvious dangerous shapes.
 */

import { Buffer } from 'buffer'

export interface SniffResult {
  detected_type: string
  is_executable: boolean
  // True iff a magic-byte signature actually matched. False means
  // detected_type is a fallback to the declared value (or octet-stream) — the
  // primary-type cross-check in §5 step 3 cannot use detected_type then,
  // because it merely echoes the declaration.
  matched_magic: boolean
}

interface MagicSig {
  prefix: number[]
  type: string
  exe: boolean
}

const MAGIC_SIGNATURES: MagicSig[] = [
  // Windows PE / MS-DOS executable
  { prefix: [0x4d, 0x5a], type: 'application/x-msdownload', exe: true },
  // Linux ELF
  { prefix: [0x7f, 0x45, 0x4c, 0x46], type: 'application/x-executable', exe: true },
  // Mach-O 64-bit (LE)
  { prefix: [0xcf, 0xfa, 0xed, 0xfe], type: 'application/x-mach-binary', exe: true },
  // Mach-O 32-bit (LE)
  { prefix: [0xce, 0xfa, 0xed, 0xfe], type: 'application/x-mach-binary', exe: true },
  // Mach-O Universal (FAT)
  { prefix: [0xca, 0xfe, 0xba, 0xbe], type: 'application/x-mach-binary', exe: true },
  // Java class
  { prefix: [0xca, 0xfe, 0xba, 0xbe], type: 'application/java-vm', exe: true },
  // Shebang scripts (#!) — also flagged as executable, common shell-injection vector
  { prefix: [0x23, 0x21], type: 'application/x-sh', exe: true },
  // Common safe formats — sniffed for type accuracy, not blocked
  { prefix: [0x89, 0x50, 0x4e, 0x47], type: 'image/png', exe: false },
  { prefix: [0xff, 0xd8, 0xff], type: 'image/jpeg', exe: false },
  { prefix: [0x47, 0x49, 0x46, 0x38], type: 'image/gif', exe: false },
  { prefix: [0x25, 0x50, 0x44, 0x46], type: 'application/pdf', exe: false },
  { prefix: [0x50, 0x4b, 0x03, 0x04], type: 'application/zip', exe: false },
  { prefix: [0x1f, 0x8b], type: 'application/gzip', exe: false },
]

export function sniff(data: Buffer, declared: string | null = null): SniffResult {
  for (const sig of MAGIC_SIGNATURES) {
    if (data.length < sig.prefix.length) continue
    let match = true
    for (let i = 0; i < sig.prefix.length; i++) {
      if (data[i] !== sig.prefix[i]) { match = false; break }
    }
    if (match) {
      return { detected_type: sig.type, is_executable: sig.exe, matched_magic: true }
    }
  }
  // Fall back to declared (if any) or generic octet-stream. Never trust
  // declared type for the executable decision — only sniff result counts.
  return {
    detected_type: declared || 'application/octet-stream',
    is_executable: false,
    matched_magic: false,
  }
}

/**
 * Spec v0.1.2 §5 step 3: "Verify that the file's magic bytes match the declared
 * `content_type` at the primary type level ... Files declared as
 * `application/octet-stream` are exempt. Empty files (0 bytes) are exempt."
 *
 * Primary type = the part before `/` (e.g. `image` in `image/png`).
 *
 * `declared` null/empty is treated as octet-stream (the upload route defaults
 * missing content_type that way). `byteLength` 0 short-circuits to match per
 * spec exempt clause; in practice our PUT path already rejects empty bodies so
 * this is belt-and-braces.
 */
export function primaryTypeMatches(
  declared: string | null,
  sniffed: SniffResult,
  byteLength: number,
): boolean {
  if (byteLength === 0) return true
  const d = (declared || 'application/octet-stream').toLowerCase()
  if (d === 'application/octet-stream') return true
  if (!sniffed.matched_magic) return true
  const declaredPrimary = d.split('/')[0]
  const detectedPrimary = sniffed.detected_type.toLowerCase().split('/')[0]
  return declaredPrimary === detectedPrimary
}
