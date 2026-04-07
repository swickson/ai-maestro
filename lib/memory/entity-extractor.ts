/**
 * Entity Extractor — keyword and named entity extraction for memory retrieval
 *
 * Extracts search terms from inbound messages + AMP envelope metadata:
 *   1. Named entities — agent names, person names, project names
 *   2. Keywords — nouns and noun phrases (lightweight, no NLP pipeline)
 *   3. Sender context — who sent the message
 *   4. Thread context — original topic if this is a reply
 */

import { loadAgents } from '@/lib/agent-registry'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MessageContext {
  messageText: string
  senderId?: string
  senderName?: string
  senderPlatform?: string
  threadId?: string
  isNewConversation?: boolean
  topicHints?: string[]
}

export interface ExtractionResult {
  /** Combined query text for embedding search */
  queryText: string
  /** Extracted keywords (lowercased, deduplicated) */
  keywords: string[]
  /** Recognized named entities (agent names, user aliases) */
  namedEntities: string[]
  /** Whether this message likely represents a topic shift */
  isTopicShift: boolean
}

// ─── Stop Words ─────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  'because', 'but', 'and', 'or', 'if', 'while', 'about', 'up', 'it',
  'its', 'i', 'me', 'my', 'we', 'our', 'you', 'your', 'he', 'him',
  'his', 'she', 'her', 'they', 'them', 'their', 'this', 'that', 'these',
  'those', 'what', 'which', 'who', 'whom', 'also', 'get', 'got', 'like',
  'make', 'let', 'say', 'said', 'think', 'know', 'see', 'want', 'tell',
  'give', 'take', 'come', 'go', 'look', 'use', 'find', 'way', 'thing',
])

// ─── Known Entity Cache ─────────────────────────────────────────────────────

let _knownNames: Set<string> | null = null
let _knownNamesCacheTime = 0
const CACHE_TTL_MS = 60_000 // Refresh known names every 60s

/**
 * Build a set of known agent names and labels for entity matching.
 * Lazily cached with TTL.
 */
function getKnownNames(): Set<string> {
  const now = Date.now()
  if (_knownNames && now - _knownNamesCacheTime < CACHE_TTL_MS) {
    return _knownNames
  }

  const names = new Set<string>()

  try {
    const agents = loadAgents()
    for (const agent of agents) {
      if (agent.name) names.add(agent.name.toLowerCase())
      if (agent.label) names.add(agent.label.toLowerCase())
    }
  } catch {
    // Agent registry may not be available in all contexts
  }

  // User directory lookup is deferred to Phase 2 (gateway integration)
  // to avoid a circular dependency at this layer.

  _knownNames = names
  _knownNamesCacheTime = now
  return names
}

// ─── Extraction ─────────────────────────────────────────────────────────────

/**
 * Extract keywords from text.
 * Simple approach: tokenize, remove stop words, keep words 3+ chars.
 */
export function extractKeywords(text: string): string[] {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOP_WORDS.has(t))

  return [...new Set(tokens)]
}

/**
 * Extract named entities by matching against known agent/user names.
 */
export function extractNamedEntities(text: string): string[] {
  const knownNames = getKnownNames()
  const normalized = text.toLowerCase()
  const found: string[] = []

  for (const name of knownNames) {
    // Match whole word boundaries
    const pattern = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`)
    if (pattern.test(normalized)) {
      found.push(name)
    }
  }

  return found
}

/**
 * Detect topic shift by comparing keyword overlap between two messages.
 * If fewer than 30% of keywords overlap, treat as a topic shift.
 */
export function detectTopicShift(currentKeywords: string[], previousKeywords: string[]): boolean {
  if (previousKeywords.length === 0) return true  // No previous = new topic

  const prevSet = new Set(previousKeywords)
  const overlap = currentKeywords.filter(k => prevSet.has(k))
  const overlapRatio = overlap.length / Math.max(previousKeywords.length, 1)

  return overlapRatio < 0.3
}

/**
 * Full entity extraction from a message context.
 * Combines keywords, named entities, topic hints, and sender context
 * into a search-ready result.
 */
export function extractEntities(
  context: MessageContext,
  previousKeywords?: string[]
): ExtractionResult {
  const keywords = extractKeywords(context.messageText)
  const namedEntities = extractNamedEntities(context.messageText)

  // Add topic hints from gateway if available
  if (context.topicHints) {
    for (const hint of context.topicHints) {
      const hintLower = hint.toLowerCase()
      if (!keywords.includes(hintLower)) {
        keywords.push(hintLower)
      }
    }
  }

  // Detect topic shift
  const isTopicShift = previousKeywords
    ? detectTopicShift(keywords, previousKeywords)
    : true

  // Build query text: original message + named entities for emphasis
  const queryParts = [context.messageText]
  if (namedEntities.length > 0) {
    queryParts.push(namedEntities.join(' '))
  }
  if (context.senderName) {
    queryParts.push(context.senderName)
  }

  return {
    queryText: queryParts.join(' '),
    keywords,
    namedEntities,
    isTopicShift,
  }
}

/**
 * Clear the known names cache (for testing)
 */
export function clearEntityCache(): void {
  _knownNames = null
  _knownNamesCacheTime = 0
}
