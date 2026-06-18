/**
 * Program Resolver — single source of truth for agent `program` identity.
 *
 * Historically the same `program → X` mapping was hand-rolled in ≥5 places,
 * which let the 23blocks reland silently revert ONE copy (the host-wake
 * resolveStartCommand lost its `antigravity → agy` branch → program=antigravity
 * agents woke as `claude`; fixed in PR #171). This module collapses those
 * copies into ONE table + two helpers so a future revert fails a single test
 * loudly instead of drifting unnoticed.
 *
 * TWO semantic families read the same table:
 *   (A) program → BINARY/command  via resolveBinary()   — what to launch
 *   (B) program → KIND/category   via resolveKind()      — how to classify
 *
 * The two families have different value spaces, so each table row carries an
 * OPTIONAL `binary` and an OPTIONAL `kind`; absence means "fall through to the
 * caller's default" (e.g. aider/cursor/opencode have a binary but no meeting
 * kind; openclaw has a kind but is intentionally NOT maestro-launchable).
 *
 * Lives in this pure leaf module (no runtime/cozo imports) so services and
 * lib/agent-paths.ts can import it without dragging the runtime chain into
 * otherwise-pure code (same constraint that kept resolveStartCommand out of
 * services/agents-core-service.ts).
 */

/**
 * Shell prelude run immediately before launching an agent's program, to scrub
 * leaked parent-environment vars that change Claude Code's behavior inside the
 * agent's tmux session.
 *
 *   - `CLAUDECODE`               — leaked nested-session marker (long-standing scrub).
 *   - `CLAUDE_CODE_CHILD_SESSION` — set when the pm2 server itself was launched
 *     under Claude Code's experimental agent-teams feature; inherited into every
 *     agent we launch. A standalone CLI claude with this var set runs as a
 *     "child session" and writes NO per-project transcript
 *     (`~/.claude/projects/<dir>/<session>.jsonl`), which silently breaks chat
 *     history (the #197 resolver finds no file) and token-spend visibility for
 *     all ai-maestro-launched tmux agents. Empirically, unsetting only this var
 *     restores transcripts; `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` is NOT the
 *     cause and must stay set (Claude Desktop relies on it). No-op on Linux
 *     (var unset there). Closes #196.
 *
 * Centralized so the launch sites (agents-core-service, sessions-service,
 * help-service) can't drift apart — a future revert of one copy fails a single
 * test loudly instead of silently breaking one launch path.
 */
export const LAUNCH_ENV_SCRUB = 'unset CLAUDECODE CLAUDE_CODE_CHILD_SESSION'

/** Canonical agent classification. Source of truth for the AgentKind union. */
export type AgentKind = 'claude' | 'codex' | 'gemini' | 'antigravity' | 'opencode' | 'openclaw' | 'unknown'

interface ProgramSpec {
  /** Lowercased substring tokens; first table row whose token matches wins. */
  matches: string[]
  /** Launch command. Omitted = not launchable via maestro (discover-and-attach only). */
  binary?: string
  /** Classification. Omitted = caller's default (program is not a meeting/cloud kind). */
  kind?: AgentKind
}

/**
 * THE program table. Row ORDER encodes substring precedence and is significant:
 * `antigravity` MUST precede `gemini` (agy stores under ~/.gemini/antigravity-cli/,
 * so a future combined label stays unambiguous). This order reproduces the exact
 * precedence of the legacy if/else chains it replaces — do not reorder without a
 * matching test update.
 */
const PROGRAM_TABLE: ProgramSpec[] = [
  { matches: ['claude', 'claude code'], binary: 'claude', kind: 'claude' },
  { matches: ['codex', 'gpt'], binary: 'codex', kind: 'codex' },
  { matches: ['aider'], binary: 'aider' },
  { matches: ['cursor'], binary: 'cursor' },
  { matches: ['antigravity'], binary: 'agy', kind: 'antigravity' }, // BEFORE gemini
  { matches: ['gemini'], binary: 'gemini', kind: 'gemini' },
  { matches: ['opencode'], binary: 'opencode', kind: 'opencode' },
  // openclaw is discover-and-attach (clawdbot owns its own tmux sessions on
  // custom sockets); the maestro create primitive (tmux new-session, no -S
  // socket) structurally cannot launch it, so it carries a KIND but NO binary
  // by design. If openclaw proves launchable post-experiment, add a verified
  // `binary` then — like antigravity in PR #149/#171. The program-resolver test
  // locks this deferral (resolveBinary('openclaw') must NOT be 'openclaw').
  { matches: ['openclaw'], kind: 'openclaw' },
]

function matchProgram(program?: string | null): ProgramSpec | undefined {
  if (!program) return undefined
  const p = program.toLowerCase()
  return PROGRAM_TABLE.find(spec => spec.matches.some(m => p.includes(m)))
}

/**
 * Family A: resolve an agent `program` to the CLI binary/command to launch.
 * Defaults to 'claude' for unknown or non-launchable programs.
 */
export function resolveBinary(program?: string | null): string {
  return matchProgram(program)?.binary ?? 'claude'
}

/**
 * Family B: resolve an agent `program` to its canonical kind/category.
 * `opts.default` is returned when the program is unknown or has no kind
 * (callers differ: cloud wants 'claude', meeting wants 'unknown').
 */
export function resolveKind(program?: string | null, opts?: { default?: AgentKind }): AgentKind {
  return matchProgram(program)?.kind ?? (opts?.default ?? 'unknown')
}
