'use strict'

// Pure helpers for #78 fail-loud runtime validation.
//
// Background: an agent profile names a runtime (claude / codex / gemini /
// antigravity→agy) which the host resolves into the AI_TOOL launch string.
// If the resolved binary isn't present in the container image's PATH, the
// agent historically dropped to a bare shell (or, pre-#171, silently ran
// claude) — masking the misconfiguration. Operators had no signal their
// "Gemini agent" wasn't actually running Gemini, which defeats the whole
// point of mixed-runtime cross-review (the reviewer's model must differ from
// the builder's).
//
// PR #81 closed the image half (bakes the multi-runtime CLIs in). This module
// closes the remaining fail-loud half: agent-server.js probes the resolved
// binary with `command -v` before launch and, when absent, surfaces a clear
// error into the session instead of starting a broken/wrong runtime.
//
// Kept side-effect-free and dependency-free so the main vitest suite can
// exercise it without booting the container WebSocket/PTY server.

/**
 * Extract the launch binary (first whitespace-delimited token) from an
 * AI_TOOL command string, e.g. "gemini --yolo" -> "gemini",
 * "claude --permission-mode acceptEdits" -> "claude". Returns '' for an
 * empty/non-string input.
 */
function parseAiToolBinary(aiTool) {
  if (!aiTool || typeof aiTool !== 'string') return ''
  return aiTool.trim().split(/\s+/)[0] || ''
}

/**
 * Operator-facing message shown when the resolved runtime binary is not on
 * the container PATH. Phrased to point at the two real remediations:
 * rebuild the image (CLI missing) or correct the profile (wrong runtime).
 */
function runtimeMissingMessage(binary) {
  return `runtime '${binary}' not found in agent container PATH; rebuild image or correct profile`
}

module.exports = { parseAiToolBinary, runtimeMissingMessage }
