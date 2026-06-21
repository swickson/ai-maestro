/**
 * reprovision-sweep — re-provision cloud agents' persistent instruction files
 * (mesh-awareness primer + source re-seed) on THIS host, using the exact
 * wake-path call (provisionCloudInstructions). Host-file writes only — NO
 * container recycle, no docker lifecycle. Agents pick up changes on their next
 * wake (the wake-path ensure in #264 re-provisions before startContainer), so
 * this is an ACCELERANT for immediate file-readiness, not a correctness need.
 *
 * SAFETY:
 *  - DRY-RUN by default; pass --apply to actually write.
 *  - The dry-run plan is computed by planCloudInstructions — the SAME branch
 *    logic provisionCloudInstructions uses — so the printed plan matches what
 *    --apply does, including the source-present copy-overwrite (a re-seed is a
 *    write even when the primer is already present).
 *  - Skips soft-delete TOMBSTONES (status === 'deleted'): loadAgents() returns
 *    deleted entries too, and a naive cloud-only filter would re-seed instruction
 *    files into deleted agents' dirs (observed during the #264 sweep). Only live
 *    cloud agents are swept.
 *
 * Usage (run via yarn so CWD = repo root → @/ path aliases resolve; the lib
 * dependency tree uses @/ imports, so a bare `npx tsx` from another CWD fails):
 *   yarn reprovision-sweep            # dry-run: print the plan
 *   yarn reprovision-sweep --apply    # write the files
 */
import fs from 'fs'
import os from 'os'
import path from 'path'
const APPLY = process.argv.includes('--apply')
const PRIMER_TELL = 'part of an AI Maestro agent mesh'

// App modules are loaded via DYNAMIC import inside main() rather than static
// top-level imports. Under node 24's stricter ESM, statically importing these
// named exports fails ("does not provide an export named 'cloudInstructionsSourcePath'")
// due to module instantiation-order in the lib graph; deferring to a runtime
// import resolves them after the static graph settles. (node 20 tolerated the
// static form, which masked the failure — verified on node 24.17.)
async function main() {
  const { loadAgents } = await import('@/lib/agent-registry')
  const { provisionCloudInstructions, cloudInstructionsSourcePath, planCloudInstructions } =
    await import('@/lib/cloud-instructions')

  const agents = loadAgents().filter(
    (a: any) => a?.deployment?.type === 'cloud' && a?.status !== 'deleted'
  )
  console.log(`[sweep] ${APPLY ? 'APPLY' : 'DRY-RUN'} — ${agents.length} live cloud agents (tombstones excluded)`)

  let writes = 0, noops = 0
  for (const a of agents) {
  const sourcePath = cloudInstructionsSourcePath(a.label || a.name, a.deployment?.sandbox?.teamId)
  const instr = path.join(os.homedir(), '.aimaestro', 'agents', a.id, 'instructions.md')
  const fileExists = fs.existsSync(instr)
  const hasPrimer = fileExists && fs.readFileSync(instr, 'utf8').includes(PRIMER_TELL)
  const plan = planCloudInstructions({
    sourceExists: fs.existsSync(sourcePath),
    fileExists,
    hasPrimer,
    meshAware: a.meshAware,
  })
  const id8 = a.id.slice(0, 8)
  const name = (a.name || '').padEnd(28)
  if (!APPLY) {
    plan.willWrite ? writes++ : noops++
    console.log(`  ${id8} ${name} ${plan.willWrite ? 'WOULD' : 'skip'}: ${plan.action}`)
    continue
  }
  // Exact wake-path call: (agentId, sourcePath, undefined hostHome, meshAware)
  provisionCloudInstructions(a.id, sourcePath, undefined, a.meshAware)
  const nowPrimer = fs.existsSync(instr) && fs.readFileSync(instr, 'utf8').includes(PRIMER_TELL)
  plan.willWrite ? writes++ : noops++
  console.log(`  ${id8} ${name} ${plan.action} | primer ${hasPrimer ? '1' : '0'}->${nowPrimer ? '1' : '0'}`)
}
  console.log(
    APPLY
      ? `[sweep] done: ${writes} written, ${noops} no-op`
      : `[sweep] plan: ${writes} would-write, ${noops} no-op — re-run with --apply to write`
  )
}

main().catch((err) => {
  console.error('[sweep] failed:', err)
  process.exit(1)
})
