/**
 * Shared chat-transcript file resolution.
 *
 * Both the live WebSocket chat (server.mjs) and the REST chat path
 * (services/agents-chat-service.ts) need to find "the agent's current
 * conversation .jsonl". Historically each picked the **newest-mtime** file in
 * the project dir with no content check — so a tiny title-only stub could
 * shadow the real transcript, leaving the chat empty / non-refreshing / stuck
 * on "Sending…" (issue #195). This module is the single source of truth for
 * that selection so the two paths can't drift again.
 *
 * Selection order:
 *  1. The hook's `transcriptPath` for the CURRENT session, when it exists on
 *     disk and lives in the resolved conversation dir — authoritative.
 *  2. If that path is known but NOT yet on disk (e.g. deferred transcript flush
 *     in a long session, issue #196): report `pending` — callers show an honest
 *     "no history yet" rather than falling back to a stale/stub file.
 *  3. Otherwise scan the dir and pick the newest **substantive** file, rejecting
 *     title-only stubs by content.
 */
import fs from 'fs'
import path from 'path'
import { resolveConversationDir, resolveChatStateFile, type AgentPathInput } from '@/lib/agent-paths'

export interface TranscriptResolution {
  /** Resolved conversation directory (null if it doesn't exist / can't resolve). */
  dir: string | null
  /** Chosen transcript file path (or the known-but-absent current path when pending). */
  path: string | null
  /** mtime of the chosen file, or null when none/pending. */
  mtime: Date | null
  /** True when a real, on-disk transcript was selected. */
  exists: boolean
  /** True when the current session's transcript is known but not yet on disk. */
  pending: boolean
}

const EMPTY: TranscriptResolution = { dir: null, path: null, mtime: null, exists: false, pending: false }

// Files at/under this size are checked for real content before being accepted.
// A title-only stub is ~117 bytes; any real conversation (even one exchange)
// is comfortably larger, so larger files are trusted without a read.
const STUB_MAX_BYTES = 4096

// Line types that carry NO conversation on their own — the title-only stub
// failure mode (#195) is a file containing only these. Everything else
// (claude user/assistant, tool results, summaries, and any gemini/codex/
// antigravity-shaped line) counts as real content.
const STUB_ONLY_LINE_TYPES = new Set(['ai-title'])

/**
 * Does the file contain at least one real content line (i.e. anything that
 * isn't purely a title marker)? Title-only files return false. Short-circuits
 * on the first real line. Format-agnostic: a parseable non-title line OR any
 * non-empty non-JSON line counts (covers gemini/codex/antigravity formats).
 */
function hasRealMessages(filePath: string): boolean {
  let content: string
  try {
    content = fs.readFileSync(filePath, 'utf-8')
  } catch {
    return false
  }
  for (const line of content.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const obj = JSON.parse(trimmed)
      // Any line that isn't purely a title marker is real content.
      if (!obj || typeof obj.type !== 'string' || !STUB_ONLY_LINE_TYPES.has(obj.type)) return true
    } catch {
      // Non-JSON but non-empty line — treat as real content.
      return true
    }
  }
  return false
}

/** A small file with no real messages is a stub; big files are trusted. */
function isStub(filePath: string, size: number): boolean {
  if (size > STUB_MAX_BYTES) return false
  return !hasRealMessages(filePath)
}

/**
 * Pure selection over a directory. Exported for unit testing.
 * @param dir conversation directory (must exist)
 * @param hookTranscriptPath the current session's transcript path from hook state, if any
 */
export function selectTranscriptFile(
  dir: string | null,
  hookTranscriptPath?: string | null
): TranscriptResolution {
  if (!dir || !fs.existsSync(dir)) return { ...EMPTY, dir: dir ?? null }

  // 1/2. Authoritative current-session path from the hook.
  if (hookTranscriptPath && path.resolve(path.dirname(hookTranscriptPath)) === path.resolve(dir)) {
    if (fs.existsSync(hookTranscriptPath)) {
      return { dir, path: hookTranscriptPath, mtime: fs.statSync(hookTranscriptPath).mtime, exists: true, pending: false }
    }
    // Known current transcript, not yet flushed — don't serve a stale stub.
    return { dir, path: hookTranscriptPath, mtime: null, exists: false, pending: true }
  }

  // 3. Newest substantive file (reject title-only stubs).
  const files = fs.readdirSync(dir)
    .filter(f => f.endsWith('.jsonl'))
    .map(f => {
      const p = path.join(dir, f)
      const st = fs.statSync(p)
      return { name: f, path: p, mtime: st.mtime, size: st.size }
    })
    .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())

  if (files.length === 0) return { ...EMPTY, dir }

  // Newest non-stub; if every file is a stub, fall back to newest (don't break
  // a genuinely tiny-but-real conversation).
  const pick = files.find(f => !isStub(f.path, f.size)) ?? files[0]
  return { dir, path: pick.path, mtime: pick.mtime, exists: true, pending: false }
}

/** Read the current session's transcriptPath from the agent's hook state. */
function readHookTranscriptPath(agent: AgentPathInput, hostHome?: string): string | null {
  try {
    const stateFile = resolveChatStateFile(agent, hostHome)
    if (!stateFile || !fs.existsSync(stateFile)) return null
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf-8'))
    return typeof state?.transcriptPath === 'string' ? state.transcriptPath : null
  } catch {
    return null
  }
}

/** Resolve the active transcript for an agent (live WS + REST share this). */
export function resolveActiveTranscript(agent: AgentPathInput, hostHome?: string): TranscriptResolution {
  const dir = resolveConversationDir(agent, hostHome)
  const hookPath = readHookTranscriptPath(agent, hostHome)
  return selectTranscriptFile(dir, hookPath)
}
