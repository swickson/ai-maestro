/**
 * reprovision-sweep — re-provision cloud agents' persistent instruction files
 * (mesh-awareness primer + source re-seed) on THIS host, using the exact
 * wake-path invocation in services/agents-core-service.ts.
 *
 * Host-file writes only (provisionCloudInstructions) — NO container recycle, no
 * docker lifecycle. Agents pick up changes on their next wake (the wake-path
 * ensure in #264 re-provisions before startContainer), so this is an ACCELERANT
 * for immediate file-readiness, not a correctness requirement.
 *
 * SAFETY:
 *  - DRY-RUN by default; pass --apply to actually write.
 *  - Skips soft-delete TOMBSTONES (status === 'deleted'): loadAgents() returns
 *    deleted entries too, and a naive cloud-only filter would re-seed instruction
 *    files into deleted agents' dirs (observed 2026-06-21 — a one-off sweep
 *    touched two soft-deleted tombstones). Only live (non-deleted) cloud agents
 *    are swept.
 *
 * Usage:
 *   npx tsx scripts/reprovision-sweep.mts            # dry-run: print the plan
 *   npx tsx scripts/reprovision-sweep.mts --apply    # write the files
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadAgents } from '@/lib/agent-registry'
import { provisionCloudInstructions, cloudInstructionsSourcePath } from '@/lib/cloud-instructions'

const APPLY = process.argv.includes('--apply')
const PRIMER_TELL = 'part of an AI Maestro agent mesh'

const agents = loadAgents().filter(
  (a: any) => a?.deployment?.type === 'cloud' && a?.status !== 'deleted'
)
console.log(`[sweep] ${APPLY ? 'APPLY' : 'DRY-RUN'} — ${agents.length} live cloud agents (tombstones excluded)`)

let willChange = 0, already = 0, changed = 0
for (const a of agents) {
  const instr = path.join(os.homedir(), '.aimaestro', 'agents', a.id, 'instructions.md')
  const hadPrimer = fs.existsSync(instr) && fs.readFileSync(instr, 'utf8').includes(PRIMER_TELL)
  const wants = a.meshAware !== false
  if (!APPLY) {
    const verdict = !wants ? 'skip (meshAware=false)' : hadPrimer ? 'already-present' : 'WOULD backfill'
    if (wants && !hadPrimer) willChange++
    else if (hadPrimer) already++
    console.log(`  ${a.id.slice(0, 8)} ${(a.name || '').padEnd(28)} ${verdict}`)
    continue
  }
  // Exact wake-path call: (agentId, sourcePath, undefined hostHome, meshAware)
  const sourcePath = cloudInstructionsSourcePath(a.label || a.name, a.deployment?.sandbox?.teamId)
  const { instructionsPath } = provisionCloudInstructions(a.id, sourcePath, undefined, a.meshAware)
  const nowPrimer = fs.existsSync(instructionsPath) && fs.readFileSync(instructionsPath, 'utf8').includes(PRIMER_TELL)
  if (!hadPrimer && nowPrimer) changed++
  else if (hadPrimer && nowPrimer) already++
  console.log(`  ${a.id.slice(0, 8)} ${(a.name || '').padEnd(28)} primer ${hadPrimer ? '1' : '0'}->${nowPrimer ? '1' : '0'}`)
}
console.log(
  APPLY
    ? `[sweep] done: backfilled=${changed} already-had=${already}`
    : `[sweep] plan: would-backfill=${willChange} already-had=${already} — re-run with --apply to write`
)
