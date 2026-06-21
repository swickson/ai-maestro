/**
 * Mesh-awareness primer — the short "you are part of an agent mesh, here is how
 * to message peers" context handed to cloud agents.
 *
 * Historically this was PREPENDED to the on-wake paste. That coupled two
 * unrelated things: (1) it inflated the paste (a ~568-char prefix that pushed
 * codex's large on-wake paste over the submit-timing threshold), and (2) the
 * prepend only fired for `prompt:`-prefixed hooks, so a mesh-aware agent with a
 * plain-text hook silently got no primer — the `prompt:` prefix accidentally
 * gated mesh awareness instead of the `meshAware` flag.
 *
 * It now lives in the per-agent persistent instruction file (loaded every
 * session by the harness as context), injected by `provisionCloudInstructions`
 * and gated on `meshAware` — its intended knob. Extracted here as the single
 * source of truth so both the provisioning layer and the wake/hook layer share
 * one definition without a service-to-service import cycle.
 *
 * Command syntax here MUST match the real amp-* CLI surface in
 * plugins/ai-maestro/scripts/amp-*.sh — if you edit this string, re-verify the
 * flags and values stay in sync.
 */

import type { Agent } from '@/types/agent'

export const MESH_PRIMER = [
  'You are running as part of an AI Maestro agent mesh. Other agents in the mesh can send you messages and you can send messages to them.',
  'To send a message: use your agent-messaging skill if available, otherwise invoke amp-send <recipient> "<subject>" "<body>" [--priority low|normal|high|urgent] [--type request|response|notification|task|status]. Quote multi-word subjects and bodies so the shell does not split them into separate positional args.',
  'For the full mesh protocol, command reference, and peer list, run: amp-primer (available in your PATH alongside the other amp-* commands).',
].join(' ')

/**
 * Load mesh-awareness primer content for an agent.
 * Returns empty string if the agent has opted out via meshAware === false.
 * Defaults to enabled (returns the primer) when meshAware is unset.
 *
 * Retained for the host wake path (which still prepends to the paste — its
 * relocation is a separate follow-up). Exported for direct unit testing.
 */
export function loadMeshPrimer(agent: Agent): string {
  if (agent.meshAware === false) return ''
  return MESH_PRIMER
}

/**
 * The primer as a delimited block APPENDED to an existing per-agent
 * instructions.md (after the source copy). Leading blank lines separate it from
 * the source's trailing content; the source's title line stays first (some
 * hooks reference "first line '# <Label>_INSTRUCTIONS.md'").
 */
export function meshAwarenessBlock(): string {
  return `\n\n## Mesh Awareness\n\n${MESH_PRIMER}\n`
}

/**
 * The primer as a STANDALONE instructions.md, for a mesh-aware agent that has no
 * profile source file — so it still gains mesh awareness (and the instruction
 * mount still happens) now that the wake paste no longer carries the primer.
 */
export function primerOnlyInstructions(): string {
  return `# Mesh Awareness\n\n${MESH_PRIMER}\n`
}
