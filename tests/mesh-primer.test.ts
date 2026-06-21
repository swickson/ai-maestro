/**
 * Mesh-primer helpers (relocation of the primer out of the wake paste).
 */
import { describe, it, expect } from 'vitest'
import { MESH_PRIMER, loadMeshPrimer, meshAwarenessBlock, primerOnlyInstructions } from '@/lib/mesh-primer'
import type { Agent } from '@/types/agent'

const agent = (meshAware?: boolean) => ({ id: 'x', name: 'x', meshAware } as unknown as Agent)

describe('loadMeshPrimer', () => {
  it('returns the primer when meshAware is unset (default ON)', () => {
    expect(loadMeshPrimer(agent(undefined))).toBe(MESH_PRIMER)
  })
  it('returns the primer when meshAware is true', () => {
    expect(loadMeshPrimer(agent(true))).toBe(MESH_PRIMER)
  })
  it('returns empty string when meshAware === false', () => {
    expect(loadMeshPrimer(agent(false))).toBe('')
  })
})

describe('meshAwarenessBlock (append form)', () => {
  it('is a delimited heading block leading with blank lines and ending in a newline', () => {
    const block = meshAwarenessBlock()
    expect(block.startsWith('\n\n## Mesh Awareness')).toBe(true)
    expect(block.endsWith('\n')).toBe(true)
    expect(block).toContain(MESH_PRIMER)
  })
})

describe('primerOnlyInstructions (standalone form)', () => {
  it('is a top-level document leading with an H1 heading', () => {
    const doc = primerOnlyInstructions()
    expect(doc.startsWith('# Mesh Awareness')).toBe(true)
    expect(doc).toContain(MESH_PRIMER)
  })
})

describe('MESH_PRIMER content (amp CLI surface smoke check)', () => {
  it('references the amp-send/amp-primer surface so it stays in sync with the CLI', () => {
    expect(MESH_PRIMER).toContain('amp-send')
    expect(MESH_PRIMER).toContain('amp-primer')
    expect(MESH_PRIMER).toContain('--priority')
  })
})
