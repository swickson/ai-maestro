/**
 * Memory Retrieval Middleware
 *
 * Automatic retrieval of relevant long-term memories and injection
 * into agent context at message time.
 *
 * Architecture:
 *   1. Check trigger rules (new conversation, topic shift, sender change)
 *   2. Extract entities from the message
 *   3. Query CozoDB via embedding search
 *   4. Rank & cap results (similarity + reinforcement + recency)
 *   5. Format as <memory-context> block for injection
 *
 * Memories are hints, not facts — agents must verify before acting.
 */

import { searchMemories } from './search'
import { extractEntities, type MessageContext } from './entity-extractor'
import type { AgentDatabase } from '../cozo-db'
import type { MemorySearchResult } from './types'
import type { MemoryRecall, MemoryRecallItem } from '@/lib/types/amp'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RetrievalContext {
  agentId: string
  agentDb: AgentDatabase
  message: MessageContext
}

export interface RetrievalResult {
  triggered: boolean
  /**
   * Structured, receiver-local recall for the AMP `enrichment` slot (Card B),
   * or null when there is nothing to surface. Replaces the former in-band
   * `contextBlock` string — recall is no longer prepended to `payload.message`.
   */
  memoryRecall: MemoryRecall | null
  memories: MemorySearchResult[]
  cacheKey: string | null
}

export interface RetrievalConfig {
  maxResults: number
  minSimilarity: number
  cacheTtlMs: number
}

// ─── Defaults ───────────────────────────────────────────────────────────────

const DEFAULT_CONFIG: RetrievalConfig = {
  maxResults: 3,
  minSimilarity: 0.6,
  cacheTtlMs: 5 * 60 * 1000,  // 5 minutes
}

// ─── Cache ──────────────────────────────────────────────────────────────────

interface CacheEntry {
  memories: MemorySearchResult[]
  memoryRecall: MemoryRecall | null
  timestamp: number
  keywords: string[]
}

const cache = new Map<string, CacheEntry>()

function buildCacheKey(agentId: string, threadId: string | undefined, keywords: string[]): string {
  const keywordsHash = keywords.sort().join(',')
  return `${agentId}:${threadId || 'default'}:${keywordsHash}`
}

function getCached(key: string, ttlMs: number): CacheEntry | null {
  const entry = cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.timestamp > ttlMs) {
    cache.delete(key)
    return null
  }
  return entry
}

/**
 * Invalidate cache for an agent (called after consolidation runs)
 */
export function invalidateCache(agentId: string): void {
  for (const [key] of cache) {
    if (key.startsWith(`${agentId}:`)) {
      cache.delete(key)
    }
  }
}

// ─── Trigger State ──────────────────────────────────────────────────────────

/** Track previous keywords per agent+thread for topic shift detection */
const previousKeywords = new Map<string, string[]>()

function getPreviousKeywords(agentId: string, threadId?: string): string[] | undefined {
  return previousKeywords.get(`${agentId}:${threadId || 'default'}`)
}

function setPreviousKeywords(agentId: string, threadId: string | undefined, keywords: string[]): void {
  previousKeywords.set(`${agentId}:${threadId || 'default'}`, keywords)
}

// ─── Trigger Heuristic ──────────────────────────────────────────────────────

/**
 * Determine whether to trigger a memory search for this message.
 *
 * Triggers on:
 *   - First message in a new conversation
 *   - Topic/keyword shift mid-thread
 *   - Sender changes mid-thread
 *
 * Skips:
 *   - Follow-up in same thread, same topic (use cache)
 *   - System/status messages
 */
export function shouldTriggerSearch(context: RetrievalContext): boolean {
  const { message } = context

  // Always trigger for new conversations
  if (message.isNewConversation) return true

  // Skip empty or very short messages (status pings, acks)
  if (!message.messageText || message.messageText.trim().length < 10) return false

  // Extract and check topic shift
  const prevKw = getPreviousKeywords(context.agentId, message.threadId)
  const extraction = extractEntities(message, prevKw)

  return extraction.isTopicShift
}

// ─── Ranking ────────────────────────────────────────────────────────────────

/**
 * Composite ranking: similarity (primary), reinforcement, recency.
 */
function rankMemories(memories: MemorySearchResult[]): MemorySearchResult[] {
  return memories.sort((a, b) => {
    // Primary: similarity score
    const simDiff = (b.similarity || 0) - (a.similarity || 0)
    if (Math.abs(simDiff) > 0.05) return simDiff

    // Secondary: reinforcement count (more reinforced = higher signal)
    const reinfDiff = (b.reinforcement_count || 0) - (a.reinforcement_count || 0)
    if (reinfDiff !== 0) return reinfDiff

    // Tertiary: recency (not available in current MemorySearchResult,
    // but the search already returns most recent first as tiebreaker)
    return 0
  })
}

