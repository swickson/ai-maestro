/**
 * Per-agent cloud instruction-file provisioning (host side).
 *
 * Lives in lib/ (not the agents-docker service) so BOTH the provisioning layer
 * and the wake path (agents-core-service) can call it without a service→service
 * import cycle — importing the heavy agents-docker-service into agents-core
 * triggers a module-init TDZ cycle (hosts-config `dirStore`). These functions
 * are pure fs/path/os + lib/mesh-primer, with no service dependencies.
 */

import fs from 'fs'
import path from 'path'
import os from 'os'
import { MESH_PRIMER, meshAwarenessBlock, primerOnlyInstructions } from '@/lib/mesh-primer'

// Resolve the host-side source instruction file for an agent: a per-team
// instruction-source dir holding the the gateway agent-maintained <Label>_INSTRUCTIONS.md.
// Lives at ~/.aimaestro/ai-team-src/<teamId>/ — a SIBLING of the /ai-team mount
// dir, deliberately NOT inside it: /ai-team is bind-mounted RO into worker
// containers, so source files placed there would be readable by every peer,
// contradicting the "§1 = per-agent identity, not shared plan content" model
// (a peer dev #193 review). the gateway agent owns + maintains these files at this path on each
// host. Label is sanitized to a safe basename (no separators / traversal) since
// it indexes a filesystem path.
export function cloudInstructionsSourcePath(
  label: string | undefined,
  teamId: string | undefined,
  hostHome: string = os.homedir()
): string {
  const base = path.join(hostHome, '.aimaestro', 'ai-team-src')
  const dir = teamId ? path.join(base, teamId) : base
  const safeLabel = (label || '').replace(/[^a-zA-Z0-9_-]/g, '') || 'AGENT'
  return path.join(dir, `${safeLabel}_INSTRUCTIONS.md`)
}

// Provision the per-agent instruction file. SEED-FROM-SOURCE-IS-TRUTH: when the
// orchestrator source exists, (re)seed the per-agent copy from it on every
// provision — the mount is RO into the container so the agent can never edit it,
// which means there is no in-container hand-edit to preserve, and re-seeding lets
// the gateway agent's source-of-truth edits reach the agent on the next rebuild. When the
// source is ABSENT (e.g. moved, or a cross-host rebuild where the source isn't
// present), KEEP the existing per-agent copy untouched — that copy is the
// durability fallback (migrateAgentPersistence carries instructions.md across
// /recreate UUID rotation). Returns whether a per-agent file now exists.
export function provisionCloudInstructions(
  agentId: string,
  sourcePath: string,
  hostHome: string = os.homedir(),
  meshAware?: boolean
): { provisioned: boolean; instructionsPath: string } {
  const agentDir = path.join(hostHome, '.aimaestro', 'agents', agentId)
  const instructionsPath = path.join(agentDir, 'instructions.md')
  // Mesh awareness defaults ON; opt out only via meshAware === false. Gating the
  // primer here (its intended knob) is the coupling fix: previously the primer
  // was prepended to the wake paste only for prompt:-prefixed hooks, so the
  // hook's prefix accidentally gated mesh awareness.
  const wantsPrimer = meshAware !== false
  if (fs.existsSync(sourcePath)) {
    // Source present: re-seed from it (source-of-truth) then append the mesh
    // primer as durable context. copyFileSync overwrites first, so the append is
    // idempotent across re-provisions — it never accumulates, and toggling
    // meshAware off drops the primer on the next provision.
    try {
      fs.mkdirSync(agentDir, { recursive: true })
      fs.copyFileSync(sourcePath, instructionsPath)
      if (wantsPrimer) {
        fs.appendFileSync(instructionsPath, meshAwarenessBlock())
      }
      fs.chmodSync(instructionsPath, 0o644)
    } catch (err) {
      console.warn(`[provisionCloudInstructions] seed ${sourcePath} -> ${instructionsPath}:`, err instanceof Error ? err.message : err)
    }
  } else if (fs.existsSync(instructionsPath)) {
    // Source ABSENT but an existing per-agent copy is present (durability
    // fallback, carried across UUID rotation). BACKFILL the primer if it's
    // missing: an agent provisioned BEFORE the relocation — or migrated — won't
    // carry the ## Mesh Awareness block, and since the wake paste no longer
    // prepends the primer, such an agent would lose mesh awareness entirely
    // (the existing-agent regression). We cannot copy-overwrite here (there is no
    // source), so idempotency is by DETECT-THEN-APPEND: append the block once iff
    // the primer text isn't already present. This runs host-side on every
    // provision, which happens before the container starts, so an existing agent
    // self-heals on its next bring-up (a recycle sweep is only an accelerant).
    // meshAware === false leaves the copy untouched here — stripping an
    // already-present primer on opt-out is a deferred symmetric follow-up.
    if (wantsPrimer) {
      try {
        const existing = fs.readFileSync(instructionsPath, 'utf8')
        if (!existing.includes(MESH_PRIMER)) {
          fs.appendFileSync(instructionsPath, meshAwarenessBlock())
        }
        fs.chmodSync(instructionsPath, 0o644)
      } catch (err) {
        console.warn(`[provisionCloudInstructions] backfill primer -> ${instructionsPath}:`, err instanceof Error ? err.message : err)
      }
    }
  } else if (wantsPrimer) {
    // Source ABSENT and no existing per-agent copy: a mesh-aware agent with no
    // profile source. Seed a primer-only file so it still gains mesh awareness
    // and the instruction mount still happens (no-regression now that the wake
    // paste no longer carries the primer).
    try {
      fs.mkdirSync(agentDir, { recursive: true })
      fs.writeFileSync(instructionsPath, primerOnlyInstructions())
      fs.chmodSync(instructionsPath, 0o644)
    } catch (err) {
      console.warn(`[provisionCloudInstructions] seed primer-only -> ${instructionsPath}:`, err instanceof Error ? err.message : err)
    }
  }
  return { provisioned: fs.existsSync(instructionsPath), instructionsPath }
}

/**
 * Pure predictor for `provisionCloudInstructions`' write decision — same branch
 * logic, no I/O. Lets a dry-run print exactly what `--apply` would do (a sweep's
 * plan MUST match its effect). Keep in lockstep with the branches above; the
 * cloud-instructions-plan test asserts they agree for every input combination.
 */
export function planCloudInstructions(input: {
  sourceExists: boolean
  fileExists: boolean
  hasPrimer: boolean
  meshAware?: boolean
}): { willWrite: boolean; action: string } {
  const wantsPrimer = input.meshAware !== false
  // Branch 1: source present → ALWAYS re-seed (copy-overwrite), regardless of
  // meshAware; then append the primer iff wanted. Always a write.
  if (input.sourceExists) {
    return wantsPrimer
      ? { willWrite: true, action: 're-seed from source + append primer' }
      : { willWrite: true, action: 're-seed from source (no primer — meshAware=false)' }
  }
  // Branch 2: source absent but a per-agent copy exists (durability fallback).
  if (input.fileExists) {
    if (wantsPrimer && !input.hasPrimer) {
      return { willWrite: true, action: 'backfill primer (source absent, was missing)' }
    }
    return {
      willWrite: false,
      action: wantsPrimer ? 'no-op (primer already present)' : 'no-op (meshAware=false, copy untouched)',
    }
  }
  // Branch 3: source absent, no copy.
  if (wantsPrimer) return { willWrite: true, action: 'seed primer-only file' }
  return { willWrite: false, action: 'no-op (no source, no copy, meshAware=false)' }
}
