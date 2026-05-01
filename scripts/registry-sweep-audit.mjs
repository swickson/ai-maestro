#!/usr/bin/env node

/**
 * Phase 1 read-only audit of agent registries across the mesh.
 *
 * Identifies:
 *   - Cross-host duplicate UUIDs (PR #101 invariant — should be empty mesh-wide)
 *   - Intra-host duplicate UUIDs (PR #101 invariant — should be empty per host)
 *   - Stale lastActive (> 30 days, configurable)
 *   - AllianceOS quartet (tagged "migration-pending, defer" — NOT cleanup candidates)
 *   - Soft-deleted records (when --local mode reads this host's registry.json)
 *
 * Outputs to OUT_DIR/:
 *   - summary.md           operator-friendly summary + recommended actions
 *   - snapshot.json        per-host fingerprint for Phase 3 drift-check
 *   - <host>-raw.json      raw /api/agents response (active records)
 *   - <host>-candidates.json  analyzed candidates with rationale
 *   - local-registry.json  raw registry.json for this host (--local mode only)
 *
 * NO DELETE. Read-only. Phase 2 = manual review of summary.md → confirmed-delete list.
 * Phase 3 = targeted DELETE under operator supervision; re-fetch + diff against snapshot
 * fingerprint before each delete to abort on drift.
 *
 * Usage:
 *   node scripts/registry-sweep-audit.mjs                   # API-only cross-host
 *   node scripts/registry-sweep-audit.mjs --local           # also read this host registry.json
 *   node scripts/registry-sweep-audit.mjs --out ./my-audit  # custom output dir
 *   node scripts/registry-sweep-audit.mjs --stale-days 14   # override stale threshold
 */

import { promises as fs } from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'

// Tailscale IPs everywhere — never `localhost`. When this script runs from
// any of the three hosts, `localhost` resolves to the running host, causing
// false-positive cross-host duplicate findings (Watson empirical PR #106).
const HOSTS = [
  { name: 'milo',     url: 'http://100.83.160.34:23000' },
  { name: 'bananajr', url: 'http://100.112.62.82:23000' },
  { name: 'holmes',   url: 'http://100.81.151.18:23000' },
]

const ALLIANCEOS_PREFIX = 'dev-allianceos-'
const REGISTRY_PATH = path.join(os.homedir(), '.aimaestro', 'agents', 'registry.json')

const ARGS = process.argv.slice(2)
function getFlag(name, defaultVal = null) {
  const idx = ARGS.indexOf(`--${name}`)
  if (idx === -1) return defaultVal
  if (idx + 1 < ARGS.length && !ARGS[idx + 1].startsWith('--')) return ARGS[idx + 1]
  return true
}

const STALE_DAYS = Number(getFlag('stale-days', 30))
const SOFT_DELETED_RETENTION_DAYS = Number(getFlag('soft-deleted-days', 30))
const LOCAL_MODE = !!getFlag('local')
const NOW = new Date()
const STALE_CUTOFF_MS = NOW.getTime() - STALE_DAYS * 86400000
const SOFT_DELETED_CUTOFF_MS = NOW.getTime() - SOFT_DELETED_RETENTION_DAYS * 86400000

const stamp = NOW.toISOString().replace(/[:.]/g, '-').replace('Z', '')
const OUT_DIR = getFlag('out') || `./sweep-audit-${stamp}`

// Structural fingerprint — only fields whose change implies a delete-safety state shift.
// Excludes lastActive (heartbeat-volatile, would drift every tick) and other transient
// fields. Sorted by id for determinism. Phase 3 drift-check compares this fingerprint
// against the snapshot before each delete and aborts on mismatch (Watson catch PR #106).
function fingerprint(data) {
  const agents = Array.isArray(data) ? data : (data.agents || [])
  const structural = agents
    .map((a) => ({ id: a.id || null, name: a.name || null, deletedAt: a.deletedAt || null }))
    .sort((x, y) => (x.id || '').localeCompare(y.id || ''))
  return crypto.createHash('sha256').update(JSON.stringify(structural)).digest('hex').slice(0, 16)
}

function daysAgo(iso) {
  if (!iso) return null
  return Math.floor((NOW.getTime() - new Date(iso).getTime()) / 86400000)
}

