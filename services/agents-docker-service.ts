/**
 * Agents Docker Service
 *
 * Business logic for creating agents in Docker containers.
 * Routes are thin wrappers that call these functions.
 */

import fs from 'fs'
import os from 'os'
import path from 'path'
import { exec } from 'child_process'
import { promisify } from 'util'
import { v4 as uuidv4 } from 'uuid'
import { createAgent, deleteAgent, getAgent, loadAgents, saveAgents, updateAgent, updateAgentRuntimeConfig, clearCloudContainerStale } from '@/lib/agent-registry'
import { getHosts, isSelf, getOrganization } from '@/lib/hosts-config'
import { generateKeyPair, saveKeyPair } from '@/lib/amp-keys'
import { registerAgent } from '@/services/amp-service'
import { type ServiceResult, missingField, operationFailed, invalidRequest, invalidState, notFound, gone, serviceError } from '@/services/service-errors'
import type { Agent, SandboxMount } from '@/types/agent'
import { PERMISSION_MODE_TO_CLI } from '@/types/agent'
import type { AgentPermissionMode } from '@/types/agent'
import { CONTAINER_CWD_GEMINI_PROJECT } from '@/lib/container-utils'
import { resolveStartCommand } from '@/lib/agent-paths'

const execAsync = promisify(exec)

export interface DockerCreateRequest {
  name: string
  workingDirectory?: string
  hostId?: string
  program?: string
  /** @deprecated Use permissionMode: 'fullAutonomy' instead */
  yolo?: boolean
  permissionMode?: AgentPermissionMode
  model?: string
  programArgs?: string
  prompt?: string
  timeout?: number
  githubToken?: string
  cpus?: number
  memory?: string
  autoRemove?: boolean
  label?: string
  avatar?: string
  mounts?: SandboxMount[]
  extraEnv?: Record<string, string>
  // When true, attach the container to the `ziggy_default` docker network,
  // overlay-mount a per-agent .env at /home/gosub/code/ziggy/.env, and add a
  // [mcp_servers.ziggy] entry to the per-agent codex config.toml so Codex
  // launches the Ziggy MCP server as a STDIO subprocess. Requires
  // /opt/stacks/ai-maestro/agent-envs/<name>.env to exist on the host with
  // ZIGGY_PROFILE + DATABASE_URL set; createDockerAgent fails loudly if
  // missing. See sandbox.ziggy on the persisted agent record.
  ziggy?: boolean
  // Internal — set by recreateDockerAgent to migrate persisted claude/gh state
  // from the soft-deleted predecessor's per-UUID dir into the new agent's dir
  // BEFORE the container starts. Without this, /recreate's UUID rotation
  // forces every operator through the bypass-accept + claude OAuth + gh login
  // dance on every recreate — the bind mounts are per-UUID, so a fresh dir
  // means no preserved state. Not exposed in the dashboard create flow.
  persistFromAgentId?: string
}

// Reject paths that could break out of the quoted `-v "..."` shell argument.
const UNSAFE_PATH_CHARS = /["'`$\n\r\\]/

// Reject env values that could break out of the quoted `-e KEY="value"` shell
// argument, or smuggle a second flag into the docker invocation. Same character
// class as path validation — both are interpolated into a quoted shell string.
const UNSAFE_ENV_VALUE_CHARS = /["'`$\n\r\\]/

// POSIX env var name shape: leading letter or underscore, then alphanumerics
// or underscores. Matches what `env` and most shells will actually export.
const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

// Container user/home for the standard cloud-agent image (agent-container/Dockerfile).
// Used to compute container-side paths for AMP common mounts. If the image's
// USER ever changes, update this and the Dockerfile together.
const CONTAINER_HOME = '/home/claude'

/**
 * Build the AI_TOOL command string for a Docker agent (permission-mode aware).
 * Extracted for testability (ported from upstream 23blocks).
 *
 * Resolution order for permission mode:
 *   1. body.permissionMode (explicit new field)
 *   2. body.yolo (legacy backward compat, maps to fullAutonomy)
 *   3. 'supervised' (default, no flag injected)
 *
 * NOTE: this helper uses `body.program` verbatim to preserve the exact
 * upstream contract (e.g. `claude-code` stays `claude-code`). The two live
 * AI_TOOL composition sites in this file (createDockerAgent +
 * updateContainerMountsAndExtraEnv) deliberately continue to route the
 * program through resolveStartCommand() so the antigravity→`agy` binary
 * remap (PR-3 hotfix) is not lost. Migrating those sites to permissionMode
 * is a separate, behavior-changing decision (see KAI flag in the
 * reconciliation report) — do NOT silently rewire them here.
 */
export function buildAiToolCommand(body: Pick<DockerCreateRequest, 'program' | 'permissionMode' | 'yolo' | 'programArgs' | 'model' | 'prompt'>): string {
  const program = body.program || 'claude'
  let aiTool = program
  const effectivePermMode: AgentPermissionMode = body.permissionMode || (body.yolo ? 'fullAutonomy' : 'supervised')
  if (effectivePermMode !== 'supervised' && (program === 'claude' || program === 'claude-code')) {
    aiTool += ` --permission-mode ${PERMISSION_MODE_TO_CLI[effectivePermMode]}`
  }
  if (body.programArgs) {
    const sanitizedArgs = body.programArgs.replace(/[^a-zA-Z0-9\s\-_.=/:,~@]/g, '').trim()
    if (sanitizedArgs) aiTool += ` ${sanitizedArgs}`
  }
  if (body.model) {
    aiTool += ` --model ${body.model}`
  }
  if (body.prompt) {
    const escapedPrompt = body.prompt.replace(/'/g, "'\\''")
    aiTool += ` -p '${escapedPrompt}'`
  }
  return aiTool
}

// Container paths reserved unconditionally — operator AND internal callers are
// both forbidden from declaring mounts here. /workspace is the operator's
// workingDirectory bind, owned by the docker run -v ${workDir}:/workspace flag.
export const ALWAYS_RESERVED_CONTAINER_PATH_ROOTS: readonly string[] = ['/workspace']

// Container paths AI Maestro itself mounts at docker-run time via the
// buildAmpCommonMounts + buildCloud{Claude,Gemini,Codex}* skeletons. mergeMounts
// is operator-wins on containerPath collision (line 973-976), so an operator-
// declared mount under any of these would shadow the system mount and destroy
// the agent's AMP identity / claude / gemini / codex state inside the container.
// Reservation rejects collisions at validation time before mergeMounts gets to
// silently swap them. Reservation matches the path EXACTLY or any descendant.
export const OPERATOR_RESERVED_CONTAINER_PATH_ROOTS: readonly string[] = [
  `${CONTAINER_HOME}/.agent-messaging`,  // AMP per-uuid state (buildAmpCommonMounts)
  `${CONTAINER_HOME}/.aimaestro`,        // AMP per-uuid state + chat-state
  `${CONTAINER_HOME}/.local`,            // shell-helpers, cli, .local/bin
  `${CONTAINER_HOME}/.claude`,           // settings, .credentials.json, projects
  `${CONTAINER_HOME}/.claude.json`,      // claude persist root config (file)
  `${CONTAINER_HOME}/.gemini`,           // settings, oauth, tmp/<project>
  `${CONTAINER_HOME}/.codex`,            // config.toml, version.json, auth.json
  `${CONTAINER_HOME}/.config/gh`,        // gh credentials
]

// Env keys AI Maestro itself sets per-container via baseEnv (createDockerAgent
// line ~1242, updateContainerMountsAndExtraEnv line ~1740) + buildAmpCommonEnv.
// mergeEnv is operator-wins on key collision (line 980-982), so operator-
// declared extraEnv with these keys would override agent identity (AGENT_ID,
// TMUX_SESSION_NAME, AI_TOOL, AIMAESTRO_HOST_URL) or AMP routing (AMP_*,
// CLAUDE_AGENT_*, PATH, GEMINI_CLI_TRUST_WORKSPACE) inside the container —
// every outbound AMP message becomes unverifiable.
//
// NOT reserved: HOME (legitimate operator override for Shape β agent-home),
// GITHUB_TOKEN (operator may want to set/rotate via extraEnv as an alternative
// to body.githubToken at create time).
export const OPERATOR_RESERVED_ENV_KEYS: readonly string[] = [
  'TMUX_SESSION_NAME',
  'AI_TOOL',
  'AGENT_ID',
  'AIMAESTRO_HOST_URL',
  'CLAUDE_AGENT_ID',
  'CLAUDE_AGENT_NAME',
  'AMP_AGENT_ID',
  'AMP_DIR',
  'AMP_MAESTRO_URL',
  'PATH',
  'GEMINI_CLI_TRUST_WORKSPACE',
]

function findReservedRoot(p: string, roots: readonly string[]): string | null {
  for (const r of roots) {
    if (p === r || p.startsWith(`${r}/`)) return r
  }
  return null
}

// Trusts the caller: sandbox.mounts is operator-declared today (e.g., agent
// creation by the dashboard or a host operator). If this ever becomes user-
// controlled (an agent mutating its own mounts, unprivileged operators), add
// realpath + prefix-check against an allow-list of host roots before shelling.
//
// `source` is a required discriminated value: 'operator' enables the
// OPERATOR_RESERVED_CONTAINER_PATH_ROOTS reservation check; 'system' skips
// it so internal system-mount builders' output can route through this
// validator for format/always-reserved checks without self-rejection. The
// required arg makes the safety contract structural — a missing or
// forgotten flag is a TypeScript error rather than a silent fail-open.
export function validateMounts(
  mounts: SandboxMount[] | undefined,
  source: 'operator' | 'system'
): string | null {
  if (!mounts) return null
  for (const [i, m] of mounts.entries()) {
    if (typeof m?.hostPath !== 'string' || typeof m?.containerPath !== 'string') {
      return `mounts[${i}]: hostPath and containerPath are required strings`
    }
    if (!m.hostPath.startsWith('/') || !m.containerPath.startsWith('/')) {
      return `mounts[${i}]: hostPath and containerPath must be absolute paths`
    }
    if (UNSAFE_PATH_CHARS.test(m.hostPath) || UNSAFE_PATH_CHARS.test(m.containerPath)) {
      return `mounts[${i}]: paths must not contain quotes, backticks, $, backslashes, or newlines`
    }
    const alwaysReserved = findReservedRoot(m.containerPath, ALWAYS_RESERVED_CONTAINER_PATH_ROOTS)
    if (alwaysReserved) {
      return `mounts[${i}]: containerPath "${m.containerPath}" is reserved (${alwaysReserved} is the agent working directory)`
    }
    if (source === 'operator') {
      const operatorReserved = findReservedRoot(m.containerPath, OPERATOR_RESERVED_CONTAINER_PATH_ROOTS)
      if (operatorReserved) {
        return `mounts[${i}]: containerPath "${m.containerPath}" is reserved by AI Maestro (matches "${operatorReserved}") — operator-declared mounts cannot shadow AMP common mounts or claude/gemini/codex state, these are managed automatically per-agent`
      }
    }
  }
  return null
}

// `source` is a required discriminated value: 'operator' enables the
// OPERATOR_RESERVED_ENV_KEYS reservation check; 'system' skips it so internal
// env builders (baseEnv, buildAmpCommonEnv output) can route through this
// validator for format checks without self-rejection. Required arg = a
// missing flag is a TypeScript error, not a silent fail-open.
export function validateExtraEnv(
  env: Record<string, string> | undefined,
  source: 'operator' | 'system'
): string | null {
  if (!env) return null
  for (const [key, value] of Object.entries(env)) {
    if (!ENV_KEY_RE.test(key)) {
      return `extraEnv: invalid key "${key}" — must match ${ENV_KEY_RE}`
    }
    if (typeof value !== 'string') {
      return `extraEnv["${key}"]: value must be a string`
    }
    if (UNSAFE_ENV_VALUE_CHARS.test(value)) {
      return `extraEnv["${key}"]: value must not contain quotes, backticks, $, backslashes, or newlines`
    }
    if (source === 'operator' && OPERATOR_RESERVED_ENV_KEYS.includes(key)) {
      return `extraEnv["${key}"]: key is reserved by AI Maestro — operator-declared extraEnv cannot shadow agent identity (AGENT_ID, TMUX_SESSION_NAME, AI_TOOL, AIMAESTRO_HOST_URL) or AMP routing (AMP_*, CLAUDE_AGENT_*, PATH, GEMINI_CLI_TRUST_WORKSPACE)`
    }
  }
  return null
}

export function buildMountFlags(mounts: SandboxMount[] | undefined): string[] {
  if (!mounts || mounts.length === 0) return []
  return mounts.map(m => {
    const suffix = m.readOnly ? ':ro' : ''
    return `-v "${m.hostPath}:${m.containerPath}${suffix}"`
  })
}

export function buildEnvFlags(env: Record<string, string> | undefined): string[] {
  if (!env) return []
  return Object.entries(env).map(([k, v]) => `-e ${k}="${v}"`)
}

// AMP common mounts wire the container so amp-helper.sh can resolve the agent's
// identity and find the AMP CLI on PATH. Without these, amp-helper falls back
// to the tmux session name and silently auto-creates a phantom empty identity
// with no signing key — every outbound message would be unverifiable.
//
// All three mounts are derived deterministically from the agent UUID, so they
// can be reproduced on container redeploy without operator input.
//
// Note: ~/.claude is intentionally NOT mounted wholesale — mounting the host
// operator's claude state into the container leaked host-absolute hook paths
// (every Stop/UserPromptSubmit fired MODULE_NOT_FOUND inside the container)
// and exposed the operator's full session history/projects/credentials read-
// write to the cloud agent. Per-container claude config is provisioned in
// provisionCloudClaudeConfig + buildCloudClaudeSettingsMount + buildCloudClaudePersistMounts.
export function buildAmpCommonMounts(
  agentId: string,
  hostHome: string = os.homedir(),
  repoRoot: string = process.cwd()
): SandboxMount[] {
  return [
    {
      hostPath: path.join(hostHome, '.agent-messaging', 'agents', agentId),
      containerPath: path.posix.join(CONTAINER_HOME, '.agent-messaging', 'agents', agentId),
    },
    {
      hostPath: path.join(hostHome, '.aimaestro', 'agents', agentId),
      containerPath: path.posix.join(CONTAINER_HOME, '.aimaestro', 'agents', agentId),
    },
    {
      hostPath: path.join(hostHome, '.local', 'bin'),
      containerPath: path.posix.join(CONTAINER_HOME, '.local', 'bin'),
      readOnly: true,
    },
    // Shared shell-helpers dir (host-wide, not per-agent) — agent-helper.sh
    // sources `${HOME}/.local/share/aimaestro/shell-helpers/common.sh` at
    // line ~50; without this mount, every cloud agent hits "common.sh not
    // found" the moment it touches aimaestro-agent.sh. RO because the helper
    // scripts are identity-of-host-side state, not per-agent. Filed as
    // kanban 9c40609b 2026-04-28 by CelestIA after Luke (allianceos) repro.
    {
      hostPath: path.join(hostHome, '.local', 'share', 'aimaestro', 'shell-helpers'),
      containerPath: path.posix.join(CONTAINER_HOME, '.local', 'share', 'aimaestro', 'shell-helpers'),
      readOnly: true,
    },
    // Repo scripts dir (host-wide, RO) — exposes meeting-send.sh /
    // meeting-task.sh / meeting-read.sh + other operator CLIs to cloud agents
    // so they can participate in the team kanban + meeting flows from inside
    // the container. Without this, only meeting-send.sh worked (manually
    // installed in some operators' ~/.local/bin/) and meeting-task.sh was
    // universally absent fleet-wide (Optic + Hardin + cross-host empirical
    // 2026-05-06). The bind mount targets a known container path that gets
    // prepended to CONTAINER_PATH below — sister pattern to the shell-helpers
    // mount above. Sister to PR #98 / kanban 9c40609b.
    //
    // repoRoot defaults to process.cwd() (matches provisionCloudClaudeConfig
    // signature) — Next.js bundling moves __dirname into .next/server/...
    // so __dirname-relative paths break in production. The maestro server
    // always runs from the repo root, so process.cwd() is the canonical anchor.
    {
      hostPath: path.join(repoRoot, 'scripts'),
      containerPath: path.posix.join(CONTAINER_HOME, '.local', 'share', 'aimaestro', 'cli'),
      readOnly: true,
    },
  ]
}

// Copy a host-operator-owned source file into a per-agent destination path,
// preserving the operator's authentication state into the new agent's
// per-UUID dir. Used by the auth-bootstrap path (kanbans 354a5174 codex +
// 8aa61a60 claude) so freshly-created cloud agents inherit a valid login on
// first launch instead of forcing the operator through an in-container OAuth
// dance per agent.
//
// Returns true on a successful copy, false on any reason the seed didn't
// happen (dest already populated with real content — preserve existing
// per-agent rotation state; source missing — operator hasn't run the
// relevant `<cli> login` yet; copy failed — perm error logged non-fatal).
// Caller decides whether to fall back to an empty seed.
//
// Empty-placeholder semantics (kanban 02a8ebda): if the dest exists but
// holds only an empty seed (`{}` / `{}\n` / empty string), treat it as
// "not yet bootstrapped" and proceed with the host copy. Without this,
// agents created BEFORE the operator ran `<cli> login` would carry their
// `{}` placeholder forward across /recreate (migrateAgentPersistence copies
// it; this guard then short-circuited the re-bootstrap), forcing operators
// to manually `rm` the per-agent file before recreate. Watson surfaced
// during PR #103 Mason cross-test 2026-05-01.
//
// Mode 0o600 on the destination matches the source's typical perms (CLI
// credential files are operator-private). Per-agent file is written into
// ~/.aimaestro/agents/<id>/, isolated from the host operator's tree —
// future writes by the in-container CLI go to the per-agent file via the
// bind mount, not back to the host source.
export function seedFromHostFile(hostSourcePath: string, perAgentDestPath: string): boolean {
  if (fs.existsSync(perAgentDestPath) && !isEmptyJsonSeed(perAgentDestPath)) return false
  if (!fs.existsSync(hostSourcePath)) return false
  try {
    fs.copyFileSync(hostSourcePath, perAgentDestPath)
    fs.chmodSync(perAgentDestPath, 0o600)
    return true
  } catch (err) {
    console.warn(`[seedFromHostFile] copy ${hostSourcePath} -> ${perAgentDestPath}:`, err instanceof Error ? err.message : err)
    return false
  }
}

// Detect the empty-placeholder content that provisionCloudClaudeConfig +
// provisionCloudCodexAuth write when the host has no credentials yet
// (`{}\n` or an empty file). Used by seedFromHostFile to tell apart
// "intentionally empty placeholder, please re-bootstrap" from "operator's
// real rotated credentials, do not overwrite". Read failures fall through
// as "not empty" (conservative — preserve unknown content).
function isEmptyJsonSeed(filePath: string): boolean {
  try {
    const trimmed = fs.readFileSync(filePath, 'utf8').trim()
    return trimmed === '' || trimmed === '{}'
  } catch {
    return false
  }
}

// Provision per-container Claude Code config: copies the hook script and
// writes a settings.json into the agent's per-UUID dir, with hook paths
// pointing at the container-side mount of that hook script. Also seeds the
// per-agent persistence files (claude-home.json, claude-credentials.json,
// gh-config/) so they exist before docker create — otherwise Docker
// auto-creates them as root-owned dirs at the bind-mount targets, blocking
// the in-container claude user from writing them.
//
// The hook script is snapshotted into the per-UUID dir at create time so
// each cloud agent has a stable, independent copy. To refresh, re-run the
// agent-create flow.
export function provisionCloudClaudeConfig(
  agentId: string,
  hostHome: string = os.homedir(),
  repoRoot: string = process.cwd()
): { settingsPath: string; hookPath: string } {
  const sourceHook = path.join(repoRoot, 'scripts', 'claude-hooks', 'ai-maestro-hook.cjs')
  const agentDir = path.join(hostHome, '.aimaestro', 'agents', agentId)
  fs.mkdirSync(agentDir, { recursive: true })

  const hookPath = path.join(agentDir, 'claude-hook.cjs')
  fs.copyFileSync(sourceHook, hookPath)
  fs.chmodSync(hookPath, 0o755)

  const settingsPath = path.join(agentDir, 'claude-settings.json')
  const containerHook = path.posix.join(
    CONTAINER_HOME, '.aimaestro', 'agents', agentId, 'claude-hook.cjs'
  )
  // Pre-accept the --dangerously-skip-permissions warning prompt for the cloud
  // agent. Without this, claude-code re-shows the "Yes, I accept" warning on
  // EVERY container start when launched with --dangerously-skip-permissions,
  // because the container is treated as a fresh machine and there's no
  // persisted accept state. The accept-state field is `skipDangerousModePermissionPrompt`
  // (verified: 9 occurrences in the claude binary; confirmed by official
  // claude.ai docs guidance for containerized claude). Cloud-agent containers
  // are the documented "isolated environment" use case for bypass-permissions
  // mode — the docs explicitly endorse pre-accepting it for containers.
  // Combined with the RW mount below, this also lets claude write OTHER
  // settings.json keys (allowedTools, model preferences) and have them
  // persist across the container's lifetime.
  // statusLine: Claude Code renders the configured command's stdout as the
  // 2-line status block between the prompt and the tmux status bar (agent
  // identity + unread count on line 1, model + ctx% + cost on line 2). Host
  // agents have this wired via the operator's ~/.claude/settings.json. Cloud
  // agents had a blank where this block sits because the seeded settings.json
  // omitted statusLine — host/cloud UX-parity gap (kanban 172e170d). Ships
  // amp-statusline.sh via the existing scripts/ bind mount at
  // /home/claude/.local/share/aimaestro/cli/ (buildAmpCommonMounts line ~178,
  // sister to meeting-send.sh / meeting-task.sh shipping pattern from 0d80aed7).
  // Container env (buildAmpCommonEnv) exposes AMP_AGENT_ID so the script's
  // priority-1 resolution fires without needing the host-side .index.json
  // (not mounted per-agent).
  const settings = {
    skipDangerousModePermissionPrompt: true,
    statusLine: {
      type: 'command',
      command: '/home/claude/.local/share/aimaestro/cli/amp-statusline.sh',
    },
    hooks: {
      Notification: [
        {
          matcher: 'idle_prompt|permission_prompt',
          hooks: [{ type: 'command', command: `node ${containerHook}`, timeout: 5 }],
        },
      ],
      Stop: [{ hooks: [{ type: 'command', command: `node ${containerHook}`, timeout: 5 }] }],
      SessionStart: [{ hooks: [{ type: 'command', command: `node ${containerHook}`, timeout: 5 }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: `node ${containerHook}`, timeout: 30 }] }],
    },
  }
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2), { mode: 0o600 })

  // Seed per-agent persistence files with valid contents. Docker file-level
  // bind mounts require the host source to exist as a file (not a directory)
  // before container create; otherwise Docker materializes the target as a
  // directory and the application errors.
  //
  // claude-home.json (mounts to /home/claude/.claude.json) is seeded with
  // theme="dark" to skip the theme picker on first launch — without it, fresh
  // cloud agents land on the picker and the on-wake hook gets typed into a
  // menu (kanban 41dd54b9). Other claude-home fields are written by claude on
  // first run / login.
  //
  // Shape-aware merge (kanban 406ff85d, sister to PR #112's gemini fix):
  // when migrateAgentPersistence carries forward a predecessor claude-home.json
  // that pre-dates the theme=dark seed (kanban 41dd54b9), the bare existsSync
  // guard short-circuited and the seed never re-applied — Holmes empirical
  // 2026-05-06 (Watson Hale post-recreate finding). Now we read existing
  // contents, inject `theme: "dark"` only if missing, preserve everything
  // else the operator may have set (model preferences, hand-edits).
  // Operator-set theme (any string) is preserved — claude supports multiple
  // themes (dark, light, dark-daltonized, etc.) and operator choice wins.
  const claudeHomePath = path.join(agentDir, 'claude-home.json')
  let claudeHomeNeedWrite = !fs.existsSync(claudeHomePath)
  let claudeHome: Record<string, unknown>
  if (claudeHomeNeedWrite) {
    claudeHome = { theme: 'dark' }
  } else {
    try {
      claudeHome = JSON.parse(fs.readFileSync(claudeHomePath, 'utf8'))
      if (typeof claudeHome.theme !== 'string') {
        // Stale-shape signal: migrated pre-kanban-41dd54b9 claude-home lacks
        // the theme selector. Inject just the missing piece.
        claudeHome = { ...claudeHome, theme: 'dark' }
        claudeHomeNeedWrite = true
      }
    } catch (err) {
      console.warn(
        `[provisionCloudClaudeConfig] unparseable claude-home.json at ${claudeHomePath} — re-seeding from scratch:`,
        err instanceof Error ? err.message : err,
      )
      claudeHome = { theme: 'dark' }
      claudeHomeNeedWrite = true
    }
  }
  if (claudeHomeNeedWrite) {
    fs.writeFileSync(claudeHomePath, JSON.stringify(claudeHome) + '\n', { mode: 0o600 })
  }
  // claude-credentials.json (OAuth tokens) — operator-driven bootstrap
  // (kanban 8aa61a60). At provision time, copy the host operator's
  // ~/.claude/.credentials.json into the per-agent dir, so the fresh agent
  // inherits a valid auth on first launch and skips the browser sign-in
  // dance. Operator runs `claude /login` once on the host, every future
  // cloud-agent create inherits. After bootstrap, each agent's claude
  // rewrites this file on its own refresh cycle — per-agent isolation
  // (independent rotation, isolated revoke radius) is preserved.
  //
  // Falls back to '{}' if the host has no credentials yet (first-time
  // setup case) AND no migrated predecessor file is present.
  //
  // seedFromHostFile fully owns dest-existence semantics (kanban 02a8ebda
  // + Watson Mason post-#104 finding): real rotated creds at dest are
  // preserved, but an empty `{}` placeholder migrated forward from a
  // pre-bootstrap predecessor IS re-seeded from the (now-populated) host
  // source. This restores the post-hoc-host-login → recreate propagation
  // path that the previous outer existsSync guard short-circuited.
  //
  // Shane's preference was "single shared host file mounted into all
  // containers"; chose per-agent-copy override per his explicit invitation
  // to override if isolation makes more sense — same shape as PR #96 +
  // codex-auth.json (kanban 354a5174) for protocol consistency.
  const claudeCredsPath = path.join(agentDir, 'claude-credentials.json')
  if (!seedFromHostFile(path.join(hostHome, '.claude', '.credentials.json'), claudeCredsPath)) {
    if (!fs.existsSync(claudeCredsPath)) {
      fs.writeFileSync(claudeCredsPath, '{}\n', { mode: 0o600 })
    }
  }
  // gh stores config in a directory (config.yml, hosts.yml). Just ensure the
  // dir exists; gh creates its own files on first `gh auth login`.
  const ghConfigDir = path.join(agentDir, 'gh-config')
  fs.mkdirSync(ghConfigDir, { recursive: true, mode: 0o700 })

  return { settingsPath, hookPath }
}

