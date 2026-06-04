/**
 * Entity Extractor — Unit Tests
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  extractKeywords,
  extractNamedEntities,
  detectTopicShift,
  extractEntities,
  clearEntityCache,
} from '@/lib/memory/entity-extractor'

// Mock agent registry
import { vi } from 'vitest'
vi.mock('@/lib/agent-registry', () => ({
  loadAgents: vi.fn(() => [
    { id: '1', name: 'dev-aimaestro-admin', label: 'Kai' },
    { id: '2', name: 'dev-aimaestro-holmes', label: 'Watson' },
    { id: '3', name: 'dev-aimaestro-bananajr', label: 'CelestIA' },
  ]),
}))

describe('entity-extractor', () => {
  beforeEach(() => {
    clearEntityCache()
  })

  describe('extractKeywords', () => {
    it('extracts meaningful words, removes stop words', () => {
      const keywords = extractKeywords('The database migration failed on production')
      expect(keywords).toContain('database')
      expect(keywords).toContain('migration')
      expect(keywords).toContain('failed')
      expect(keywords).toContain('production')
      expect(keywords).not.toContain('the')
      expect(keywords).not.toContain('on')
    })

    it('filters short words', () => {
      const keywords = extractKeywords('I am ok but not great')
      expect(keywords).not.toContain('am')
      expect(keywords).not.toContain('ok')
      expect(keywords).toContain('great')
    })

    it('deduplicates', () => {
      const keywords = extractKeywords('test test test different')
      expect(keywords.filter(k => k === 'test')).toHaveLength(1)
    })

    it('lowercases everything', () => {
      const keywords = extractKeywords('CozoDB PostgreSQL Redis')
      expect(keywords).toContain('cozodb')
      expect(keywords).toContain('postgresql')
      expect(keywords).toContain('redis')
    })
  })

  describe('extractNamedEntities', () => {
    it('finds known agent names', () => {
      const entities = extractNamedEntities('Ask Kai about the deployment')
      expect(entities).toContain('kai')
    })

    it('finds agent labels', () => {
      const entities = extractNamedEntities('Watson should review the PR')
      expect(entities).toContain('watson')
    })

    it('finds full agent names', () => {
      const entities = extractNamedEntities('Check with dev-aimaestro-holmes')
      expect(entities).toContain('dev-aimaestro-holmes')
    })

    it('returns empty for no matches', () => {
      const entities = extractNamedEntities('Build the feature')
      expect(entities).toHaveLength(0)
    })
  })

  describe('detectTopicShift', () => {
    it('detects shift when no previous keywords', () => {
      expect(detectTopicShift(['database', 'migration'], [])).toBe(true)
    })

    it('detects shift when keywords are very different', () => {
      const previous = ['database', 'migration', 'postgres']
      const current = ['frontend', 'react', 'component']
      expect(detectTopicShift(current, previous)).toBe(true)
    })

    it('no shift when keywords overlap significantly', () => {
      const previous = ['database', 'migration', 'schema']
      const current = ['database', 'migration', 'rollback']
      expect(detectTopicShift(current, previous)).toBe(false)
    })
  })

  describe('extractEntities', () => {
    it('combines keywords, entities, and topic hints', () => {
      const result = extractEntities({
        messageText: 'Kai needs to fix the CozoDB query performance',
        topicHints: ['performance'],
      })

      expect(result.keywords).toContain('cozodb')
      expect(result.keywords).toContain('query')
      expect(result.keywords).toContain('performance')
      expect(result.namedEntities).toContain('kai')
      expect(result.queryText).toContain('Kai needs to fix')
    })

    it('detects topic shift from previous keywords', () => {
      const previous = ['deployment', 'docker', 'container']
      const result = extractEntities(
        { messageText: 'What about the React component styling?' },
        previous
      )
      expect(result.isTopicShift).toBe(true)
    })

    it('detects no topic shift for similar content', () => {
      const previous = ['react', 'component', 'styling']
      const result = extractEntities(
        { messageText: 'The React component styling needs updating' },
        previous
      )
      expect(result.isTopicShift).toBe(false)
    })
  })
})