async function fetchHost(host) {
  try {
    const res = await fetch(`${host.url}/api/agents`, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) return { error: `HTTP ${res.status}`, agents: [] }
    const data = await res.json()
    const agents = Array.isArray(data) ? data : (data.agents || [])
    return { agents, raw: data }
  } catch (err) {
    return { error: err.message, agents: [] }
  }
}

async function readLocalRegistry() {
  try {
    const raw = await fs.readFile(REGISTRY_PATH, 'utf-8')
    const data = JSON.parse(raw)
    const agents = Array.isArray(data) ? data : (data.agents || [])
    return { agents, raw: data }
  } catch (err) {
    return { error: err.message, agents: [] }
  }
}

function classifyApiAgent(agent) {
  const reasons = []
  const isAllianceOS = agent.name && agent.name.startsWith(ALLIANCEOS_PREFIX)
  if (isAllianceOS) {
    reasons.push('allianceos: migration-pending (defer, NOT cleanup)')
    return { reasons, action: 'defer-migration' }
  }
  const idleDays = daysAgo(agent.lastActive)
  if (idleDays !== null && idleDays > STALE_DAYS) {
    reasons.push(`stale lastActive: ${idleDays}d (> ${STALE_DAYS}d threshold)`)
    return { reasons, action: 'review-stale' }
  }
  if (agent.isOrphan) {
    reasons.push('flagged isOrphan=true by registry')
    return { reasons, action: 'review-orphan' }
  }
  return { reasons: ['active, recent'], action: 'keep' }
}

function classifyLocalAgent(agent) {
  const isAllianceOS = agent.name && agent.name.startsWith(ALLIANCEOS_PREFIX)
  if (agent.deletedAt) {
    const ageDays = daysAgo(agent.deletedAt)
    if (isAllianceOS) {
      return {
        reasons: [`allianceos soft-deleted ${ageDays}d ago — defer until migration plan settled`],
        action: 'defer-migration',
      }
    }
    if (new Date(agent.deletedAt).getTime() < SOFT_DELETED_CUTOFF_MS) {
      return {
        reasons: [`soft-deleted ${ageDays}d ago, older than ${SOFT_DELETED_RETENTION_DAYS}d retention — scrub`],
        action: 'delete',
      }
    }
    return {
      reasons: [`soft-deleted ${ageDays}d ago, within ${SOFT_DELETED_RETENTION_DAYS}d retention — keep for forensic`],
      action: 'keep-forensic',
    }
  }
  return classifyApiAgent(agent)
}

function summarizeHost(hostName, agents, classifier) {
  const idCounts = new Map()
  for (const a of agents) idCounts.set(a.id, (idCounts.get(a.id) || 0) + 1)
  const intraDups = [...idCounts.entries()]
    .filter(([_, c]) => c > 1)
    .map(([id, count]) => ({ id, count }))

  const candidates = agents.map((a) => ({
    id: a.id,
    name: a.name,
    label: a.label || null,
    status: a.status || null,
    deletedAt: a.deletedAt || null,
    lastActive: a.lastActive || null,
    hostId: a.hostId || hostName,
    program: a.program || null,
    classification: classifier(a),
  }))

  const counts = {}
  for (const c of candidates) {
    counts[c.classification.action] = (counts[c.classification.action] || 0) + 1
  }

  return { host: hostName, total: agents.length, intraDups, candidates, counts }
}

function crossHostDupCheck(perHost) {
  const seen = new Map()
  for (const h of perHost) {
    for (const c of h.candidates) {
      const list = seen.get(c.id) || []
      list.push({ host: h.host, name: c.name })
      seen.set(c.id, list)
    }
  }
  return [...seen.entries()]
    .filter(([_, hosts]) => hosts.length > 1)
    .map(([id, hosts]) => ({ id, hosts }))
}

function table(rows, columns) {
  const widths = columns.map((c) => Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)))
  const sep = '|' + widths.map((w) => '-'.repeat(w + 2)).join('|') + '|'
  const header = '|' + columns.map((c, i) => ` ${c.padEnd(widths[i])} `).join('|') + '|'
  const body = rows.map((r) => '|' + columns.map((c, i) => ` ${String(r[c] ?? '').padEnd(widths[i])} `).join('|') + '|')
  return [header, sep, ...body].join('\n')
}