// File-level bind mount that overlays the per-container settings.json onto
// /home/claude/.claude/settings.json without exposing the rest of the host's
// ~/.claude tree. Mount target's parent (/home/claude/.claude) must pre-exist
// in the image as claude-owned — see agent-container/Dockerfile — otherwise
// Docker auto-creates it as root and blocks claude from writing siblings.
//
// RW (was RO before v0.30.37): claude-code writes settings.json on a few
// flows — notably the --dangerously-skip-permissions accept (sets
// skipDangerousModePermissionPrompt) but also allowedTools and model
// preferences. With a RO mount, those writes silently fail and the bypass
// warning re-prompts on every container start. Provisioning seeds
// skipDangerousModePermissionPrompt: true upfront so the prompt never fires
// in the first place; RW lets any subsequent claude writes also persist.
// Per-agent isolation is unchanged — host's own ~/.claude/settings.json is
// never touched.
export function buildCloudClaudeSettingsMount(
  agentId: string,
  hostHome: string = os.homedir()
): SandboxMount {
  return {
    hostPath: path.join(hostHome, '.aimaestro', 'agents', agentId, 'claude-settings.json'),
    containerPath: path.posix.join(CONTAINER_HOME, '.claude', 'settings.json'),
  }
}

// Provision per-container Gemini CLI config: writes a settings.json into the
// agent's per-UUID dir that suppresses the gemini self-update fetch on
// container start AND pre-selects the operator's OAuth personal auth method.
// The trust-folder dialog is handled separately by the
// GEMINI_CLI_TRUST_WORKSPACE=true env (set in buildAmpCommonEnv) — that path
// is the gemini-supported in-binary fast path that returns isTrusted=true
// without a file lookup, see @google/gemini-cli util/trust.ts checkPathTrust.
//
// Without enableAutoUpdate=false, freshly-recreated gemini cloud agents show
// "✕ Automatic update failed. Please try updating manually." on every cold
// launch (the in-container env can't reach npm to self-update). The error
// itself is non-blocking but adds modal noise above the on-wake prompt and
// confuses operators reading the pane (kanban cd2d7377).
//
// Without security.auth.selectedType="oauth-personal", gemini falls through
// to "Please set an Auth method in your /home/claude/.gemini/settings.json
// or specify one of the following environment variables before running:
// GEMINI_API_KEY, GOOGLE_GENAI_USE_VERTEXAI, GOOGLE_GENAI_USE_GCA" on every
// launch — even when oauth_creds.json is present. Setting selectedType is
// what tells gemini "use the OAuth path" and consume oauth_creds.json. The
// canonical "oauth-personal" string is verified in @google/gemini-cli
// bundle (8 occurrences across chunk-EA775AOR, chunk-GOUPAQ35, etc.) and
// matches the value the gemini interactive auth-picker writes when an
// operator selects "Login with Google" (kanban 1f911653 Hardin empirical
// 2026-05-01: oauth_creds bootstrap alone was necessary-but-not-sufficient).
//
// Per-agent isolation: the seed file lives under ~/.aimaestro/agents/<id>/,
// bind-mounted RW at /home/claude/.gemini/settings.json by
// buildCloudGeminiSettingsMount. Host operator's ~/.gemini is never touched.
//
// Shape-aware staleness detection (kanban 61aac9db, Watson Mason empirical
// 2026-05-02): on /recreate of a pre-PR-#108 cloud agent, migrateAgentPersistence
// carries the predecessor's stale-shape gemini-settings.json forward into the
// new UUID dir BEFORE this function runs. The previous `if (!existsSync) seed`
// guard saw the file present and short-circuited, leaving the migrated stale
// shape (no security.auth.selectedType) in place. Result: gemini in the
// recreated container fell through to the auth picker even though oauth_creds
// was correctly bootstrapped, because settings.json told gemini "no auth path
// selected". Sister-class to PR #104 empty-{} re-bootstrap but with a
// "missing field within otherwise-valid JSON" signal instead of "empty
// placeholder" — so we minimal-merge (inject just the missing field, preserve
// every other operator hand-edit) rather than full-re-seed. This respects
// PR #102's "preserves existing content across re-runs (operator hand-edit
// intent)" contract.
//
// Unparseable JSON falls through to a fresh seed (same-shape as no-file).
// Logged so production traces capture the rare event if it ever fires.
export function provisionCloudGeminiConfig(
  agentId: string,
  hostHome: string = os.homedir()
): { settingsPath: string } {
  const agentDir = path.join(hostHome, '.aimaestro', 'agents', agentId)
  fs.mkdirSync(agentDir, { recursive: true })
  const settingsPath = path.join(agentDir, 'gemini-settings.json')

  let needWrite = !fs.existsSync(settingsPath)
  let settings: Record<string, unknown>
  if (needWrite) {
    settings = {
      general: { enableAutoUpdate: false },
      security: { auth: { selectedType: 'oauth-personal' } },
    }
  } else {
    try {
      settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
      // Defensive: tolerate operator/legacy garbage where security or
      // security.auth is set to a non-object (string, number, null). Without
      // this, the spread `{...security}` would inline string indices into the
      // result and break gemini's settings reader (Watson polish note).
      const securityRaw = settings.security
      const security: Record<string, unknown> =
        securityRaw && typeof securityRaw === 'object' && !Array.isArray(securityRaw)
          ? (securityRaw as Record<string, unknown>)
          : {}
      const authRaw = security.auth
      const auth: Record<string, unknown> =
        authRaw && typeof authRaw === 'object' && !Array.isArray(authRaw)
          ? (authRaw as Record<string, unknown>)
          : {}
      if (typeof auth.selectedType !== 'string') {
        // Stale-shape signal: migrated pre-PR-#108 settings lacks the auth
        // selector. Inject just the missing piece; preserve everything else
        // the operator may have set (mcp servers, custom keys, hand-edits).
        // Operator-set selectedType (any string) is preserved — gemini supports
        // multiple AuthType values besides "oauth-personal" (gemini-api-key,
        // vertex-ai, cloud-shell, LOGIN_WITH_GOOGLE) and operator choice wins.
        settings.security = { ...security, auth: { ...auth, selectedType: 'oauth-personal' } }
        needWrite = true
      }
    } catch (err) {
      console.warn(
        `[provisionCloudGeminiConfig] unparseable settings.json at ${settingsPath} — re-seeding from scratch:`,
        err instanceof Error ? err.message : err,
      )
      settings = {
        general: { enableAutoUpdate: false },
        security: { auth: { selectedType: 'oauth-personal' } },
      }
      needWrite = true
    }
  }
  if (needWrite) {
    fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 })
  }
  return { settingsPath }
}

