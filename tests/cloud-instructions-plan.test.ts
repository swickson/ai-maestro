/**
 * planCloudInstructions must predict EXACTLY what provisionCloudInstructions
 * does, per branch — the reprovision-sweep dry-run prints the plan, so a
 * plan!=effect divergence would mislead the operator (the #265 dry-run bug:
 * it reported "already-present" while --apply actually re-seeds + rewrites).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { provisionCloudInstructions, planCloudInstructions } from '@/lib/cloud-instructions'
import { MESH_PRIMER } from '@/lib/mesh-primer'

let HOME: string
const AID = 'plan-test-agent'
const instrPath = () => path.join(HOME, '.aimaestro', 'agents', AID, 'instructions.md')
const SRC_BODY = '# Engineer_INSTRUCTIONS.md\nsource body content'

beforeEach(() => {
  HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'plan-test-'))
})
afterEach(() => {
  fs.rmSync(HOME, { recursive: true, force: true })
})

function srcPath(exists: boolean): string {
  const p = path.join(HOME, 'source_INSTRUCTIONS.md')
  if (exists) fs.writeFileSync(p, SRC_BODY)
  return p
}
function seedExisting(content: string) {
  const dir = path.dirname(instrPath())
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(instrPath(), content)
}
const has = () => fs.existsSync(instrPath()) && fs.readFileSync(instrPath(), 'utf8').includes(MESH_PRIMER)

// Each case: set up state → compute plan → run provision → assert effect matches plan.
const cases = [
  { name: 'source present + meshAware ON → re-seed + primer (write)',
    source: true, existing: null as string | null, meshAware: undefined,
    expectWillWrite: true, expectPrimerAfter: true },
  { name: 'source present + meshAware OFF → re-seed, no primer (write)',
    source: true, existing: null, meshAware: false,
    expectWillWrite: true, expectPrimerAfter: false },
  { name: 'source absent + existing copy w/o primer + ON → backfill (write)',
    source: false, existing: '# Pre-relocation\nlegacy', meshAware: undefined,
    expectWillWrite: true, expectPrimerAfter: true },
  { name: 'source absent + existing copy WITH primer + ON → no-op',
    source: false, existing: `# X\n\n${MESH_PRIMER}\n`, meshAware: undefined,
    expectWillWrite: false, expectPrimerAfter: true },
  { name: 'source absent + existing copy + meshAware OFF → no-op (untouched)',
    source: false, existing: '# Pre-relocation\nlegacy', meshAware: false,
    expectWillWrite: false, expectPrimerAfter: false },
  { name: 'source absent + no copy + ON → seed primer-only (write)',
    source: false, existing: null, meshAware: undefined,
    expectWillWrite: true, expectPrimerAfter: true },
  { name: 'source absent + no copy + meshAware OFF → no-op (no file)',
    source: false, existing: null, meshAware: false,
    expectWillWrite: false, expectPrimerAfter: false },
]

describe('planCloudInstructions matches provisionCloudInstructions effect', () => {
  for (const c of cases) {
    it(c.name, () => {
      const sp = srcPath(c.source)
      if (c.existing !== null) seedExisting(c.existing)
      const before = fs.existsSync(instrPath()) ? fs.readFileSync(instrPath(), 'utf8') : null

      const plan = planCloudInstructions({
        sourceExists: c.source,
        fileExists: c.existing !== null,
        hasPrimer: c.existing !== null && c.existing.includes(MESH_PRIMER),
        meshAware: c.meshAware,
      })
      expect(plan.willWrite).toBe(c.expectWillWrite)

      provisionCloudInstructions(AID, sp, HOME, c.meshAware)
      const after = fs.existsSync(instrPath()) ? fs.readFileSync(instrPath(), 'utf8') : null

      // Effect must agree with the plan's primer prediction...
      expect(has()).toBe(c.expectPrimerAfter)
      // ...and willWrite=false must mean the file was genuinely untouched.
      if (!plan.willWrite) expect(after).toBe(before)
      // source-present re-seed always lands the source body (write happened).
      if (c.source) expect(after?.startsWith('# Engineer_INSTRUCTIONS.md')).toBe(true)
    })
  }
})