function renderSummary(snapshot, perHost, crossDups, localData, errors) {
  const lines = []
  lines.push('# Registry Sweep Audit — Phase 1 (READ-ONLY)')
  lines.push('')
  lines.push(`Generated: ${snapshot.generatedAt}`)
  lines.push(`Stale threshold: ${STALE_DAYS} days`)
  lines.push(`Soft-deleted retention: ${SOFT_DELETED_RETENTION_DAYS} days`)
  lines.push(`Local registry mode: ${LOCAL_MODE ? 'enabled' : 'disabled (API-only)'}`)
  lines.push('')

  if (Object.keys(errors).length > 0) {
    lines.push('## ⚠ Reachability errors')
    lines.push('')
    for (const [host, err] of Object.entries(errors)) {
      lines.push(`- **${host}**: ${err}`)
    }
    lines.push('')
  }

  lines.push('## Snapshot fingerprint (for Phase 3 drift-check)')
  lines.push('')
  lines.push(table(
    perHost.map((h) => ({ host: h.host, total: h.total, fingerprint: snapshot.fingerprints[h.host] })),
    ['host', 'total', 'fingerprint'],
  ))
  if (LOCAL_MODE && localData) {
    lines.push('')
    lines.push(`Local registry (${localData.host}): ${localData.total} rows, fingerprint \`${localData.fingerprint}\``)
  }
  lines.push('')
  lines.push('Phase 3 must re-fetch each host and recompute the fingerprint. Abort delete if drift detected.')
  lines.push('')

  lines.push('## Per-host action summary (active records, API)')
  lines.push('')
  const actions = ['keep', 'review-stale', 'review-orphan', 'defer-migration']
  const rows = perHost.map((h) => {
    const r = { host: h.host, total: h.total }
    for (const a of actions) r[a] = h.counts[a] || 0
    return r
  })
  lines.push(table(rows, ['host', 'total', ...actions]))
  lines.push('')

  if (LOCAL_MODE && localData) {
    lines.push(`## Local registry summary (${localData.host}, includes soft-deleted)`)
    lines.push('')
    const localActions = ['keep', 'keep-forensic', 'review-stale', 'review-orphan', 'defer-migration', 'delete']
    const localRow = { total: localData.total }
    for (const a of localActions) localRow[a] = localData.counts[a] || 0
    lines.push(table([localRow], ['total', ...localActions]))
    lines.push('')
  }

  lines.push('## PR #101 mesh invariant — duplicate UUIDs')
  lines.push('')
  let anyIntra = false
  for (const h of perHost) {
    if (h.intraDups.length > 0) {
      anyIntra = true
      lines.push(`### Intra-host: ${h.host}`)
      for (const d of h.intraDups) lines.push(`- \`${d.id}\` × ${d.count}`)
      lines.push('')
    }
  }
  if (!anyIntra) lines.push('Intra-host duplicates: **none** (PR #101 holds per host)')
  lines.push('')
  if (crossDups.length === 0) {
    lines.push('Cross-host duplicates: **none** (mesh-correct)')
  } else {
    lines.push('### Cross-host duplicates ⚠')
    for (const d of crossDups) {
      lines.push(`- \`${d.id}\` on: ${d.hosts.map((h) => `${h.host} (${h.name})`).join(', ')}`)
    }
  }
  lines.push('')

  lines.push('## Recommended actions per host (active records via API)')
  lines.push('')
  for (const h of perHost) {
    lines.push(`### ${h.host}`)
    lines.push('')
    const groups = {}
    for (const c of h.candidates) {
      const g = groups[c.classification.action] || []
      g.push(c)
      groups[c.classification.action] = g
    }
    const order = ['review-stale', 'review-orphan', 'defer-migration', 'keep']
    for (const action of order) {
      const list = groups[action]
      if (!list || list.length === 0) continue
      lines.push(`**${action}** (${list.length})`)
      lines.push('')
      for (const c of list) {
        const idle = daysAgo(c.lastActive)
        const idleStr = idle !== null ? `idle ${idle}d` : 'no lastActive'
        lines.push(`- \`${c.id}\` **${c.label || c.name}** (${c.program || '?'}, ${idleStr})`)
        for (const r of c.classification.reasons) lines.push(`  - ${r}`)
      }
      lines.push('')
    }
  }

  if (LOCAL_MODE && localData) {
    lines.push(`## Recommended actions for ${localData.host} local registry (incl. soft-deleted)`)
    lines.push('')
    const groups = {}
    for (const c of localData.candidates) {
      const g = groups[c.classification.action] || []
      g.push(c)
      groups[c.classification.action] = g
    }
    const order = ['delete', 'keep-forensic', 'review-stale', 'review-orphan', 'defer-migration', 'keep']
    for (const action of order) {
      const list = groups[action]
      if (!list || list.length === 0) continue
      lines.push(`**${action}** (${list.length})`)
      lines.push('')
      for (const c of list) {
        const tag = c.deletedAt ? `soft-deleted ${daysAgo(c.deletedAt)}d` : `idle ${daysAgo(c.lastActive) ?? '?'}d`
        lines.push(`- \`${c.id}\` **${c.label || c.name}** (${c.program || '?'}, ${tag})`)
        for (const r of c.classification.reasons) lines.push(`  - ${r}`)
      }
      lines.push('')
    }
  }

  lines.push('---')
  lines.push('')
  lines.push('## Phase 2 — manual review')
  lines.push('')
  lines.push('Walk each host\'s **review-stale**, **review-orphan**, and (if local-mode) **delete** lists. Mark each as Confirm-Delete | Keep | Defer. Soft-deleted records older than retention are pre-classified as **delete** but require explicit confirm before Phase 3 acts.')
  lines.push('')
  lines.push('## Phase 3 — targeted DELETE under operator supervision')
  lines.push('')
  lines.push('For each Confirm-Delete entry: re-fetch the host, recompute fingerprint, abort on drift. Then `DELETE /api/agents/<id>` against the right host. Log every scrub. Generate post-state summary.')

  return lines.join('\n')
}