// File-level bind mount for the per-agent gemini settings.json. Mount target
// parent (/home/claude/.gemini) must pre-exist in the image as claude-owned
// — see agent-container/Dockerfile — otherwise Docker auto-creates it as
// root and blocks gemini from writing siblings (history, sessions, oauth).
//
// RW: gemini may write back to settings.json on /settings UI flows. Per-agent
// isolation is unchanged — host's own ~/.gemini/settings.json is never touched.
// Mount is harmless for non-gemini programs (claude/codex ignore the path).
export function buildCloudGeminiSettingsMount(
  agentId: string,
  hostHome: string = os.homedir()
): SandboxMount {
  return {
    hostPath: path.join(hostHome, '.aimaestro', 'agents', agentId, 'gemini-settings.json'),
    containerPath: path.posix.join(CONTAINER_HOME, '.gemini', 'settings.json'),
  }
}

// Provision per-container Codex CLI config: writes a version.json + a
// config.toml into the agent's per-UUID dir to suppress two distinct
// first-launch blockers:
//
// 1. version.json — pre-dismisses the "Update available!" modal that codex
//    auto-checks on every interactive launch. Without this seed, the modal
//    eats the head of the on-wake hook (verified on R2D2 2026-04-30 after
//    codex 0.128.0 dropped — first 25 chars silently consumed; kanban
//    22f4af86). FIRST_RUN_MODAL_PATTERN doesn't match codex Update-available.
//    Strategy: dismissed_version sentinel "999.0.0" + last_checked_at far in
//    the future. Suppresses re-check loops indefinitely until codex tags
//    >= 999.0.0 (then bump this seed).
//
// 2. config.toml — pre-trusts /workspace so codex skips its
//    "Do you trust the contents of this directory?" modal on first launch
//    (kanban 354a5174 trust-modal sibling, surfaced empirically tonight).
//    /workspace is the per-agent operator-declared working directory —
//    cloud agents are sandboxed to that mount only, so trust is the safe
//    default. Codex's config.toml schema accepts per-project trust_level
//    blocks; "trusted" is the documented value.
//
// Per-agent isolation: both files live under ~/.aimaestro/agents/<id>/,
// bind-mounted RW at /home/claude/.codex/version.json + config.toml by
// the corresponding mount builders. Host operator's ~/.codex is never
// touched.
export function provisionCloudCodexConfig(
  agentId: string,
  hostHome: string = os.homedir()
): { versionPath: string; configTomlPath: string; hooksPath: string } {
  const agentDir = path.join(hostHome, '.aimaestro', 'agents', agentId)
  fs.mkdirSync(agentDir, { recursive: true })
  const versionPath = path.join(agentDir, 'codex-version.json')
  if (!fs.existsSync(versionPath)) {
    const versionState = {
      latest_version: '999.0.0',
      last_checked_at: '2099-01-01T00:00:00.000Z',
      dismissed_version: '999.0.0',
    }
    fs.writeFileSync(versionPath, JSON.stringify(versionState) + '\n', { mode: 0o600 })
  }
  const configTomlPath = path.join(agentDir, 'codex-config.toml')
  if (!fs.existsSync(configTomlPath)) {
    const configToml =
      '[projects."/workspace"]\n' +
      'trust_level = "trusted"\n'
    fs.writeFileSync(configTomlPath, configToml, { mode: 0o600 })
  }
  const hooksPath = path.join(agentDir, 'codex-hooks.json')
  if (!fs.existsSync(hooksPath)) {
    fs.writeFileSync(hooksPath, '{}\n', { mode: 0o600 })
  }
  return { versionPath, configTomlPath, hooksPath }
}

// File-level bind mount for the per-agent codex config.toml. Mount target
// parent (/home/claude/.codex) is pre-created in agent-container/Dockerfile.
//
// RW: codex rewrites config.toml when the operator runs /config or similar
// in-CLI commands. Per-agent isolation unchanged.
export function buildCloudCodexConfigTomlMount(
  agentId: string,
  hostHome: string = os.homedir()
): SandboxMount {
  return {
    hostPath: path.join(hostHome, '.aimaestro', 'agents', agentId, 'codex-config.toml'),
    containerPath: path.posix.join(CONTAINER_HOME, '.codex', 'config.toml'),
  }
}

// File-level bind mount for the per-agent codex hooks.json. Mount target
// parent (/home/claude/.codex) is pre-created in agent-container/Dockerfile
// alongside config.toml + auth.json.
//
// Codex reads hook definitions from ~/.codex/hooks.json at session start
// (verified against developers.openai.com/codex/hooks 2026-05-27). Schema:
// { "hooks": { "<EventName>": [ { "hooks": [ { "type": "command", "command": "..." } ] } ] } }
//
// RW: codex itself doesn't rewrite hooks.json today, but the operator (or
// a future ai-maestro helper) may edit it from inside the container; RW
// keeps that path open and matches the config.toml mount mode.
//
// Default skeleton is "{}" — no hooks active. Operators wiring a
// UserPromptSubmit recall hook (e.g., Ziggy memory injection) populate
// this file post-create. Per-agent isolation unchanged.
export function buildCloudCodexHooksMount(
  agentId: string,
  hostHome: string = os.homedir()
): SandboxMount {
  return {
    hostPath: path.join(hostHome, '.aimaestro', 'agents', agentId, 'codex-hooks.json'),
    containerPath: path.posix.join(CONTAINER_HOME, '.codex', 'hooks.json'),
  }
}

// File-level bind mount for the per-agent codex version.json. Mount target
// parent (/home/claude/.codex) must pre-exist in the image as claude-owned
// — see agent-container/Dockerfile — otherwise Docker auto-creates it as
// root and blocks codex from writing siblings (auth, sessions, history).
//
// RW: codex rewrites version.json on every update-check refresh. Per-agent
// isolation unchanged. Mount is harmless for non-codex programs.
export function buildCloudCodexVersionMount(
  agentId: string,
  hostHome: string = os.homedir()
): SandboxMount {
  return {
    hostPath: path.join(hostHome, '.aimaestro', 'agents', agentId, 'codex-version.json'),
    containerPath: path.posix.join(CONTAINER_HOME, '.codex', 'version.json'),
  }
}

// Provision per-container Codex CLI auth: at agent-create time, copy the
// host operator's ~/.codex/auth.json into the per-agent dir so the fresh
// cloud agent inherits a valid OpenAI/ChatGPT login and skips the
// "Welcome to Codex / Sign in" picker on first launch (kanban 354a5174,
// Option A operator-driven Device Code per Shane 2026-05-01).
//
// Operator workflow: run `codex login` once on the host, every subsequent
// cloud-agent create inherits the credentials. Codex rewrites auth.json on
// its own refresh cycle (token rotation, re-login), and those writes go to
// the per-agent file via the bind mount — never back to the host source —
// so per-agent rotation is independent + revoke radius is per-agent.
//
// If the host has no auth.json yet (first-time setup) AND no migrated
// predecessor file is present, seed empty {}. Codex will then show its
// sign-in picker on first launch in the container, matching pre-PR
// behavior. seedFromHostFile fully owns dest-existence semantics — see
// the function docstring for the empty-{}-re-seed contract that lets
// post-hoc host login propagate via /recreate (Watson Mason post-#104
// finding, kanban 02a8ebda follow-up).
export function provisionCloudCodexAuth(
  agentId: string,
  hostHome: string = os.homedir()
): { authPath: string; bootstrapped: boolean } {
  const agentDir = path.join(hostHome, '.aimaestro', 'agents', agentId)
  fs.mkdirSync(agentDir, { recursive: true })
  const authPath = path.join(agentDir, 'codex-auth.json')
  const bootstrapped = seedFromHostFile(
    path.join(hostHome, '.codex', 'auth.json'),
    authPath,
  )
  if (!bootstrapped && !fs.existsSync(authPath)) {
    fs.writeFileSync(authPath, '{}\n', { mode: 0o600 })
  }
  return { authPath, bootstrapped }
}

// File-level bind mount for the per-agent codex auth.json. Mount target
// parent (/home/claude/.codex) is pre-created in agent-container/Dockerfile
// alongside the .gemini sibling.
//
// RW: codex writes auth.json on token refresh + re-login. Per-agent
// isolation unchanged — host operator's ~/.codex/auth.json is read at
// provision time and never touched again.
export function buildCloudCodexAuthMount(
  agentId: string,
  hostHome: string = os.homedir()
): SandboxMount {
  return {
    hostPath: path.join(hostHome, '.aimaestro', 'agents', agentId, 'codex-auth.json'),
    containerPath: path.posix.join(CONTAINER_HOME, '.codex', 'auth.json'),
  }
}

// Provision per-container Gemini CLI auth: at agent-create time, copy the
// host operator's ~/.gemini/oauth_creds.json into the per-agent dir so the
// fresh cloud agent inherits a valid Google OAuth login and skips the
// "Please set an Auth method" picker on first launch (kanban 1f911653,
// sibling to PR #103 codex Device Code + claude OAuth — three programs,
// one Option A operator-driven shape).
//
// Operator workflow: run `gemini` once on the host and complete the OAuth
// flow, every subsequent cloud-agent create inherits the credentials.
// Gemini rewrites oauth_creds.json on its own refresh cycle (token
// rotation, re-login), and those writes go to the per-agent file via the
// bind mount — never back to the host source — so per-agent rotation is
// independent + revoke radius is per-agent.
//
// If the host has no oauth_creds.json yet (first-time setup) AND no
// migrated predecessor file is present, seed empty {}. Gemini will then
// show its auth picker on first launch in the container, matching pre-PR
// behavior. seedFromHostFile fully owns dest-existence semantics — see
// the function docstring for the empty-{}-re-seed contract that lets
// post-hoc host login propagate via /recreate (kanban 02a8ebda
// + Watson Mason finding from PR #105).
//
// Refresh-token tradeoff: same as codex-auth + claude-credentials — once
// the per-agent copy diverges from the host source via in-container
// rotation, host refresh-token rotations no longer propagate (the per-
// agent file is now the live source). Accepted as the consistent shape
// across all three programs; revoke is per-agent.
export function provisionCloudGeminiAuth(
  agentId: string,
  hostHome: string = os.homedir()
): { authPath: string; bootstrapped: boolean } {
  const agentDir = path.join(hostHome, '.aimaestro', 'agents', agentId)
  fs.mkdirSync(agentDir, { recursive: true })
  const authPath = path.join(agentDir, 'gemini-oauth-creds.json')
  const bootstrapped = seedFromHostFile(
    path.join(hostHome, '.gemini', 'oauth_creds.json'),
    authPath,
  )
  if (!bootstrapped && !fs.existsSync(authPath)) {
    fs.writeFileSync(authPath, '{}\n', { mode: 0o600 })
  }
  return { authPath, bootstrapped }
}

// File-level bind mount for the per-agent gemini oauth_creds.json. Mount
// target parent (/home/claude/.gemini) is pre-created in agent-container/
// Dockerfile alongside the .codex sibling.
//
// RW: gemini writes oauth_creds.json on token refresh + re-login. Per-
// agent isolation unchanged — host operator's ~/.gemini/oauth_creds.json
// is read at provision time and never touched again.
export function buildCloudGeminiOAuthMount(
  agentId: string,
  hostHome: string = os.homedir()
): SandboxMount {
  return {
    hostPath: path.join(hostHome, '.aimaestro', 'agents', agentId, 'gemini-oauth-creds.json'),
    containerPath: path.posix.join(CONTAINER_HOME, '.gemini', 'oauth_creds.json'),
  }
}

// Single-dir bind mount (OPT-B, kanban 49cc27d7) for Antigravity CLI (`agy`)
// app-data. agy stores conversations + auth + settings + brain/knowledge/
// implicit state under ~/.gemini/antigravity-cli/ — coexists with
// gemini-cli's tree but in a separate subdir owned by a different vendor
// (Codeium). Single mount over the entire dir intentionally:
//
//   - Inode-safe under OAuth token refresh. agy's antigravity-oauth-token
//     rotates atomically via temp+rename; file-level bind mounts (as used
//     for gemini oauth_creds.json) would stale silently on rename. Dir-mount
//     survives because the rename happens INSIDE the bind-mount surface.
//     See [[feedback_docker_file_mount_inode]].
//
//   - Insulates against future agy-internal-layout drift. v1.0.1 is brand-new
//     and the on-disk layout under antigravity-cli/ will shift in early
//     releases — single dir-mount captures whatever shape the binary writes
//     without per-file plumbing churn.
//
//   - No provisioning hook today. agy's settings.json starts empty/76B and
//     conversations/ starts empty. Add provisionCloudAntigravityConfig only
//     when a real seed need surfaces (e.g., agy ships an auto-update we want
//     to suppress, sibling to provisionCloudGeminiConfig's enableAutoUpdate
//     seed).
//
//   - Operator-reserved-path coverage: CONTAINER_HOME/.gemini already
//     blocks operator-declared mounts under .gemini/ (line 86), so this
//     mount's containerPath descends from a reserved root automatically.
//     No new entry needed in OPERATOR_RESERVED_CONTAINER_PATH_ROOTS.
export function buildCloudAntigravityAppDataMount(
  agentId: string,
  hostHome: string = os.homedir()
): SandboxMount {
  return {
    hostPath: path.join(hostHome, '.aimaestro', 'agents', agentId, 'antigravity-app-data'),
    containerPath: path.posix.join(CONTAINER_HOME, '.gemini', 'antigravity-cli'),
  }
}

