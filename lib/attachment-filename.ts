/**
 * Filename sanitization for AMP attachments — server-authoritative per spec.
 *
 * Allowed: [a-zA-Z0-9._-] only. Reserved OS names blocked. Double-encoded
 * separators rejected. Server stores the sanitized form; client-declared
 * name is advisory.
 */

const ALLOWED_RE = /^[A-Za-z0-9._-]+$/

// Windows reserved device names (also blocked on Linux for cross-platform safety)
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
])

export function isValid(name: string): boolean {
  if (!name || name.length === 0) return false
  if (name.length > 255) return false
  if (name === '.' || name === '..') return false
  if (name.includes('\0')) return false
  // Reject double-encoded separators (e.g. %2F that decoded to /)
  if (/%2[Ff]|%5[Cc]/.test(name)) return false
  if (!ALLOWED_RE.test(name)) return false
  // Strip extension for reserved-name check (CON.txt is also blocked on Windows)
  const base = name.replace(/\..*$/, '').toUpperCase()
  if (RESERVED_NAMES.has(base)) return false
  return true
}

/**
 * Coerce a filename to the sanitized form. Replaces disallowed characters
 * with `_`, truncates to 255, strips leading/trailing dots. Returns null
 * if the result would be empty or reserved.
 */
export function sanitize(name: string): string | null {
  let s = name.replace(/[^A-Za-z0-9._-]/g, '_')
  // Strip leading/trailing dots/dashes (cosmetic + avoids the ./.. case)
  s = s.replace(/^[.\-]+/, '').replace(/[.\-]+$/, '')
  if (s.length > 255) s = s.substring(0, 255)
  if (!s) return null
  if (!isValid(s)) return null
  return s
}