async function main() {
  await fs.mkdir(OUT_DIR, { recursive: true })

  const fingerprints = {}
  const errors = {}
  const perHost = []

  for (const host of HOSTS) {
    process.stdout.write(`Fetching ${host.name} (${host.url})... `)
    const result = await fetchHost(host)
    if (result.error) {
      console.log(`ERROR: ${result.error}`)
      errors[host.name] = result.error
      continue
    }
    console.log(`${result.agents.length} active`)
    fingerprints[host.name] = fingerprint(result.raw)
    await fs.writeFile(path.join(OUT_DIR, `${host.name}-raw.json`), JSON.stringify(result.raw, null, 2))
    const summary = summarizeHost(host.name, result.agents, classifyApiAgent)
    await fs.writeFile(path.join(OUT_DIR, `${host.name}-candidates.json`), JSON.stringify(summary, null, 2))
    perHost.push(summary)
  }

  let localData = null
  if (LOCAL_MODE) {
    const localHostName = os.hostname()
    process.stdout.write(`Reading local registry on ${localHostName}... `)
    const local = await readLocalRegistry()
    if (local.error) {
      console.log(`ERROR: ${local.error}`)
      errors[`${localHostName} (local)`] = local.error
    } else {
      console.log(`${local.agents.length} rows`)
      const summary = summarizeHost(localHostName, local.agents, classifyLocalAgent)
      summary.fingerprint = fingerprint(local.raw)
      localData = summary
      await fs.writeFile(path.join(OUT_DIR, 'local-registry.json'), JSON.stringify(local.raw, null, 2))
      await fs.writeFile(path.join(OUT_DIR, 'local-candidates.json'), JSON.stringify(summary, null, 2))
    }
  }

  const crossDups = crossHostDupCheck(perHost)
  const snapshot = {
    generatedAt: NOW.toISOString(),
    staleDays: STALE_DAYS,
    softDeletedRetentionDays: SOFT_DELETED_RETENTION_DAYS,
    localMode: LOCAL_MODE,
    fingerprints,
    errors,
  }
  await fs.writeFile(path.join(OUT_DIR, 'snapshot.json'), JSON.stringify(snapshot, null, 2))

  const summaryMd = renderSummary(snapshot, perHost, crossDups, localData, errors)
  await fs.writeFile(path.join(OUT_DIR, 'summary.md'), summaryMd)

  console.log(`\nWrote audit to ${OUT_DIR}`)
  console.log(`  - summary.md (${summaryMd.length} chars)`)
  console.log(`  - snapshot.json (Phase 3 drift-check reference)`)
  console.log(`  - <host>-raw.json + <host>-candidates.json per reachable host`)
  if (LOCAL_MODE) console.log(`  - local-registry.json + local-candidates.json (this host only)`)
  console.log(`\nNext: review summary.md, then proceed to Phase 2 (manual mark).`)
}

main().catch((err) => {
  console.error('FATAL:', err)
  process.exit(1)
})