// ─── Ziggy MCP integration (sandbox.ziggy=true) ──────────────────────────
//
// Mounts + provisioning that wire a cloud agent to reach the host's Ziggy MCP
// server. Gate: agent.deployment.sandbox.ziggy === true. Composed at create
// time and on every /update-runtime so /recreate is naturally idempotent.
//
// Design summary (Hutch + Watson 2026-05-27, kanban TBD):
//
//   - Codex (or any MCP-aware program) spawns the Ziggy MCP server as a STDIO
//     subprocess via [mcp_servers.ziggy] in ~/.codex/config.toml. The command
//     points at `/home/gosub/code/ziggy/apps/mcp-server/bin/start.sh` — the
//     same script Rollie (host agent) uses today.
//
//   - The MCP server reads creds + workspace routing from
//     /home/gosub/code/ziggy/.env. That host file is currently Rollie-flavored
//     (DATABASE_URL points at the rollie-specific Postgres DB on port 5434),
//     so we OVERLAY a per-agent .env at the same in-container path. Docker
//     file-bind shadows the underlying file from Mount A; start.sh sources
//     the overlay and has no awareness of the host's Rollie defaults.
//
//   - The MCP server connects to Postgres via the docker bridge network
//     `ziggy_default` where `ziggy-postgres` resolves by service name. That
//     requires the agent container to attach to the network (--network
//     ziggy_default in dockerCmd composition).
//
// Operator pre-flight: /opt/stacks/ai-maestro/agent-envs/<agent-name>.env must
// exist on host with at least ZIGGY_PROFILE and DATABASE_URL. ai-maestro
// REFUSES to start the container if missing (silent-empty-mount creation was
// the codex-auth.json bug Shane hit at create time; not repeating it).

// Network name used by docker compose for the Ziggy stack (ziggy-web +
// ziggy-postgres). Verified live 2026-05-27 — bridge driver, 172.19.0.0/16.
export const ZIGGY_NETWORK = 'ziggy_default'

// Host path where the Ziggy repo lives. start.sh derives ZIGGY_ROOT from its
// own location, so the in-container path MUST match the host path verbatim
// (no `/opt/ziggy-mcp` remap). Bind-mount source AND target use this path.
export const ZIGGY_CODE_PATH = '/home/gosub/code/ziggy'

// Directory on host where ai-maestro looks for per-agent .env overlay files.
// One file per agent, named `<agent.name>.env` (agent.name is already a slug
// matching `^[a-zA-Z0-9_-]+$` so it's safe in a filesystem path without
// further escaping). Owner: operator (Shane / Hutch). ai-maestro never
// writes to this directory — only reads at update-runtime/create time to
// verify the file exists before adding the overlay mount.
//
// Operator note on RENAMES: the env file is keyed on agent.name, NOT
// agent.id. If an agent is renamed, the operator must rename the env file
// to match — the next /update-runtime or /recreate will loud-fail with a
// clear error message until they do. Intentional: keying on the operator-
// readable name keeps the env files discoverable and the loud-fail catches
// the missed rename immediately rather than silently sourcing an empty
// overlay. Per Hutch ops review PR #157.
export const ZIGGY_AGENT_ENVS_DIR = '/opt/stacks/ai-maestro/agent-envs'

// Read-only bind of the Ziggy repo into the container at the same absolute
// path as on host. start.sh expects to find apps/mcp-server siblings (..bin,
// ../src, ../node_modules, ../../.env). Read-only: agents never mutate the
// shared Ziggy source.
export function buildZiggyCodeMount(): SandboxMount {
  return {
    hostPath: ZIGGY_CODE_PATH,
    containerPath: ZIGGY_CODE_PATH,
    readOnly: true,
  }
}

// Per-agent .env overlay. Source: /opt/stacks/ai-maestro/agent-envs/<name>.env.
// Target: ${ZIGGY_CODE_PATH}/.env (shadows the host file from buildZiggyCodeMount
// for this container only). Read-only — start.sh only sources it.
export function buildZiggyEnvOverlayMount(agentName: string): SandboxMount {
  return {
    hostPath: path.join(ZIGGY_AGENT_ENVS_DIR, `${agentName}.env`),
    containerPath: path.posix.join(ZIGGY_CODE_PATH, '.env'),
    readOnly: true,
  }
}

// Append a [mcp_servers.ziggy] block to the per-agent codex config.toml if
// not already present. Idempotent — safe to call on every recreate /
// update-runtime. The block uses STDIO transport per
// developers.openai.com/codex/mcp (verified 2026-05-27):
//
//   [mcp_servers.ziggy]
//   command = "<ZIGGY_CODE_PATH>/apps/mcp-server/bin/start.sh"
//
// ZIGGY_PROFILE + DATABASE_URL come from the overlay-mounted .env, NOT from
// codex's [mcp_servers.ziggy].env — start.sh's `set -a` env-loop would
// clobber any env var we pass via Codex anyway. Centralizing all env in the
// overlay .env is the cleaner single-source.
export function provisionCloudCodexZiggyMcpEntry(
  agentId: string,
  hostHome: string = os.homedir()
): { configTomlPath: string; mcpBlockAdded: boolean } {
  const configTomlPath = path.join(
    hostHome,
    '.aimaestro',
    'agents',
    agentId,
    'codex-config.toml',
  )
  // provisionCloudCodexConfig must have run first (it creates the file with
  // the [projects."/workspace"] trust block). If absent, write a minimal
  // file containing only the MCP block — codex tolerates missing trust block.
  let existing = ''
  if (fs.existsSync(configTomlPath)) {
    existing = fs.readFileSync(configTomlPath, 'utf-8')
    if (existing.includes('[mcp_servers.ziggy]')) {
      return { configTomlPath, mcpBlockAdded: false }
    }
  }
  const startScript = path.posix.join(ZIGGY_CODE_PATH, 'apps', 'mcp-server', 'bin', 'start.sh')
  const block =
    (existing.endsWith('\n') || existing === '' ? '' : '\n') +
    '\n[mcp_servers.ziggy]\n' +
    `command = "${startScript}"\n`
  fs.writeFileSync(configTomlPath, existing + block, { mode: 0o600 })
  return { configTomlPath, mcpBlockAdded: true }
}

// Bind-mount for the post-restoration-ready sentinel (kanban fcabb870). The
// host writes `${agentDir}/restoration/complete` at the end of
// createDockerAgent / updateContainerMountsAndExtraEnv, after all mount prep
// and registry writes resolve. The container's agent-server.js polls
// /restoration-ready/complete pre-tmux-init and blocks AI_TOOL launch until
// it appears (or its 10s timeout elapses). Closes the Han EACCES race where
// docker run + tmux send-keys would fire before host-side prep finished.
export function buildCloudRestorationSentinelMount(
  agentId: string,
  hostHome: string = os.homedir()
): SandboxMount {
  return {
    hostPath: path.join(hostHome, '.aimaestro', 'agents', agentId, 'restoration'),
    containerPath: '/restoration-ready',
    // Container side only READS the sentinel — principle of least privilege.
    // Host owns all writes via writeRestorationSentinel / clearRestorationSentinel.
    // CelestIA polish on PR #154 (kanban fcabb870).
    readOnly: true,
  }
}

const RESTORATION_SENTINEL_FILENAME = 'complete'

/**
 * Remove a stale restoration-ready sentinel so the next container start
 * observes only the fresh write. Called by updateContainerMountsAndExtraEnv
 * BEFORE `docker stop` so the new container coming up after `docker run`
 * can't false-positive on the previous run's sentinel during its boot
 * window. Best-effort: missing file (ENOENT) is the success case and not
 * logged. Real failures (permission) are logged warning, not thrown — the
 * worst case is the new container observes a stale sentinel and skips its
 * wait, which is the pre-fcabb870 behavior we're already living with.
 */
export function clearRestorationSentinel(agentId: string, hostHome: string = os.homedir()): void {
  const sentinelPath = path.join(
    hostHome,
    '.aimaestro',
    'agents',
    agentId,
    'restoration',
    RESTORATION_SENTINEL_FILENAME,
  )
  try {
    fs.unlinkSync(sentinelPath)
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code
    if (code !== 'ENOENT') {
      console.warn(
        `[restoration-sentinel] could not unlink ${sentinelPath}:`,
        err instanceof Error ? err.message : err,
      )
    }
  }
}

/**
 * Write the restoration-ready sentinel to signal the container that all
 * host-side prep is complete and the AI tool can safely launch. Called
 * at the END of createDockerAgent and updateContainerMountsAndExtraEnv,
 * after mount mkdirSync, provisioning, registry writes, and stale-flag
 * clears all resolve. mkdirSync first to handle fresh-create (no prior
 * mount-prep loop ran for the sentinel dir). Best-effort: a write failure
 * leaves the container blocked on its 10s timeout — fail-loud both sides,
 * but startup recovers.
 */
export function writeRestorationSentinel(agentId: string, hostHome: string = os.homedir()): void {
  const sentinelDir = path.join(hostHome, '.aimaestro', 'agents', agentId, 'restoration')
  try {
    fs.mkdirSync(sentinelDir, { recursive: true })
    fs.writeFileSync(
      path.join(sentinelDir, RESTORATION_SENTINEL_FILENAME),
      new Date().toISOString() + '\n',
      { mode: 0o644 },
    )
  } catch (err) {
    console.warn(
      `[restoration-sentinel] could not write sentinel for ${agentId}:`,
      err instanceof Error ? err.message : err,
    )
  }
}

// Migrate per-agent persisted claude/gh state from a predecessor UUID dir to
// a new agent's dir. Used by recreateDockerAgent to bridge the UUID rotation:
// /recreate soft-deletes the old agent (rotating to a fresh UUID per audit-
// trail policy) and the new container's bind mounts point at the new UUID's
// dir, which would otherwise start empty. Copying the persistence assets
// across before container start preserves bypass-accept, claude OAuth, and
// gh auth across recreates.
//
// Best-effort: missing source files are skipped (predecessor was created
// before this feature shipped, or the operator never logged in). Failures
// are logged, not thrown — recreate must still succeed even if migration
// can't run cleanly. provisionCloudClaudeConfig's existsSync guards then
// no-op on the migrated files so claude/gh see the preserved state.
export function migrateAgentPersistence(
  fromAgentId: string,
  toAgentId: string,
  hostHome: string = os.homedir()
): void {
  if (!fromAgentId || !toAgentId || fromAgentId === toAgentId) return
  const fromDir = path.join(hostHome, '.aimaestro', 'agents', fromAgentId)
  const toDir = path.join(hostHome, '.aimaestro', 'agents', toAgentId)
  if (!fs.existsSync(fromDir)) return
  fs.mkdirSync(toDir, { recursive: true })

  const fileAssets = [
    'claude-home.json',
    'claude-credentials.json',
    // Gemini settings (general.enableAutoUpdate=false seed) — survive recreate
    // so operator hand-edits to ~/.gemini/settings.json carry forward.
    'gemini-settings.json',
    // Codex version.json (dismissed_version sentinel) — survive recreate so
    // a per-agent override of the sentinel carries forward.
    'codex-version.json',
    // Codex auth.json (kanban 354a5174 Option A operator-driven Device Code)
    // — survive recreate so codex stays logged in across UUID rotation.
    // Mirrors the claude-credentials.json carry-forward behavior from PR #96.
    'codex-auth.json',
    // Codex config.toml (per-project trust_level + future config flags)
    // — survive recreate so /workspace stays trusted across UUID rotation
    // and any operator /config edits inside the running agent persist.
    'codex-config.toml',
    // Gemini oauth_creds.json (kanban 1f911653 Option A operator-driven OAuth)
    // — survive recreate so gemini stays logged in across UUID rotation.
    // Mirrors codex-auth.json + claude-credentials.json carry-forward shape.
    'gemini-oauth-creds.json',
  ]
  for (const name of fileAssets) {
    const src = path.join(fromDir, name)
    const dst = path.join(toDir, name)
    try {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, dst)
        fs.chmodSync(dst, 0o600)
      }
    } catch (err) {
      console.warn(`[migrateAgentPersistence] copy ${name}:`, err instanceof Error ? err.message : err)
    }
  }

  // Directory assets carried forward recursively. Each is a per-agent host
  // dir bind-mounted into the container (see buildCloudClaudePersistMounts +
  // buildCloudClaudeReadthroughMounts). Without these, /recreate with
  // persistFromAgentId destroys: gh-config (config.yml + hosts.yml + any
  // extensions/); claude-projects (Claude Code conversation JSONL — chat
  // history would reset to empty on every recreate); chat-state (ai-maestro
  // hook output — permission-prompts + pending-state pinned by the most
  // recent hook write would reset to empty on every recreate).
  const dirAssets = [
    'gh-config',
    // PR #130 (kanban 2853e62d) added these as per-agent bind-mount sources
    // exposed back through to the host. Migrate forward so chat-history +
    // hook-state survive UUID rotation, mirroring the claude-credentials /
    // claude-home / gh-config carry-forward semantics on the file side.
    'claude-projects',
    'chat-state',
    // PR #132 (kanban d937c33d) sister mount for cloud-Gemini transcript;
    // same survival-on-recreate semantic as claude-projects but for the
    // ~/.gemini/tmp/<project>/chats/ bind-mount source.
    'gemini-chats',
    // Antigravity (agy) full app-data tree under ~/.gemini/antigravity-cli/
    // — single-dir OPT-B mount (kanban 49cc27d7). Carries forward
    // antigravity-oauth-token, conversations/, brain/, knowledge/,
    // implicit/, settings.json, installation_id, keybindings.json so a
    // logged-in agy session survives /recreate UUID rotation.
    'antigravity-app-data',
  ]
  for (const name of dirAssets) {
    const src = path.join(fromDir, name)
    const dst = path.join(toDir, name)
    try {
      if (fs.existsSync(src) && fs.statSync(src).isDirectory()) {
        fs.cpSync(src, dst, { recursive: true })
      }
    } catch (err) {
      console.warn(`[migrateAgentPersistence] copy ${name}:`, err instanceof Error ? err.message : err)
    }
  }
}

