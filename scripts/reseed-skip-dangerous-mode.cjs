#!/usr/bin/env node
/**
 * Reseed pre-PR-#97 cloud-agent claude-settings.json with
 * skipDangerousModePermissionPrompt=true.
 *
 * Background:
 *   PR #97 (kanban 3205393e) added skipDangerousModePermissionPrompt=true to
 *   provisionCloudClaudeConfig's seed for new cloud claude agents — closes the
 *   bypass-permissions warning that re-fires on every container start when
 *   launched with --dangerously-skip-permissions. Cloud agents PROVISIONED
 *   AFTER PR #97 merged (2026-04-29 ~17:49 UTC) get the seed automatically.
 *
 *   Cloud agents provisioned BEFORE PR #97 already have a per-agent
 *   ~/.aimaestro/agents/<uuid>/claude-settings.json that lacks the field.
 *   They keep working today only because the operator manually clicks-through
 *   the warning — but a /recreate (or first-fresh-start) re-shows the prompt
 *   and breaks the on-wake hook flow (kanban 3205393e empirical, 2026-05-04).
 *
 * What this script does:
 *   - Walks the agent registry on this host.
 *   - Filters to cloud agents with program=claude (or claude-code).
 *   - Reads each agent's claude-settings.json.
 *   - If skipDangerousModePermissionPrompt is anything other than `true`,
 *     merges {"skipDangerousModePermissionPrompt": true} in-place, preserving
 *     all other fields (hooks, allowedTools, model, etc.).
 *   - Idempotent: safe to re-run; agents that already have the seed are
 *     no-op-skipped.
 *
 * Usage:
 *   node scripts/reseed-skip-dangerous-mode.cjs [--dry-run] [--registry PATH]
 *
 * Default registry: ~/.aimaestro/agents/registry.json. Mesh-wide deploy is
 * per-host: run on each host (the laptop / the prod host / the dev host) since the registry +
 * per-agent claude-settings.json are host-local.
 *
 * Cross-references: kanban 97bd5dad (this fix), 3205393e (admin-closed root
 * cause), PR #97 (seed source), PR #112 / #120 (sister shape-aware-merge
 * pattern this script mirrors).
 */

const fs = require('fs')
const path = require('path')
const os = require('os')

const args = process.argv.slice(2)
const dryRun = args.includes('--dry-run')
const registryArgIdx = args.indexOf('--registry')
const registryPath = registryArgIdx !== -1 && args[registryArgIdx + 1]
  ? args[registryArgIdx + 1]
  : path.join(os.homedir(), '.aimaestro', 'agents', 'registry.json')

// Per-agent dirs are siblings of registry.json, both under ~/.aimaestro/agents/.
// dirname(registry.json) == .../agents, so per-agent path is dirname + agentId.
const agentsRoot = path.dirname(registryPath)

function isClaudeProgram(program) {
  if (!program || typeof program !== 'string') return false
  return program.toLowerCase().startsWith('claude')
}

function isCloudDeployment(agent) {
  return agent && agent.deployment && agent.deployment.type === 'cloud'
}

function reseedOne(agent) {
  const settingsPath = path.join(agentsRoot, agent.id, 'claude-settings.json')
  if (!fs.existsSync(settingsPath)) {
    return { agent, status: 'no-settings-file', settingsPath }
  }
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  } catch (err) {
    return { agent, status: 'unparseable', settingsPath, error: err.message }
  }
  if (parsed && parsed.skipDangerousModePermissionPrompt === true) {
    return { agent, status: 'already-seeded', settingsPath }
  }
  const next = { ...(parsed || {}), skipDangerousModePermissionPrompt: true }
  if (dryRun) {
    return { agent, status: 'would-reseed', settingsPath }
  }
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2), { mode: 0o600 })
  return { agent, status: 'reseeded', settingsPath }
}

function main() {
  if (!fs.existsSync(registryPath)) {
    console.error(`✗ Registry not found at ${registryPath}`)
    process.exit(2)
  }
  let registry
  try {
    registry = JSON.parse(fs.readFileSync(registryPath, 'utf8'))
  } catch (err) {
    console.error(`✗ Registry unparseable at ${registryPath}: ${err.message}`)
    process.exit(2)
  }
  if (!Array.isArray(registry)) {
    console.error(`✗ Registry at ${registryPath} is not an array`)
    process.exit(2)
  }

  const candidates = registry.filter(a => isCloudDeployment(a) && isClaudeProgram(a.program))
  if (candidates.length === 0) {
    console.log(`ℹ No cloud claude agents in registry — nothing to do.`)
    return
  }

  console.log(`Walking ${candidates.length} cloud claude agent(s) ${dryRun ? '(DRY RUN)' : ''}`)
  const results = candidates.map(reseedOne)

  const counts = results.reduce((acc, r) => {
    acc[r.status] = (acc[r.status] || 0) + 1
    return acc
  }, {})

  for (const r of results) {
    const tag = r.status === 'reseeded' || r.status === 'would-reseed' ? '✓' :
                r.status === 'already-seeded' ? '·' :
                r.status === 'no-settings-file' ? '?' : '✗'
    const label = r.agent.label || r.agent.name || r.agent.id.slice(0, 8)
    console.log(`  ${tag} ${label.padEnd(28)} ${r.status}${r.error ? ` (${r.error})` : ''}`)
  }

  console.log()
  console.log(`Summary: ${Object.entries(counts).map(([k, v]) => `${v} ${k}`).join(', ')}`)
}

main()
