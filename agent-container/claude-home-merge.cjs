/**
 * Idempotent shape-aware merge for ~/.claude.json (container side).
 *
 * Mirrors the host-side seed in services/agents-docker-service.ts:413-438
 * (provisionCloudClaudeConfig, kanban 406ff85d / PR #120) — re-runs the
 * same `inject theme=dark if missing` logic on every container start so the
 * field survives claude-code's own rewrites of the file.
 *
 * Why this exists at all (defense-in-depth):
 *   Empirical 2026-05-22 mesh survey — 4 of 4 cloud claude agents that have
 *   launched (numStartups ≥ 22) show theme:MISSING; 4 of 4 cloud non-claude
 *   agents (claude never invoked, numStartups = 0) show theme:dark intact.
 *   claude-code rewrites ~/.claude.json on launch/shutdown without preserving
 *   our seeded `theme` field. Host-side PR #120 covers the original
 *   user-facing symptom (theme picker on TRUE first launch) by seeding the
 *   field BEFORE claude's first read; the picker doesn't re-trigger on
 *   subsequent launches with theme missing, so the post-launch drift is
 *   currently cosmetic. This module re-injects the field on every container
 *   start as belt-and-suspenders against any future claude-code change that
 *   re-triggers the picker on the missing-field signal — runs pre-tmux from
 *   agent-server.js so claude's next read sees a complete shape.
 *
 * Self-contained CommonJS so agent-server.js (COPYed standalone into /app
 * by agent-container/Dockerfile, no access to repo lib/) can require it.
 */

'use strict'

const fs = require('fs')

const DEFAULT_THEME = 'dark'

/**
 * @param {string} claudeHomePath  Absolute path to the container-side
 *                                 ~/.claude.json file (typically
 *                                 '/home/claude/.claude.json', which is
 *                                 bind-mounted RW from the host's
 *                                 ~/.aimaestro/agents/<id>/claude-home.json).
 * @returns {{ changed: boolean, reason: string }}
 */
function ensureClaudeHomeTheme(claudeHomePath) {
  if (!fs.existsSync(claudeHomePath)) {
    return { changed: false, reason: 'missing' }
  }

  let content
  try {
    content = fs.readFileSync(claudeHomePath, 'utf8')
  } catch (err) {
    console.warn(`[claude-home-merge] cannot read ${claudeHomePath}:`, err && err.message ? err.message : err)
    return { changed: false, reason: 'unreadable' }
  }

  let parsed
  try {
    parsed = JSON.parse(content)
  } catch (err) {
    // Preserve operator's broken file rather than clobbering — host-side
    // provisionCloudClaudeConfig re-seeds from scratch on next /recreate.
    console.warn(`[claude-home-merge] unparseable JSON at ${claudeHomePath}:`, err && err.message ? err.message : err)
    return { changed: false, reason: 'unparseable' }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    console.warn(`[claude-home-merge] non-object root at ${claudeHomePath} — skipping`)
    return { changed: false, reason: 'non-object' }
  }

  if (typeof parsed.theme === 'string') {
    return { changed: false, reason: 'present' }
  }

  parsed.theme = DEFAULT_THEME
  try {
    fs.writeFileSync(claudeHomePath, JSON.stringify(parsed) + '\n', { mode: 0o600 })
    // Node honors `mode` only on file creation. claude-code's own rewrites
    // (or any other writer that touched the file before us) may have widened
    // perms; explicit chmod restores parity with the host seed at
    // services/agents-docker-service.ts:413-438. The file holds claude
    // onboarding + tipsHistory + (post-login) state we'd rather not leave
    // world-readable.
    fs.chmodSync(claudeHomePath, 0o600)
    console.log(`[claude-home-merge] injected theme=${DEFAULT_THEME} into ${claudeHomePath}`)
    return { changed: true, reason: 'injected' }
  } catch (err) {
    console.warn(`[claude-home-merge] cannot write ${claudeHomePath}:`, err && err.message ? err.message : err)
    return { changed: false, reason: 'unwritable' }
  }
}

module.exports = { ensureClaudeHomeTheme, DEFAULT_THEME }