// Per-agent state-persistence mounts that survive /recreate. Without these,
// every cloud-agent recreate destroys:
//   - ~/.claude.json (bypass-permissions accept flag, onboarding state,
//     project-keyed cache, oauthAccount metadata) — forces the operator
//     through the "Yes, I accept" prompt every single recreate, which is
//     incompatible with --dangerously-skip-permissions autonomous agents.
//   - ~/.claude/.credentials.json (claude-code OAuth tokens) — forces the
//     login URL → browser → paste-code dance every recreate.
//   - ~/.config/gh (gh CLI auth) — forces `gh auth login` every recreate.
//
// Each is mounted RW from a per-agent dir under ~/.aimaestro/agents/<id>/,
// isolated from host operator state and from other agents on the host.
// Provisioned in provisionCloudClaudeConfig so docker-create finds files
// (not auto-materialized root-owned directories) at the bind targets.
//
// Compatible with non-claude programs (gemini, codex): the mounts overlay
// claude-specific paths; gemini/codex ignore them. Codex has its own
// per-agent state under ~/.codex which a follow-up pass can persist using
// the same pattern (filed as a kanban candidate).
export function buildCloudClaudePersistMounts(
  agentId: string,
  hostHome: string = os.homedir()
): SandboxMount[] {
  const agentDir = path.join(hostHome, '.aimaestro', 'agents', agentId)
  return [
    {
      hostPath: path.join(agentDir, 'claude-home.json'),
      containerPath: path.posix.join(CONTAINER_HOME, '.claude.json'),
    },
    {
      hostPath: path.join(agentDir, 'claude-credentials.json'),
      containerPath: path.posix.join(CONTAINER_HOME, '.claude', '.credentials.json'),
    },
    {
      hostPath: path.join(agentDir, 'gh-config'),
      containerPath: path.posix.join(CONTAINER_HOME, '.config', 'gh'),
    },
  ]
}

// Directory mounts that expose in-container Claude state (conversation JSONL
// + ai-maestro hook chat-state) back through to the host fs so the maestro
// server can read them with plain fs.readFileSync. Without these, the chat
// panel renders empty for cloud agents because getConversationMessages reads
// the operator's host ~/.claude/projects/ which has no record of the
// in-container Claude run. Per-agent isolation — each cloud agent gets its
// own host-side dir. mkdir-pre-create ensures docker does not auto-create
// a root-owned dir that the in-container claude (uid 1000) cannot write to.
export function buildCloudClaudeReadthroughMounts(
  agentId: string,
  hostHome: string = os.homedir()
): SandboxMount[] {
  const agentDir = path.join(hostHome, '.aimaestro', 'agents', agentId)
  return [
    {
      hostPath: path.join(agentDir, 'claude-projects'),
      containerPath: path.posix.join(CONTAINER_HOME, '.claude', 'projects'),
    },
    {
      hostPath: path.join(agentDir, 'chat-state'),
      containerPath: path.posix.join(CONTAINER_HOME, '.aimaestro', 'chat-state'),
    },
  ]
}

// Sister-of buildCloudClaudeReadthroughMounts for cloud-Gemini agents.
// Gemini CLI writes conversation JSONL to ~/.gemini/tmp/<project>/chats/
// where <project> is the value from ~/.gemini/projects.json keyed by cwd
// (CONTAINER_CWD_GEMINI_PROJECT = "workspace" for the standard /workspace
// bind). Empirically pinned via Holmes Mason/Optic 2026-05-11 (kanban
// d937c33d). Applied to ALL cloud agents regardless of program — the mount
// is harmless for non-Gemini agents (claude/codex never write under
// .gemini/tmp/), keeping the mount-set shape uniform.
export function buildCloudGeminiReadthroughMounts(
  agentId: string,
  hostHome: string = os.homedir()
): SandboxMount[] {
  const agentDir = path.join(hostHome, '.aimaestro', 'agents', agentId)
  return [
    {
      hostPath: path.join(agentDir, 'gemini-chats'),
      containerPath: path.posix.join(
        CONTAINER_HOME,
        '.gemini',
        'tmp',
        CONTAINER_CWD_GEMINI_PROJECT,
        'chats',
      ),
    },
  ]
}

// Container PATH that puts the AMP CLI (mounted at /home/claude/.local/bin)
// + the repo-script CLI dir (meeting-send / meeting-task / meeting-read,
// mounted at /home/claude/.local/share/aimaestro/cli) ahead of the standard
// Debian path. The base image's Dockerfile sets only the standard path, so
// without this override `which amp-send` and `which meeting-task.sh` fail
// inside the container even though the binaries are mounted and work by full
// path. The cli/ entry was added 2026-05-06 alongside the matching
// scripts-dir bind mount in buildAmpCommonMounts (kanban 0d80aed7).
const CONTAINER_PATH = `${CONTAINER_HOME}/.local/bin:${CONTAINER_HOME}/.local/share/aimaestro/cli:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`

// Per-container agent-identity env (TMUX session, AI program, agent id, host
// URL) that every cloud agent needs regardless of provider. createDockerAgent
// and updateContainerMountsAndExtraEnv both layer this in BEFORE buildAmpCommonEnv
// + operator extraEnv. Operator override of these keys would fake agent identity
// inside the container; the keys are reserved against operator override in
// OPERATOR_RESERVED_ENV_KEYS (and the reservation-completeness test in
// agents-docker-service.test.ts forces the two lists to stay in sync).
export function buildBaseAgentEnv(agentName: string, aiTool: string, hostUrl: string): Record<string, string> {
  return {
    TMUX_SESSION_NAME: agentName,
    AI_TOOL: aiTool,
    AGENT_ID: agentName,
    AIMAESTRO_HOST_URL: hostUrl,
  }
}

// AMP common envs tell amp-helper.sh exactly which agent identity dir to use
// (priority 1 of its resolution order) and where to reach the AI Maestro server
// from inside the container (host.docker.internal is added via --add-host).
//
// Without these, amp-helper falls through to its name-based fallback, which
// auto-creates a phantom empty identity, and amp-send tries to call the
// container's own loopback agent-server instead of the AI Maestro API.
//
// CLAUDE_AGENT_NAME backs amp-helper's priority-3 resolution path — set
// alongside CLAUDE_AGENT_ID so name-based lookups (sender name in routed
// messages, index lookups) get the same answer as id-based lookups.
export function buildAmpCommonEnv(agentId: string, agentName: string, hostUrl: string): Record<string, string> {
  return {
    CLAUDE_AGENT_ID: agentId,
    CLAUDE_AGENT_NAME: agentName,
    // AMP_AGENT_ID aliases CLAUDE_AGENT_ID for amp-statusline.sh's priority-1
    // resolution path (kanban 172e170d). The script checks AMP_AGENT_ID first
    // then falls back to CLAUDE_AGENT_NAME + an index lookup that requires
    // ~/.agent-messaging/.index.json — but only the per-agent subdir is bind-
    // mounted into the container, not the index. Direct AMP_AGENT_ID bypasses
    // the index entirely and reads the per-agent config.json (which IS mounted).
    AMP_AGENT_ID: agentId,
    AMP_DIR: path.posix.join(CONTAINER_HOME, '.agent-messaging', 'agents', agentId),
    AMP_MAESTRO_URL: hostUrl,
    PATH: CONTAINER_PATH,
    // Pre-trust the workspace for gemini-program agents — bypasses the trust
    // dialog (kanban cd2d7377) without needing a trustedFolders.json mount.
    // Honored by gemini's util/trust.ts checkPathTrust before the file lookup.
    // Harmless for non-gemini programs (claude/codex don't read this var).
    GEMINI_CLI_TRUST_WORKSPACE: 'true',
  }
}

// Merge mounts so operator-supplied entries override common ones at the same
// containerPath (operator wins), preserving operator order then appending any
// common mount the operator did not already cover.
export function mergeMounts(common: SandboxMount[], operator: SandboxMount[] | undefined): SandboxMount[] {
  const operatorList = operator ?? []
  const operatorPaths = new Set(operatorList.map(m => m.containerPath))
  return [...operatorList, ...common.filter(m => !operatorPaths.has(m.containerPath))]
}

// Merge envs so operator-supplied entries override common ones for the same key.
export function mergeEnv(common: Record<string, string>, operator: Record<string, string> | undefined): Record<string, string> {
  return { ...common, ...(operator ?? {}) }
}

// Bootstrap an AMP identity for a freshly-created cloud agent: generate the
// keypair, register with the local AI Maestro AMP server (issues the API key),
// and write the keypair + config + IDENTITY.md + provider registration file
// into the agent's per-UUID dir so the bind mount lands populated.
//
// Without this, brand-new cloud agents have an empty per-UUID dir (the bind-
// mount target exists but contains no keys/registrations/config), and the
// container's amp-* CLI cannot sign outbound messages until amp-init runs
// from inside — which fails today because the agent's per-UUID mount sits
// under a root-owned parent (/home/claude/.agent-messaging/agents/), so amp-
// init's mkdir for a new sibling UUID hits EPERM. See PR #79 for the per-
// agent mount tradeoff and the meeting thread for the discovery.
//
// Tree mismatch caveat: lib/amp-keys.ts saveKeyPair writes to
// ~/.aimaestro/agents/<id>/keys/ (the registry/runtime side, used by the
// SERVER to verify the public key), but amp-helper inside the container
// reads from ~/.agent-messaging/agents/<id>/keys/ (the messaging side,
// where amp-init traditionally writes). Bootstrap writes to BOTH: saveKeyPair
// for server-side public-key storage + direct write to the messaging side
// for the agent's own signing keys. registerAgent's internal saveKeyPair
// call (with empty private) is also overwritten by our saveKeyPair call to
// keep the registry-side store correct.
//
// Failures are logged loudly but non-fatal — the container is already
// running by the time we get here, the agent can use its program normally,
// only AMP signing is unavailable until an operator amp-init runs manually.
export async function bootstrapAmpIdentity(
  agentId: string,
  agentName: string,
  hostHome: string = os.homedir()
): Promise<void> {
  const tenant = getOrganization()
  if (!tenant) {
    console.warn('[Docker Service] Skipping AMP bootstrap — organization not configured. Run setup or amp-init manually after the agent boots.')
    return
  }

  const keyPair = await generateKeyPair()

  // registerAgent adopts the existing agent record (we just created it with
  // this UUID), issues an API key, marks the agent AMP-registered, and calls
  // initAgentAMPHome to set up the messaging-side dir + .index.json entry.
  // It also calls saveKeyPair internally with an EMPTY private — we re-save
  // with the real private after to overwrite the registry-side store.
  const regResult = await registerAgent(
    {
      name: agentName,
      tenant,
      public_key: keyPair.publicPem,
      key_algorithm: 'Ed25519',
      agent_id: agentId,
    },
    null
  )

  if (regResult.status !== 200 && regResult.status !== 201) {
    const errMsg = (regResult.data as { message?: string })?.message || 'Unknown registration error'
    console.warn(`[Docker Service] AMP registration failed (HTTP ${regResult.status}): ${errMsg}. Container will still run; AMP signing unavailable until operator amp-init.`)
    return
  }

  // Server-side store: overwrite the empty private from registerAgent's
  // saveKeyPair call so the registry-side keys/ dir holds real bytes
  // (used by the server for fingerprint verification on inbound).
  saveKeyPair(agentId, keyPair)

  const regResp = regResult.data as {
    address: string
    agent_id: string
    api_key: string
    provider: { name: string; endpoint: string; route_url: string }
    tenant: string
  }

  // Messaging-side per-UUID dir is the path amp-helper inside the container
  // reads from. Write keys, config.json (overriding initAgentAMPHome's
  // minimal stub which inherits machine-level "default" tenant), IDENTITY.md,
  // and the provider registration file.
  const agentMessagingDir = path.join(hostHome, '.agent-messaging', 'agents', agentId)
  const keysDir = path.join(agentMessagingDir, 'keys')
  const regsDir = path.join(agentMessagingDir, 'registrations')
  fs.mkdirSync(keysDir, { recursive: true })
  fs.mkdirSync(regsDir, { recursive: true })

  // Keys — match amp-init's mode bits (private 0600, public 0644)
  fs.writeFileSync(path.join(keysDir, 'private.pem'), keyPair.privatePem, { mode: 0o600 })
  fs.writeFileSync(path.join(keysDir, 'public.pem'), keyPair.publicPem, { mode: 0o644 })

  // config.json — rewrite with real tenant + address + fingerprint from the
  // registration response. initAgentAMPHome wrote a stub with "default"
  // tenant copied from the machine-level config; that mismatch causes
  // amp-identity to misreport the agent's own address.
  const configBody = {
    version: '1.1',
    agent: {
      name: agentName,
      tenant: regResp.tenant,
      address: regResp.address,
      fingerprint: keyPair.fingerprint,
      createdAt: new Date().toISOString(),
      id: agentId,
    },
    provider: {
      domain: regResp.provider.name,
      maestro_url: 'http://host.docker.internal:23000',
    },
  }
  fs.writeFileSync(path.join(agentMessagingDir, 'config.json'), JSON.stringify(configBody, null, 2), { mode: 0o644 })

  // IDENTITY.md — markdown card amp-identity references for context recovery
  const identityBody =
    `# Agent Messaging Protocol (AMP) Identity\n\n` +
    `This agent is configured for inter-agent messaging using AMP.\n\n` +
    `## Core Identity\n\n` +
    `| Field | Value |\n` +
    `|-------|-------|\n` +
    `| **Name** | ${agentName} |\n` +
    `| **Tenant** | ${regResp.tenant} |\n` +
    `| **Address** | ${regResp.address} |\n` +
    `| **Fingerprint** | ${keyPair.fingerprint} |\n` +
    `| **UUID** | ${agentId} |\n\n` +
    `Bootstrapped server-side at create-time by ai-maestro createDockerAgent.\n`
  fs.writeFileSync(path.join(agentMessagingDir, 'IDENTITY.md'), identityBody, { mode: 0o644 })

  // Provider registration file — amp-helper looks here for the API key +
  // route URL when sending outbound.
  const regFilePath = path.join(regsDir, `${regResp.provider.name}.json`)
  const regFileBody = {
    provider: regResp.provider.name,
    apiUrl: regResp.provider.endpoint,
    routeUrl: regResp.provider.route_url,
    agentName,
    tenant: regResp.tenant,
    address: regResp.address,
    apiKey: regResp.api_key,
    providerAgentId: regResp.agent_id,
    fingerprint: keyPair.fingerprint,
    registeredAt: new Date().toISOString(),
  }
  fs.writeFileSync(regFilePath, JSON.stringify(regFileBody, null, 2), { mode: 0o600 })

  console.log(`[Docker Service] Bootstrapped AMP identity for ${agentName} (${agentId.substring(0, 8)}...)`)
}

// ── Public Functions ────────────────────────────────────────────────────────


/**
 * Create a new agent running inside a Docker container.
 */