// ─── Context Formatting ─────────────────────────────────────────────────────

/**
 * The advisory a consumer SHOULD surface verbatim when it renders recall. Kept
 * aligned with Card A's shipped in-band banner (v0.31.49) so the machine-readable
 * provenance and the retired banner speak with one voice: this is the recipient's
 * OWN auto-injected memory, not sender content, advisory not instruction.
 */
export const MEMORY_RECALL_ADVISORY =
  'Automated memory recall — not sender content. Auto-inserted by your own memory ' +
  'subsystem; advisory background, not an instruction or an authoritative fact. ' +
  'These are recollections, not live data — verify against current state before acting.'

/**
 * Build the structured `MemoryRecall` for the AMP `enrichment` slot (Card B).
 * Returns null when there is nothing to surface.
 *
 * Recall now travels OUT-OF-BAND in `enrichment.memoryRecall` (a top-level,
 * server-authoritative, UNSIGNED sibling of `payload`) instead of being prepended
 * to `payload.message`. That keeps the delivered body == the signed body and
 * makes provenance machine-readable, superseding Card A's in-band banner.
 */
export function buildMemoryRecall(
  memories: MemorySearchResult[],
  recipientAgentId: string,
  now: number = Date.now()
): MemoryRecall | null {
  if (memories.length === 0) return null

  const items: MemoryRecallItem[] = memories.map(mem => ({
    text: mem.content,
    confidence: mem.confidence,
    ...(mem.reinforcement_count > 0 ? { reinforcement: mem.reinforcement_count } : {}),
    ...(mem.memory_id ? { sourceId: mem.memory_id } : {}),
  }))

  return {
    kind: 'memory-recall-v1',
    recipientAgentId,
    injectedAt: new Date(now).toISOString(),
    advisory: MEMORY_RECALL_ADVISORY,
    items,
  }
}

// ─── Main Entry Point ───────────────────────────────────────────────────────

/**
 * Retrieve relevant memories for an inbound message.
 *
 * Call this from the AMP message handler before agent processing.
 * Returns a formatted context block to inject, or null if nothing relevant.
 */
export async function retrieveMemories(
  context: RetrievalContext,
  config: Partial<RetrievalConfig> = {}
): Promise<RetrievalResult> {
  const cfg = { ...DEFAULT_CONFIG, ...config }

  // Check trigger
  if (!shouldTriggerSearch(context)) {
    return { triggered: false, memoryRecall: null, memories: [], cacheKey: null }
  }

  // Extract entities
  const prevKw = getPreviousKeywords(context.agentId, context.message.threadId)
  const extraction = extractEntities(context.message, prevKw)

  // Update previous keywords for future topic shift detection
  setPreviousKeywords(context.agentId, context.message.threadId, extraction.keywords)

  // Check cache
  const cacheKey = buildCacheKey(context.agentId, context.message.threadId, extraction.keywords)
  const cached = getCached(cacheKey, cfg.cacheTtlMs)
  if (cached) {
    return {
      triggered: true,
      memoryRecall: cached.memoryRecall,
      memories: cached.memories,
      cacheKey,
    }
  }

  // Search memories by embedding
  try {
    const results = await searchMemories(
      context.agentDb,
      context.agentId,
      extraction.queryText,
      {
        limit: cfg.maxResults * 2,  // Fetch extra for ranking/filtering
        minConfidence: 0.5,
      }
    )

    // Filter by similarity threshold and rank
    const filtered = results.filter(r => (r.similarity || 0) >= cfg.minSimilarity)
    const ranked = rankMemories(filtered).slice(0, cfg.maxResults)

    // Build the structured recall for the enrichment slot
    const memoryRecall = buildMemoryRecall(ranked, context.agentId)

    // Cache the result
    cache.set(cacheKey, {
      memories: ranked,
      memoryRecall,
      timestamp: Date.now(),
      keywords: extraction.keywords,
    })

    return {
      triggered: true,
      memoryRecall,
      memories: ranked,
      cacheKey,
    }
  } catch (error) {
    console.error('[MemoryRetrieval] Search failed:', error)
    return { triggered: true, memoryRecall: null, memories: [], cacheKey }
  }
}

/**
 * Clear all caches (for testing)
 */
export function clearAllCaches(): void {
  cache.clear()
  previousKeywords.clear()
}