export async function createDockerAgent(body: DockerCreateRequest): Promise<ServiceResult<Record<string, unknown>>> {
  if (!body.name?.trim()) {
    return missingField('name')
  }

  const mountError = validateMounts(body.mounts, 'operator')
  if (mountError) {
    return invalidRequest(mountError)
  }

  const envError = validateExtraEnv(body.extraEnv, 'operator')
  if (envError) {
    return invalidRequest(envError)
  }

  const name = body.name.trim().toLowerCase()

  // If targeting a remote host, forward the request
  if (body.hostId) {
    const hosts = getHosts()
    const targetHost = hosts.find(h => h.id === body.hostId)
    if (targetHost && !isSelf(targetHost.id)) {
      try {
        const resp = await fetch(`${targetHost.url}/api/agents/docker/create`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(30000),
        })
        const data = await resp.json()
        return { data, status: resp.status }
      } catch (err) {
        return operationFailed('reach remote host', err instanceof Error ? err.message : 'Unknown error')
      }
    }
  }

  // Verify Docker is available
  try {
    await execAsync("docker version --format '{{.Server.Version}}'", { timeout: 5000 })
  } catch {
    return invalidRequest('Docker is not available on this host')
  }

  // Find an available port in 23001-23100 range
  let port: number | null = null
  try {
    const { stdout: portsOutput } = await execAsync(
      "docker ps --format '{{.Ports}}' 2>/dev/null || echo ''"
    )
    const usedPorts = new Set<number>()
    const portRegex = /(\d+)->23000/g
    let match
    while ((match = portRegex.exec(portsOutput)) !== null) {
      usedPorts.add(parseInt(match[1], 10))
    }

    for (let p = 23001; p <= 23100; p++) {
      if (!usedPorts.has(p)) {
        port = p
        break
      }
    }
  } catch {
    port = 23001
  }

  if (!port) {
    return serviceError('operation_failed', 'No available ports in range 23001-23100', 503)
  }

  // Build the AI_TOOL environment variable. Resolve the program identifier
  // to its in-container binary name BEFORE composing — for most programs
  // (claude/codex/gemini/aider/cursor/opencode) the identifier == binary, but
  // antigravity → `agy` so a verbatim `program` would bake an unrunnable
  // command into AI_TOOL and agent-server.js:167's `unset CI && ${AI_TOOL}`
  // wake-line would fail with `command not found: antigravity`. PR-3 hotfix.
  const program = body.program || 'claude'
  let aiTool = resolveStartCommand(program)
  if (body.yolo) {
    aiTool += ' --dangerously-skip-permissions'
  }
  if (body.programArgs) {
    const sanitizedArgs = body.programArgs.replace(/[^a-zA-Z0-9\s\-_.=/:,~@]/g, '').trim()
    if (sanitizedArgs) aiTool += ` ${sanitizedArgs}`
  }
  if (body.model) {
    aiTool += ` --model ${body.model}`
  }
  if (body.prompt) {
    const escapedPrompt = body.prompt.replace(/'/g, "'\\''")
    aiTool += ` -p '${escapedPrompt}'`
  }

  const containerName = `aim-${name}`
  const workDir = body.workingDirectory || '/tmp'
  const cpus = body.cpus || 2
  const memory = body.memory || '4g'
  const useZiggy = body.ziggy === true

  // Validate the operator pre-flight for Ziggy MCP integration BEFORE doing
  // any destructive docker work or registry writes. The per-agent .env at
  // /opt/stacks/ai-maestro/agent-envs/<name>.env must exist with at least
  // ZIGGY_PROFILE + DATABASE_URL — start.sh sources it via the overlay mount,
  // and a missing file would either make docker create the mount source as a
  // root-owned empty dir (breaking the bind) or yield an MCP server that
  // silently inherits Rollie's host .env. Fail loudly here is better than
  // either failure mode.
  if (useZiggy) {
    try {
      fs.mkdirSync(ZIGGY_AGENT_ENVS_DIR, { recursive: true })
    } catch (err) {
      console.warn(
        `[Docker Service] Could not mkdir ${ZIGGY_AGENT_ENVS_DIR}:`,
        err instanceof Error ? err.message : err,
      )
    }
    const envFilePath = path.join(ZIGGY_AGENT_ENVS_DIR, `${name}.env`)
    if (!fs.existsSync(envFilePath)) {
      return invalidRequest(
        `sandbox.ziggy=true requires a per-agent env file at ${envFilePath}. ` +
          'Create it on the host with ZIGGY_PROFILE=default and ' +
          `DATABASE_URL=postgresql://ziggy:<password>@ziggy-postgres:5432/ziggy (pw from /opt/stacks/ziggy/.env), ` +
          'then retry. See services/agents-docker-service.ts ZIGGY_AGENT_ENVS_DIR comment for the design.',
      )
    }
  }

  // Pre-generate the agent UUID so AMP common mounts and CLAUDE_AGENT_ID can
  // reference it on first container start. createAgent below accepts an
  // explicit `id` and will use it verbatim if it matches the UUID shape.
  const agentId = uuidv4()

  // Build the docker invocation. Common AMP mounts/envs are auto-included for
  // every cloud agent so amp-helper can resolve identity (CLAUDE_AGENT_ID +
  // AMP_DIR) and reach the host AI Maestro server (AMP_MAESTRO_URL via the
  // host.docker.internal alias). Operator-supplied mounts/extraEnv merge on
  // top: same containerPath / same env key wins for the operator, so callers
  // can override defaults when needed.
  const hostPort = process.env.PORT || '23000'
  const hostInternalUrl = `http://host.docker.internal:${hostPort}`

  const baseEnv: Record<string, string> = buildBaseAgentEnv(name, aiTool, hostInternalUrl)
  if (body.githubToken) {
    baseEnv.GITHUB_TOKEN = body.githubToken
  }
  const ampEnv = buildAmpCommonEnv(agentId, name, hostInternalUrl)
  const mergedEnv = mergeEnv({ ...baseEnv, ...ampEnv }, body.extraEnv)

  const ampMounts = buildAmpCommonMounts(agentId)
  const claudeReadthroughMounts = buildCloudClaudeReadthroughMounts(agentId)
  const geminiReadthroughMounts = buildCloudGeminiReadthroughMounts(agentId)
  const antigravityMount = buildCloudAntigravityAppDataMount(agentId)
  const restorationSentinelMount = buildCloudRestorationSentinelMount(agentId)

  // Pre-create host-side dirs that are about to be bind-mounted. If the host
  // path doesn't exist, docker creates it as a root-owned empty directory,
  // which (a) leaves the container's claude (uid 1000) unable to write keys
  // and (b) silently masks the missing-identity failure. We create them as the
  // server process user (uid matches the container's claude user by convention).
  for (const m of [...ampMounts, ...claudeReadthroughMounts, ...geminiReadthroughMounts, antigravityMount, restorationSentinelMount]) {
    try {
      fs.mkdirSync(m.hostPath, { recursive: true })
    } catch (err) {
      console.warn(`[Docker Service] Could not pre-create mount source ${m.hostPath}:`, err)
    }
  }

  // If this create is the back half of a recreate flow, copy the predecessor's
  // persisted claude/gh state into the new UUID dir BEFORE provisioning runs
  // so the empty-{} seeds in provisionCloudClaudeConfig no-op (they only
  // create when missing). Net effect: bypass-accept, claude OAuth, and gh
  // auth all carry across recreates despite the audit-trail UUID rotation.
  if (body.persistFromAgentId) {
    try {
      migrateAgentPersistence(body.persistFromAgentId, agentId)
    } catch (err) {
      console.warn(
        '[Docker Service] persistence migration failed (non-fatal — new agent will start with empty state):',
        err instanceof Error ? err.message : err
      )
    }
  }

  // Provision per-container Claude/Gemini/Codex CLI configs in the agent's
  // per-UUID dir, then add file-level bind mounts that overlay the program-
  // specific config paths inside the container without leaking the host
  // operator's full state tree. Each program's seed + mount runs unconditionally
  // — mounts targeting unused programs are harmless because the other CLIs
  // never read those paths. Provisioning is wrapped per-program so a failure
  // in one (e.g. disk full at the gemini seed) doesn't drop the others.
  try {
    provisionCloudClaudeConfig(agentId)
  } catch (err) {
    console.warn('[Docker Service] Could not provision cloud claude config:', err instanceof Error ? err.message : err)
  }
  try {
    provisionCloudGeminiConfig(agentId)
  } catch (err) {
    console.warn('[Docker Service] Could not provision cloud gemini config:', err instanceof Error ? err.message : err)
  }
  try {
    provisionCloudGeminiAuth(agentId)
  } catch (err) {
    console.warn('[Docker Service] Could not provision cloud gemini auth:', err instanceof Error ? err.message : err)
  }
  try {
    provisionCloudCodexConfig(agentId)
  } catch (err) {
    console.warn('[Docker Service] Could not provision cloud codex config:', err instanceof Error ? err.message : err)
  }
  try {
    provisionCloudCodexAuth(agentId)
  } catch (err) {
    console.warn('[Docker Service] Could not provision cloud codex auth:', err instanceof Error ? err.message : err)
  }
  if (useZiggy) {
    try {
      provisionCloudCodexZiggyMcpEntry(agentId)
    } catch (err) {
      console.warn('[Docker Service] Could not provision cloud codex ziggy MCP entry:', err instanceof Error ? err.message : err)
    }
  }
  const mergedMounts = mergeMounts(
    [
      ...ampMounts,
      buildCloudClaudeSettingsMount(agentId),
      ...buildCloudClaudePersistMounts(agentId),
      ...claudeReadthroughMounts,
      buildCloudGeminiSettingsMount(agentId),
      buildCloudGeminiOAuthMount(agentId),
      ...geminiReadthroughMounts,
      buildCloudAntigravityAppDataMount(agentId),
      buildCloudCodexVersionMount(agentId),
      buildCloudCodexAuthMount(agentId),
      buildCloudCodexConfigTomlMount(agentId),
      buildCloudCodexHooksMount(agentId),
      ...(useZiggy ? [buildZiggyCodeMount(), buildZiggyEnvOverlayMount(name)] : []),
      restorationSentinelMount,
    ],
    body.mounts
  )

  const dockerCmd = [
    'docker run -d',
    `--name "${containerName}"`,
    '--add-host=host.docker.internal:host-gateway',
    // Container hardening (ported from upstream 23blocks): drop all Linux
    // capabilities, then add back only the minimal set an agent container
    // needs (bind <1024, setuid/setgid for the entrypoint user-drop, chown/
    // fowner/dac_override for per-UUID home merges); forbid privilege
    // escalation; and pin a small noexec/nosuid tmpfs over the container's
    // /tmp. NOTE: --tmpfs /tmp is FLAGGED for empirical container-image
    // verification before the live 3-host deploy (noexec + 100m cap could
    // break tooling that execs/spills into /tmp). See KAI reconciliation flag.
    '--cap-drop=ALL',
    '--cap-add=NET_BIND_SERVICE --cap-add=SETGID --cap-add=SETUID --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=FOWNER',
    '--security-opt no-new-privileges',
    // noexec dropped: it breaks TMPDIR-exec tooling (pip-from-source, cmake/ninja,
    // test harnesses spawning helper scripts) — reproduced on Oliver burn-in 2026-06-04.
    // cap-drop=ALL + no-new-privileges + nosuid + size cap retained (still strictly
    // harder than pre-merge baseline; cap-drop=ALL is the biggest privilege win).
    // explicit `exec` REQUIRED: Docker tmpfs defaults to noexec unless overridden,
    // so dropping noexec from the string alone silently leaves it applied (verified
    // on Oliver: mount-inside still showed noexec). `exec` forces it off.
    '--tmpfs /tmp:exec,nosuid,size=100m',
    body.autoRemove ? '' : '--restart unless-stopped',
    // Single-network attach when useZiggy=true: container joins ziggy_default
    // ONLY, not the default bridge. ai-maestro inter-agent comms are AMP over
    // filesystem (not Docker DNS), so isolation is fine today. If a future
    // feature needs container-to-container DNS for non-Ziggy agents, attach
    // the default bridge via `docker network connect bridge <container>`
    // post-create. Per Hutch ops review PR #157 note A.
    useZiggy ? `--network ${ZIGGY_NETWORK}` : '',
    ...buildEnvFlags(mergedEnv),
    `-v "${workDir}:/workspace"`,
    ...buildMountFlags(mergedMounts),
    `-p ${port}:23000`,
    `--cpus=${cpus}`,
    `--memory=${memory}`,
    body.autoRemove ? '--rm' : '',
    'ai-maestro-agent:latest',
  ].filter(Boolean).join(' ')

  let containerId: string
  try {
    const { stdout } = await execAsync(dockerCmd, { timeout: 30000 })
    containerId = stdout.trim().slice(0, 12)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return operationFailed('start container', message)
  }

  // Register in agent registry. Persist only the operator-supplied mounts
  // under deployment.sandbox.mounts — AMP common mounts are recomputed
  // deterministically from the agent UUID at any future redeploy, so storing
  // them would create drift if defaults evolve.
  try {
    const agent = createAgent({
      id: agentId,
      name,
      label: body.label,
      avatar: body.avatar,
      program,
      model: body.model,
      programArgs: body.programArgs,
      taskDescription: body.prompt || '',
      workingDirectory: workDir,
      createSession: true,
      deploymentType: 'cloud',
      hostId: body.hostId,
    })

    const agents = loadAgents()
    const idx = agents.findIndex(a => a.id === agent.id)
    if (idx !== -1) {
      // Persist runtime config (cpus/memory/autoRemove/extraEnv) so recreate
      // and the mid-life /update-runtime endpoint can rebuild docker run with
      // the operator's original sizing + env, not the create defaults. Omit
      // the runtime sub-object entirely when nothing was supplied to keep
      // legacy agent records identical on the on-disk shape.
      const runtime: NonNullable<NonNullable<Agent['deployment']['cloud']>['runtime']> = {}
      if (body.cpus !== undefined) runtime.cpus = body.cpus
      if (body.memory !== undefined) runtime.memory = body.memory
      if (body.autoRemove !== undefined) runtime.autoRemove = body.autoRemove
      if (body.extraEnv && Object.keys(body.extraEnv).length > 0) runtime.extraEnv = body.extraEnv
      const hasRuntime = Object.keys(runtime).length > 0

      // Persisted sandbox block: operator mounts (recreated from body.mounts
      // on recreate) + ziggy flag (drives --network ziggy_default attach +
      // overlay-mount provisioning). AMP/program-specific common mounts are
      // re-synthesized deterministically at every redeploy and never stored
      // here — see the comment block on this function and the helper docstrings.
      const sandboxBlock: NonNullable<Agent['deployment']>['sandbox'] = {}
      if (body.mounts && body.mounts.length > 0) sandboxBlock.mounts = body.mounts
      if (useZiggy) sandboxBlock.ziggy = true
      const hasSandbox = Object.keys(sandboxBlock).length > 0

      agents[idx].deployment = {
        type: 'cloud',
        cloud: {
          provider: 'local-container',
          containerName,
          websocketUrl: `ws://localhost:${port}/term`,
          healthCheckUrl: `http://localhost:${port}/health`,
          status: 'running',
          ...(hasRuntime ? { runtime } : {}),
        },
        ...(hasSandbox ? { sandbox: sandboxBlock } : {}),
      }
      saveAgents(agents)
    }
  } catch (err) {
    console.error('[Docker Service] Registry error:', err)
  }

  // Bootstrap AMP identity server-side so the per-UUID bind mount lands
  // populated with keys + registration. Non-fatal — container is already up.
  try {
    await bootstrapAmpIdentity(agentId, name)
  } catch (err) {
    console.warn('[Docker Service] AMP bootstrap threw:', err instanceof Error ? err.message : err)
  }

  // Signal the running container that all host-side prep is done. agent-server.js
  // (via restoration-gate.cjs) is polling for this sentinel before tmux init
  // fires AI_TOOL. Best-effort write — a failure here leaves the container
  // blocked on its 10s timeout, then it proceeds with a warning. See kanban
  // fcabb870.
  writeRestorationSentinel(agentId)

  return {
    data: {
      success: true,
      agentId,
      containerId,
      port,
      containerName,
    },
    status: 200
  }
}

/**
 * Build a DockerCreateRequest body from an existing agent's persisted
 * registry fields. Used by recreateDockerAgent to forward all create-time
 * config (programArgs, model, mounts, label, avatar, working directory)
 * to the new container so hibernate→wake-stable AI_TOOL contains everything
 * that was originally specified. Exported for unit testing of the field
 * mapping.
 *
 * Container-derived fields (containerName/port/websocketUrl) deliberately
 * NOT included — they regenerate inside createDockerAgent.
 */
export function buildRecreateBody(oldAgent: Agent): DockerCreateRequest {
  const runtime = oldAgent.deployment?.cloud?.runtime
  return {
    name: oldAgent.name,
    label: oldAgent.label,
    avatar: oldAgent.avatar,
    hostId: oldAgent.hostId,
    program: oldAgent.program,
    programArgs: oldAgent.programArgs,
    model: oldAgent.model,
    workingDirectory: oldAgent.workingDirectory,
    mounts: oldAgent.deployment?.sandbox?.mounts,
    ziggy: oldAgent.deployment?.sandbox?.ziggy,
    cpus: runtime?.cpus,
    memory: runtime?.memory,
    autoRemove: runtime?.autoRemove,
    extraEnv: runtime?.extraEnv,
  }
}

// Fields that live on the agent record but are NOT part of DockerCreateRequest.
// After createDockerAgent provisions the new container/registry entry, recreate
// patches these onto the new agent so post-create config (hooks, tags, role, etc.)
// survives the swap. Keep in sync with types/agent.ts Agent interface — fields
// derived from container state (containerName/port/websocketUrl, ampIdentity,
// sessions, status, createdAt, lastActive, deployment) are intentionally NOT
// preserved; they re-derive at create time.
export const RECREATE_PRESERVED_FIELDS = [
  'hooks',
  'taskDescription',
  'tags',
  'capabilities',
  'role',
  'team',
  'documentation',
  'metadata',
  'skills',
  'preferences',
  'meshAware',
  'owner',
] as const

/**
 * Recreate an existing cloud agent: stop+remove its container, soft-delete
 * the old registry entry, and provision a new container with all originally-
 * persisted config preserved (programArgs, model, mounts, label, avatar,
 * working directory, hooks, tags, etc.).
 *
 * Atomicity caveat: the flow is best-effort, NOT transactionally atomic. If
 * createDockerAgent fails after the soft-delete (port exhaustion, docker
 * daemon error, image-not-found, AMP keypair generation failure), the
 * operator is left with the old container gone and the old agent soft-
 * deleted but no new agent. Recovery requires manual undelete (clearing
 * deletedAt on the old registry entry) — name-reuse forces this ordering
 * since two live agents can't share a name. Auto-rollback is tracked as a
 * separate followup; the failure mode is rare in practice (mirrors the
 * exposure of today's manual delete-then-create flow).
 *
 * Why this exists: Docker bakes env vars (including AI_TOOL, which carries
 * programArgs) at `docker run` time. Hibernate→wake is `docker stop` +
 * `docker start` and faithfully preserves whatever env was originally baked
 * — so any registry-side mutation (UI edit, manual --keep-data delete +
 * curl POST recreate) silently fails to reach the running container until
 * a full container swap. Today's flow makes that swap manually (operator
 * assembles the create body), which drops fields the operator didn't
 * remember to forward — programArgs and hooks being the worst offenders.
 *
 * The new UUID + AMP keypair generation matches the existing recreate
 * pattern (containerName/port/websocketUrl re-derive from createDockerAgent,
 * same as today). Caller-side tooling (UI delete-and-recreate, CLI
 * recreate, ops scripts) should migrate to this endpoint so the preserve-
 * fields contract is enforced server-side.
 */
export async function recreateDockerAgent(
  agentId: string
): Promise<ServiceResult<Record<string, unknown>>> {
  const oldAgent = getAgent(agentId, true) // include soft-deleted to distinguish 404 vs 410
  if (!oldAgent) return notFound('Agent', agentId)
  if (oldAgent.deletedAt) return gone('Agent')

  if (oldAgent.deployment?.type !== 'cloud' || oldAgent.deployment.cloud?.provider !== 'local-container') {
    return invalidState(
      `recreate is only supported for cloud agents with provider 'local-container' (agent ${agentId} is type=${oldAgent.deployment?.type ?? 'unset'}, provider=${oldAgent.deployment?.cloud?.provider ?? 'unset'})`
    )
  }

  // Stop + remove the old container if present. Both calls are non-fatal:
  // if the container is already stopped/removed/never-started we still want
  // to proceed to soft-delete + create. Failures here are usually
  // already-in-target-state, not a real error condition.
  //
  // Wall-clock timeouts are 60s — `docker stop` issues SIGTERM with a 10s
  // grace before SIGKILL, but a Claude Code session mid-`uv tool install`
  // can take longer than 15s to actually exit. A 60s ceiling gives graceful
  // shutdown room without blocking the operator indefinitely.
  const oldContainerName = oldAgent.deployment.cloud.containerName
  if (oldContainerName) {
    const safeContainerName = oldContainerName.replace(/[^a-zA-Z0-9_-]/g, '')
    try {
      await execAsync(`docker stop ${safeContainerName}`, { timeout: 60000 })
    } catch (err) {
      console.log(`[Recreate] stop ${oldContainerName} (non-fatal):`, err instanceof Error ? err.message : err)
    }
    try {
      await execAsync(`docker rm ${safeContainerName}`, { timeout: 60000 })
    } catch (err) {
      console.log(`[Recreate] rm ${oldContainerName} (non-fatal):`, err instanceof Error ? err.message : err)
    }
    // Verify removal — `docker run --name aim-<name>` will fail with a name
    // conflict if the prior container is still around (e.g. stop+rm wall-
    // clock-timed-out while the daemon was still gracefully stopping). Skip
    // the verification on inspect failure (means the container is gone, the
    // expected case).
    try {
      await execAsync(`docker inspect ${safeContainerName}`, { timeout: 5000 })
      // inspect succeeded → container still exists → name conflict will block create
      return operationFailed(
        'remove old container',
        `${oldContainerName} still exists after stop+rm; createDockerAgent would fail with a name conflict. Manual cleanup required.`
      )
    } catch {
      // inspect failed → container is gone, proceed
    }
  }

  // Soft-delete the old agent so the new one can take the same `name`
  // (getAgentByName excludes deletedAt entries). Soft-delete also removes
  // ~/.agent-messaging/agents/<old-UUID> to free the AMP index for the new
  // agent's registration; ~/.aimaestro/agents/<old-UUID> stays per the
  // audit-trail convention (centralized cleanup tracked separately).
  if (!deleteAgent(agentId, false)) {
    return operationFailed('soft-delete prior agent', `agent ${agentId} could not be marked as deleted`)
  }

  // Build the create body from the old agent's persisted fields. Container-
  // derived fields (containerName/port/websocketUrl) intentionally regenerate
  // inside createDockerAgent. AMP keypair regenerates per existing pattern.
  // persistFromAgentId carries the predecessor's UUID into createDockerAgent
  // so it can migrate claude/gh state across the audit-trail UUID rotation.
  const body: DockerCreateRequest = { ...buildRecreateBody(oldAgent), persistFromAgentId: agentId }

  const result = await createDockerAgent(body)
  if (result.status !== 200 || !result.data) return result

  // Patch the agent-record-but-not-DockerCreateRequest fields onto the new
  // agent. Done after createDockerAgent so the new agent's UUID is known.
  const newAgentId = (result.data as Record<string, unknown>).agentId
  if (typeof newAgentId === 'string' && newAgentId) {
    const patches: Partial<Agent> = {}
    for (const field of RECREATE_PRESERVED_FIELDS) {
      const value = (oldAgent as unknown as Record<string, unknown>)[field]
      if (value !== undefined) {
        ;(patches as unknown as Record<string, unknown>)[field] = value
      }
    }
    if (Object.keys(patches).length > 0) {
      try {
        updateAgent(newAgentId, patches as Parameters<typeof updateAgent>[1])
      } catch (err) {
        console.warn(`[Recreate] Could not patch preserved fields onto ${newAgentId}:`, err instanceof Error ? err.message : err)
      }
    }
  }

  return {
    data: {
      ...result.data,
      recreatedFromAgentId: agentId,
      recreatedFromContainerName: oldContainerName,
      preservedFields: RECREATE_PRESERVED_FIELDS.filter(f => (oldAgent as unknown as Record<string, unknown>)[f] !== undefined),
    },
    status: result.status,
  }
}

/**
 * Parse the host-side port from a websocketUrl like "ws://localhost:23042/term".
 * Returns null if the URL is missing or unparseable.
 */
export function parsePortFromWebsocketUrl(url: string | undefined): number | null {
  if (!url) return null
  const match = url.match(/:(\d+)\//)
  if (!match) return null
  const port = parseInt(match[1], 10)
  return Number.isFinite(port) ? port : null
}

export interface UpdateRuntimeConfig {
  mounts?: SandboxMount[]            // Replace operator-supplied mounts wholesale (omit to keep existing)
  extraEnv?: Record<string, string>  // Replace operator-supplied extraEnv wholesale (omit to keep existing)
  // Toggle ziggy_default network attach + Ziggy MCP overlay mounts. Omit to
  // leave the existing agent.deployment.sandbox.ziggy untouched. Explicit
  // false clears the flag; true sets it and requires the per-agent env file
  // at /opt/stacks/ai-maestro/agent-envs/<name>.env to exist on host.
  ziggy?: boolean
}

/**
 * Update an existing cloud agent's container mounts and/or extraEnv without
 * rotating its UUID, AMP keypair, or per-agent state directory.
 *
 * Stops + removes the existing container by name, rebuilds the docker run
 * invocation from the agent record (program, programArgs, model,
 * workingDirectory, sandbox.mounts, cloud.runtime) with the requested
 * `config` overrides applied, runs a fresh container under the SAME
 * containerName + port + websocketUrl, then persists the new mounts/extraEnv
 * onto the agent record.
 *
 * Why this exists: /recreate intentionally rotates the audit-trail UUID
 * (see recreateDockerAgent), which forces a new AMP keypair, fresh per-agent
 * state dir, and breaks long-lived references (peer caches, kanban
 * assignments, dashboards). Operator-driven mid-life mutations — adding a
 * code mount, overriding HOME for the Shape β agent-home convention — do
 * NOT need an audit-trail event; they only need the docker run command
 * rebuilt with the new flags. Going through /recreate for these would burn
 * UUID rotation per mount, which is unacceptable for routine config edits.
 *
 * Atomicity caveat: same shape as recreateDockerAgent — stop+rm + run is
 * best-effort. If docker run fails after stop+rm, the operator is left with
 * the container gone but the registry still pointing at the old config.
 * Recovery: rerun update-runtime with corrected inputs, or /recreate to
 * fully re-provision (UUID rotation cost). Failure is rare in practice
 * (mirrors recreate's exposure).
 *
 * Limitations matched to /recreate: yolo, prompt, and dashboard-supplied
 * githubToken are not persisted on the agent record, so a rebuild loses
 * them. To carry these forward, set them in programArgs or extraEnv.
 *
 * Pass `mounts: undefined` to leave the operator-mount list untouched. Same
 * for `extraEnv`. Pass `mounts: []` or `extraEnv: {}` to explicitly clear.
 */
export async function updateContainerMountsAndExtraEnv(
  agentId: string,
  config: UpdateRuntimeConfig
): Promise<ServiceResult<Record<string, unknown>>> {
  const agent = getAgent(agentId, true)
  if (!agent) return notFound('Agent', agentId)
  if (agent.deletedAt) return gone('Agent')

  if (agent.deployment?.type !== 'cloud' || agent.deployment.cloud?.provider !== 'local-container') {
    return invalidState(
      `update-runtime is only supported for cloud agents with provider 'local-container' (agent ${agentId} is type=${agent.deployment?.type ?? 'unset'}, provider=${agent.deployment?.cloud?.provider ?? 'unset'})`
    )
  }

  // Validate the operator-supplied mounts/extraEnv before doing any destructive
  // docker work. Empty arrays/objects are valid (= "clear"), so only validate
  // when the caller actually supplied a value.
  if (config.mounts !== undefined) {
    const mountError = validateMounts(config.mounts, 'operator')
    if (mountError) return invalidRequest(mountError)
  }
  if (config.extraEnv !== undefined) {
    const envError = validateExtraEnv(config.extraEnv, 'operator')
    if (envError) return invalidRequest(envError)
  }

  try {
    await execAsync("docker version --format '{{.Server.Version}}'", { timeout: 5000 })
  } catch {
    return invalidRequest('Docker is not available on this host')
  }

  const containerName = agent.deployment.cloud.containerName
  if (!containerName) {
    return invalidState(`agent ${agentId} has no containerName — cannot determine which container to rebuild`)
  }
  const port = parsePortFromWebsocketUrl(agent.deployment.cloud.websocketUrl)
  if (!port) {
    return invalidState(
      `agent ${agentId} has no parseable port in deployment.cloud.websocketUrl (${agent.deployment.cloud.websocketUrl ?? 'unset'})`
    )
  }

  // Determine the mounts/env to apply: explicit override from config, or fall
  // back to the persisted values on the agent record.
  const newMounts = config.mounts !== undefined ? config.mounts : agent.deployment.sandbox?.mounts
  const existingRuntime = agent.deployment.cloud.runtime ?? {}
  const newExtraEnv = config.extraEnv !== undefined ? config.extraEnv : existingRuntime.extraEnv
  const useZiggy = config.ziggy !== undefined ? config.ziggy : (agent.deployment.sandbox?.ziggy === true)

  // Validate the operator pre-flight for Ziggy MCP integration BEFORE docker
  // stop+rm. Same loud-fail-on-missing-env-file contract as createDockerAgent.
  // Skipped when useZiggy is false — recreate-with-ziggy=false on a previously-
  // ziggy=true agent is a valid operation that should succeed without needing
  // the env file (the network attach + overlay mount just won't be applied).
  if (useZiggy) {
    try {
      fs.mkdirSync(ZIGGY_AGENT_ENVS_DIR, { recursive: true })
    } catch (err) {
      console.warn(
        `[update-runtime] Could not mkdir ${ZIGGY_AGENT_ENVS_DIR}:`,
        err instanceof Error ? err.message : err,
      )
    }
    const envFilePath = path.join(ZIGGY_AGENT_ENVS_DIR, `${agent.name}.env`)
    if (!fs.existsSync(envFilePath)) {
      return invalidRequest(
        `ziggy=true requires a per-agent env file at ${envFilePath}. ` +
          'Create it on the host with ZIGGY_PROFILE=default and ' +
          'DATABASE_URL=postgresql://ziggy:<password>@ziggy-postgres:5432/ziggy (pw from /opt/stacks/ziggy/.env), ' +
          'then retry.',
      )
    }
  }

  // Rebuild AI_TOOL from persisted fields. Matches recreate semantics — yolo,
  // prompt, and dashboard-supplied githubToken are NOT preserved (same gap
  // as buildRecreateBody, tracked separately). Resolve the program identifier
  // to its in-container binary name before composing — see createDockerAgent
  // for the load-bearing reason (PR-3 hotfix).
  const program = agent.program || 'claude'
  let aiTool = resolveStartCommand(program)
  if (agent.programArgs) {
    const sanitizedArgs = agent.programArgs.replace(/[^a-zA-Z0-9\s\-_.=/:,~@]/g, '').trim()
    if (sanitizedArgs) aiTool += ` ${sanitizedArgs}`
  }
  if (agent.model) {
    aiTool += ` --model ${agent.model}`
  }

  const workDir = agent.workingDirectory || '/tmp'
  const cpus = existingRuntime.cpus ?? 2
  const memory = existingRuntime.memory ?? '4g'
  const autoRemove = existingRuntime.autoRemove ?? false

  const hostPort = process.env.PORT || '23000'
  const hostInternalUrl = `http://host.docker.internal:${hostPort}`

  const baseEnv = buildBaseAgentEnv(agent.name, aiTool, hostInternalUrl)
  const ampEnv = buildAmpCommonEnv(agentId, agent.name, hostInternalUrl)
  const mergedEnv = mergeEnv({ ...baseEnv, ...ampEnv }, newExtraEnv)

  const ampMounts = buildAmpCommonMounts(agentId)
  const claudeReadthroughMounts = buildCloudClaudeReadthroughMounts(agentId)
  const geminiReadthroughMounts = buildCloudGeminiReadthroughMounts(agentId)
  const antigravityMount = buildCloudAntigravityAppDataMount(agentId)
  const restorationSentinelMount = buildCloudRestorationSentinelMount(agentId)

  // Pre-create host-side mount sources so docker doesn't materialize them as
  // root-owned dirs at run time. Same pattern as createDockerAgent.
  for (const m of [...ampMounts, ...claudeReadthroughMounts, ...geminiReadthroughMounts, antigravityMount, restorationSentinelMount]) {
    try {
      fs.mkdirSync(m.hostPath, { recursive: true })
    } catch (err) {
      console.warn(`[update-runtime] Could not pre-create mount source ${m.hostPath}:`, err)
    }
  }

  // Clear any stale restoration sentinel from the previous container's run
  // BEFORE docker stop. Without this, the new container coming up after
  // docker run would observe the old sentinel during its boot window and
  // skip the wait, racing host-side prep again. See kanban fcabb870.
  clearRestorationSentinel(agentId)

  // (Re-)provision Codex Ziggy MCP entry if ziggy=true. Idempotent — the
  // helper short-circuits when the [mcp_servers.ziggy] block already exists
  // in config.toml. Mirrors the createDockerAgent provisioning sequence so
  // /update-runtime applied to a not-yet-Ziggy agent (flipping the flag on)
  // adds the MCP entry in-place.
  if (useZiggy) {
    try {
      provisionCloudCodexZiggyMcpEntry(agentId)
    } catch (err) {
      console.warn('[update-runtime] Could not provision cloud codex ziggy MCP entry:', err instanceof Error ? err.message : err)
    }
  }

  const mergedMounts = mergeMounts(
    [
      ...ampMounts,
      buildCloudClaudeSettingsMount(agentId),
      ...buildCloudClaudePersistMounts(agentId),
      ...claudeReadthroughMounts,
      buildCloudGeminiSettingsMount(agentId),
      buildCloudGeminiOAuthMount(agentId),
      ...geminiReadthroughMounts,
      buildCloudAntigravityAppDataMount(agentId),
      buildCloudCodexVersionMount(agentId),
      buildCloudCodexAuthMount(agentId),
      buildCloudCodexConfigTomlMount(agentId),
      buildCloudCodexHooksMount(agentId),
      ...(useZiggy ? [buildZiggyCodeMount(), buildZiggyEnvOverlayMount(agent.name)] : []),
      restorationSentinelMount,
    ],
    newMounts
  )

  // Stop + remove the existing container. Non-fatal if already stopped/gone
  // (the verify-removal step catches "still exists" failures and aborts).
  const safeContainerName = containerName.replace(/[^a-zA-Z0-9_-]/g, '')
  try {
    await execAsync(`docker stop ${safeContainerName}`, { timeout: 60000 })
  } catch (err) {
    console.log(`[update-runtime] stop ${containerName} (non-fatal):`, err instanceof Error ? err.message : err)
  }
  try {
    await execAsync(`docker rm ${safeContainerName}`, { timeout: 60000 })
  } catch (err) {
    console.log(`[update-runtime] rm ${containerName} (non-fatal):`, err instanceof Error ? err.message : err)
  }
  try {
    await execAsync(`docker inspect ${safeContainerName}`, { timeout: 5000 })
    return operationFailed(
      'remove old container',
      `${containerName} still exists after stop+rm; docker run would fail with a name conflict. Manual cleanup required.`
    )
  } catch {
    // inspect failed → container is gone, proceed
  }

  const dockerCmd = [
    'docker run -d',
    `--name "${containerName}"`,
    '--add-host=host.docker.internal:host-gateway',
    // Container hardening — MUST mirror createDockerAgent's flags so a
    // mount/env update (which destroys+recreates the container) does not
    // silently drop the security posture. See createDockerAgent for the
    // cap rationale and the --tmpfs verification flag.
    '--cap-drop=ALL',
    '--cap-add=NET_BIND_SERVICE --cap-add=SETGID --cap-add=SETUID --cap-add=CHOWN --cap-add=DAC_OVERRIDE --cap-add=FOWNER',
    '--security-opt no-new-privileges',
    // noexec dropped: it breaks TMPDIR-exec tooling (pip-from-source, cmake/ninja,
    // test harnesses spawning helper scripts) — reproduced on Oliver burn-in 2026-06-04.
    // cap-drop=ALL + no-new-privileges + nosuid + size cap retained (still strictly
    // harder than pre-merge baseline; cap-drop=ALL is the biggest privilege win).
    // explicit `exec` REQUIRED: Docker tmpfs defaults to noexec unless overridden,
    // so dropping noexec from the string alone silently leaves it applied (verified
    // on Oliver: mount-inside still showed noexec). `exec` forces it off.
    '--tmpfs /tmp:exec,nosuid,size=100m',
    autoRemove ? '' : '--restart unless-stopped',
    // Single-network attach when useZiggy=true: container joins ziggy_default
    // ONLY, not the default bridge. ai-maestro inter-agent comms are AMP over
    // filesystem (not Docker DNS), so isolation is fine today. If a future
    // feature needs container-to-container DNS for non-Ziggy agents, attach
    // the default bridge via `docker network connect bridge <container>`
    // post-create. Per Hutch ops review PR #157 note A.
    useZiggy ? `--network ${ZIGGY_NETWORK}` : '',
    ...buildEnvFlags(mergedEnv),
    `-v "${workDir}:/workspace"`,
    ...buildMountFlags(mergedMounts),
    `-p ${port}:23000`,
    `--cpus=${cpus}`,
    `--memory=${memory}`,
    autoRemove ? '--rm' : '',
    'ai-maestro-agent:latest',
  ].filter(Boolean).join(' ')

  let containerId: string
  try {
    const { stdout } = await execAsync(dockerCmd, { timeout: 30000 })
    containerId = stdout.trim().slice(0, 12)
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    return operationFailed('start container', message)
  }

  // Persist the new operator config onto the agent record. Failure here is
  // non-fatal but logged loudly — the running container has the new mounts,
  // but the registry would drift, so a future /recreate would lose them.
  try {
    updateAgentRuntimeConfig(agentId, {
      mounts: config.mounts,
      extraEnv: config.extraEnv,
      ziggy: config.ziggy,
    })
  } catch (err) {
    console.warn(
      `[update-runtime] registry update failed for ${agentId} after successful container rebuild — drift between container and registry:`,
      err instanceof Error ? err.message : err
    )
  }

  // Container was just rebuilt with the current registry's AI_TOOL fields, so
  // any prior PATCH-induced staleness is now resolved. See kanban aa2953b0.
  // No-op if the flag wasn't set; never fails fatally (mirrors the registry-
  // update try/catch above).
  try {
    clearCloudContainerStale(agentId)
  } catch (err) {
    console.warn(
      `[update-runtime] clearCloudContainerStale failed for ${agentId} — flag may linger until next /update-runtime:`,
      err instanceof Error ? err.message : err
    )
  }

  // Signal the new container that host-side prep is complete and it can
  // proceed past the restoration-ready gate (kanban fcabb870). Mirrors the
  // createDockerAgent tail. Best-effort; failure here leaves the container
  // blocked on its 10s timeout, then it proceeds with a warning.
  writeRestorationSentinel(agentId)

  return {
    data: {
      success: true,
      agentId,
      containerId,
      port,
      containerName,
    },
    status: 200,
  }
}

/**
 * Normalize a docker-inspect `HostConfig.Memory` byte value to the canonical
 * 'Xg' / 'Xm' string form that createDockerAgent accepts (default '4g'). Round
 * to nearest integer GiB for typical sizes; fall back to MiB for sub-GiB.
 */
export function formatMemoryBytesToString(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    throw new Error(`formatMemoryBytesToString: invalid byte count ${bytes}`)
  }
  const gibFloat = bytes / 1024 ** 3
  if (gibFloat >= 1) {
    const gibRounded = Math.round(gibFloat)
    // Within 1% of an integer GiB → use integer form (matches createDockerAgent
    // defaults of '2g' / '4g' that docker normalizes to exact powers of 1024).
    if (Math.abs(gibFloat - gibRounded) / gibRounded < 0.01) return `${gibRounded}g`
    return `${gibFloat.toFixed(2)}g`
  }
  const mib = Math.round(bytes / 1024 ** 2)
  return `${mib}m`
}

/**
 * One-time backfill of `deployment.cloud.runtime` (cpus, memory, autoRemove)
 * from `docker inspect` for legacy cloud agents that predate PR #146's
 * runtime-persistence write at create time. Without this, `/recreate` and
 * `/update-runtime` fall back to createDockerAgent's hard-coded defaults
 * (cpus=2, memory='4g') for these agents — silent downsize for any agent
 * that was originally created with non-default sizing via dashboard. See
 * kanban 1ef9eabd.
 *
 * Idempotent: skips agents whose runtime block already has BOTH cpus and
 * memory populated (the two fields that drive the silent-downsize hazard).
 * autoRemove and extraEnv presence is not part of the idempotency gate
 * (autoRemove defaults safely to false on a fresh runtime block; extraEnv
 * is operator-driven and not part of the legacy gap).
 *
 * Read-only with respect to the running container — docker inspect doesn't
 * touch container state, and updateAgentRuntimeConfig is a registry-only
 * write. No /update-runtime / docker rebuild is triggered.
 */
export async function backfillAgentRuntime(
  agentId: string
): Promise<ServiceResult<Record<string, unknown>>> {
  const agent = getAgent(agentId, true)
  if (!agent) return notFound('Agent', agentId)
  if (agent.deletedAt) return gone('Agent')

  if (
    agent.deployment?.type !== 'cloud' ||
    agent.deployment.cloud?.provider !== 'local-container'
  ) {
    return invalidState(
      `backfill-runtime is only supported for cloud agents with provider 'local-container' (agent ${agentId} is type=${agent.deployment?.type ?? 'unset'}, provider=${agent.deployment?.cloud?.provider ?? 'unset'})`
    )
  }

  const existing = agent.deployment.cloud.runtime
  if (existing?.cpus !== undefined && existing?.memory !== undefined) {
    return {
      data: {
        success: true,
        agentId,
        action: 'skipped',
        reason: 'runtime already populated (cpus + memory present)',
        runtime: existing,
      },
      status: 200,
    }
  }

  const containerName = agent.deployment.cloud.containerName
  if (!containerName) {
    return invalidState(
      `agent ${agentId} has no containerName — cannot run docker inspect for backfill`
    )
  }

  const safeContainerName = containerName.replace(/[^a-zA-Z0-9_-]/g, '')
  let inspectOutput: string
  try {
    const { stdout } = await execAsync(
      `docker inspect ${safeContainerName} --format '{{.HostConfig.NanoCpus}}|{{.HostConfig.Memory}}|{{.HostConfig.AutoRemove}}'`,
      { timeout: 5000 }
    )
    inspectOutput = stdout.trim()
  } catch (err) {
    return operationFailed(
      'docker inspect',
      err instanceof Error ? err.message : String(err)
    )
  }

  const [nanoCpusStr, memoryStr, autoRemoveStr] = inspectOutput.split('|')
  const nanoCpus = parseInt(nanoCpusStr ?? '', 10)
  const memoryBytes = parseInt(memoryStr ?? '', 10)
  const cpus = nanoCpus / 1e9

  if (!Number.isFinite(cpus) || cpus <= 0) {
    return operationFailed(
      'parse docker inspect cpus',
      `NanoCpus=${nanoCpusStr} (computed cpus=${cpus}) is not a positive number; container may have unbounded CPU. Operator must set cpus explicitly before backfill is safe.`
    )
  }
  if (!Number.isFinite(memoryBytes) || memoryBytes <= 0) {
    return operationFailed(
      'parse docker inspect memory',
      `Memory=${memoryStr} bytes is not a positive number; container may have unbounded memory. Operator must set memory explicitly before backfill is safe.`
    )
  }

  let memory: string
  try {
    memory = formatMemoryBytesToString(memoryBytes)
  } catch (err) {
    return operationFailed(
      'format memory',
      err instanceof Error ? err.message : String(err)
    )
  }
  const autoRemove = autoRemoveStr === 'true'

  const updated = updateAgentRuntimeConfig(agentId, { cpus, memory, autoRemove })
  if (!updated) {
    return invalidState(`agent ${agentId} disappeared during backfill`)
  }

  return {
    data: {
      success: true,
      agentId,
      action: 'backfilled',
      runtime: { cpus, memory, autoRemove },
    },
    status: 200,
  }
}

// ---------------------------------------------------------------------------
// GET /api/docker/stats — resource usage for all running agent containers
// ---------------------------------------------------------------------------

export interface ContainerStats {
  containerName: string
  agentId?: string
  cpu: number         // percentage (0-100+)
  memoryUsageMb: number
  memoryLimitMb: number
  memoryPercent: number
  netInputMb: number
  netOutputMb: number
  pids: number
}

export async function getDockerStats(): Promise<ServiceResult<{ containers: ContainerStats[] }>> {
  try {
    const { stdout } = await execAsync(
      'docker stats --no-stream --format \'{"name":"{{.Name}}","cpu":"{{.CPUPerc}}","memUsage":"{{.MemUsage}}","memPerc":"{{.MemPerc}}","netIO":"{{.NetIO}}","pids":"{{.PIDs}}"}\'',
      { timeout: 10000 }
    )

    if (!stdout.trim()) {
      return { data: { containers: [] }, status: 200 }
    }

    const agents = loadAgents()
    const agentByContainer = new Map<string, string>()
    for (const a of agents) {
      const cn = a.deployment?.cloud?.containerName
      if (cn) agentByContainer.set(cn, a.id)
    }

    const containers: ContainerStats[] = []

    for (const line of stdout.trim().split('\n')) {
      try {
        const raw = JSON.parse(line)
        if (!raw.name?.startsWith('aim-')) continue

        const parseMb = (s: string): number => {
          const m = s.match(/([\d.]+)\s*(GiB|MiB|KiB|GB|MB|KB|B)/i)
          if (!m) return 0
          const val = parseFloat(m[1])
          const unit = m[2].toLowerCase()
          if (unit === 'gib' || unit === 'gb') return val * 1024
          if (unit === 'mib' || unit === 'mb') return val
          if (unit === 'kib' || unit === 'kb') return val / 1024
          return val / (1024 * 1024)
        }

        const memParts = raw.memUsage.split('/')
        containers.push({
          containerName: raw.name,
          agentId: agentByContainer.get(raw.name),
          cpu: parseFloat(raw.cpu) || 0,
          memoryUsageMb: parseMb(memParts[0] || ''),
          memoryLimitMb: parseMb(memParts[1] || ''),
          memoryPercent: parseFloat(raw.memPerc) || 0,
          netInputMb: parseMb((raw.netIO.split('/')[0]) || ''),
          netOutputMb: parseMb((raw.netIO.split('/')[1]) || ''),
          pids: parseInt(raw.pids, 10) || 0,
        })
      } catch {
        // skip malformed lines
      }
    }

    return { data: { containers }, status: 200 }
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    if (msg.includes('not found') || msg.includes('Cannot connect')) {
      return { data: { containers: [] }, status: 200 }
    }
    return operationFailed('get docker stats', msg)
  }
}
