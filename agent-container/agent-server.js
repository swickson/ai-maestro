#!/usr/bin/env node
/**
 * Agent WebSocket Server
 *
 * This runs INSIDE each agent container and provides:
 * 1. WebSocket server for browser connections
 * 2. node-pty bridge to tmux session
 * 3. Health check endpoint
 *
 * The container exposes port 23000, and browsers connect to:
 * - Local: ws://localhost:23000/term
 * - Cloud: wss://agent.aimaestro.com/term
 */

const http = require('http')
const fs = require('fs')
const path = require('path')
const { WebSocketServer } = require('ws')
const pty = require('node-pty')
const { spawn } = require('child_process')
const { promisify } = require('util')
const exec = promisify(require('child_process').exec)
const { ensureClaudeHomeTheme } = require('./claude-home-merge.cjs')
const { waitForRestorationReady } = require('./restoration-gate.cjs')
const { parseAiToolBinary, runtimeMissingMessage } = require('./runtime-check.cjs')

// Configuration from environment variables
const PORT = process.env.AGENT_PORT || 23000
const AGENT_ID = process.env.AGENT_ID || 'agent-' + Math.random().toString(36).substring(7)
const SESSION_NAME = process.env.TMUX_SESSION_NAME || 'agent-session'
const WORKSPACE = process.env.WORKSPACE || '/workspace'
// AI tool to start in the session (e.g., 'claude', 'aider', 'cursor', or empty for shell only)
const AI_TOOL = process.env.AI_TOOL || ''
// Host ai-maestro URL for heartbeat. Empty disables heartbeat (e.g., local dev without a host).
const AIMAESTRO_HOST_URL = process.env.AIMAESTRO_HOST_URL || ''
const HEARTBEAT_INTERVAL_MS = 60_000

console.log(`
╔═══════════════════════════════════════════════════════════════╗
║                   AI Maestro Agent Container                  ║
╚═══════════════════════════════════════════════════════════════╝

Agent ID:       ${AGENT_ID}
Session Name:   ${SESSION_NAME}
Workspace:      ${WORKSPACE}
WebSocket Port: ${PORT}

Starting WebSocket server...
`)

// HTTP server for health checks
const httpServer = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({
      status: 'healthy',
      agentId: AGENT_ID,
      sessionName: SESSION_NAME,
      workspace: WORKSPACE,
      timestamp: new Date().toISOString()
    }))
  } else if (req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/plain' })
    res.end(`AI Maestro Agent: ${AGENT_ID}\nWebSocket: ws://host:${PORT}/term\n`)
  } else {
    res.writeHead(404)
    res.end('Not Found')
  }
})

// WebSocket server
const wss = new WebSocketServer({
  server: httpServer,
  path: '/term'
})

// Active PTY sessions (shared across multiple WebSocket clients)
const sessions = new Map()

// Configure git with credentials
async function configureGit() {
  try {
    const gitUserName = process.env.GIT_USER_NAME || 'AI Maestro Agent'
    const gitUserEmail = process.env.GIT_USER_EMAIL || 'agent@23blocks.com'
    const githubToken = process.env.GITHUB_TOKEN

    console.log(`\n[Git Configuration]`)

    // Set git user name and email
    await exec(`git config --global user.name "${gitUserName}"`)
    await exec(`git config --global user.email "${gitUserEmail}"`)
    console.log(`✓ Configured git user: ${gitUserName} <${gitUserEmail}>`)

    // Configure git credential helper to use token
    if (githubToken) {
      // Store credentials in memory (not on disk for security)
      await exec(`git config --global credential.helper 'cache --timeout=86400'`)

      // Configure git to use HTTPS with token
      await exec(`git config --global url."https://${githubToken}@github.com/".insteadOf "https://github.com/"`)
      console.log(`✓ Configured GitHub authentication with token`)
    } else {
      console.log(`⚠ No GITHUB_TOKEN provided - git push will not work`)
      console.log(`  Set GITHUB_TOKEN environment variable to enable git push`)
    }
  } catch (err) {
    console.error(`✗ Failed to configure git:`, err.message)
  }
}

// Periodic heartbeat to host ai-maestro so listAgents reports this cloud agent online
// via hasRecentHeartbeat (services/agents-core-service.ts). Without this, cloud agents
// have no tmux session AND no heartbeat → always rendered offline in the dashboard list.
let heartbeatTimer = null
function startHeartbeat() {
  if (!AIMAESTRO_HOST_URL) {
    console.log(`ℹ AIMAESTRO_HOST_URL not set — heartbeat disabled`)
    return
  }
  const url = `${AIMAESTRO_HOST_URL.replace(/\/$/, '')}/api/agents/${encodeURIComponent(AGENT_ID)}/heartbeat`
  console.log(`ℹ Heartbeat enabled: POST ${url} every ${HEARTBEAT_INTERVAL_MS / 1000}s`)
  let lastErrorMessage = null
  const beat = async () => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ status: 'active' }),
        signal: AbortSignal.timeout(10_000),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      if (lastErrorMessage) {
        console.log(`✓ Heartbeat recovered`)
        lastErrorMessage = null
      }
    } catch (err) {
      const msg = err.message || String(err)
      if (msg !== lastErrorMessage) {
        console.error(`✗ Heartbeat failed: ${msg}`)
        lastErrorMessage = msg
      }
    }
  }
  beat()
  heartbeatTimer = setInterval(beat, HEARTBEAT_INTERVAL_MS)
}

// Flag-gated in-container Postgres bootstrap — entrypoint stage.
//
// Runs incontainer-pg-bootstrap.sh BEFORE the AI tool launches so a DB-isolated
// agent (worker OR orchestrator) never gets the keyboard before its loopback PG
// is migrated and ready. Deliberately runs HERE in agent-server.js (the container
// CMD), NOT as a Claude SessionStart hook: a Claude hook both blocks session-ready
// and injects its stdout into the agent's context window, and the cold
// initdb/migrate output poisoned claude startup (wedged pre-first-API). Here the
// script's stdout goes only to the container logs — it can never reach the agent
// context. agent-server.js is also the single launcher for claude/codex/
// antigravity, so one insertion covers every harness.
//
// Gate: INCONTAINER_PG_BOOTSTRAP=1 AND the project's <workdir>/node_modules is
// present (the migrate step needs it). node_modules persists on the host-bind
// workspace, so deps-present is the steady-state hot path on every wake. On
// first-create / pre-npm-ci / never-cloned (empty workspace, e.g. an antigravity
// worker that never got a task) it is absent and we QUIETLY skip — letting the
// on-wake instruction clause clone+npm ci+bootstrap as it does today.
//
// The repo root differs by seat: a worker clones into /workspace/repo, while an
// orchestrator binds the repo at /workspace. Probe both, keyed off the SAME
// DB_BOOTSTRAP_WORKDIR the script honors so the gate and the script cannot drift.
async function bootstrapDbIfEnabled() {
  if (process.env.INCONTAINER_PG_BOOTSTRAP !== '1') return // not a DB-isolated seat
  const workdirRel = process.env.DB_BOOTSTRAP_WORKDIR || 'apps/web'
  // Resolve where node_modules must be, mirroring the script's WORKDIR handling:
  // an ABSOLUTE DB_BOOTSTRAP_WORKDIR is honored as-is (the script cd's straight to
  // it, so the spawn cwd is irrelevant); otherwise it's relative to the repo root,
  // which differs by seat — a worker clones into /workspace/repo while an
  // orchestrator binds the repo at /workspace (probe /workspace first so the real
  // bind wins if a seat ever had both).
  let repoRoot = null
  if (path.isAbsolute(workdirRel)) {
    if (fs.existsSync(path.join(workdirRel, 'node_modules'))) repoRoot = '/workspace'
  } else {
    for (const root of ['/workspace', '/workspace/repo']) {
      if (fs.existsSync(path.join(root, workdirRel, 'node_modules'))) { repoRoot = root; break }
    }
  }
  if (!repoRoot) {
    const probed = path.isAbsolute(workdirRel) ? workdirRel : '/workspace[/repo]'
    console.log(`[db-bootstrap] INCONTAINER_PG_BOOTSTRAP=1 but ${workdirRel}/node_modules not found (probed ${probed}) — skipping (first-create/pre-npm-ci; on-wake instruction clause will bootstrap)`)
    return
  }
  console.log(`[db-bootstrap] running incontainer-pg-bootstrap.sh (cwd=${repoRoot}) before AI tool launch`)
  const code = await new Promise((resolve) => {
    const child = spawn('/usr/local/bin/incontainer-pg-bootstrap.sh', [], {
      cwd: repoRoot,
      stdio: 'inherit', // -> container logs ONLY; never the agent context window
    })
    child.on('exit', (c) => resolve(c))
    child.on('error', (err) => { console.error(`[db-bootstrap] spawn error: ${err.message}`); resolve(-1) })
  })
  if (code === 0) {
    console.log('[db-bootstrap] complete — loopback Postgres ready before AI tool launch')
  } else {
    // Do NOT block the launch on a bootstrap failure — a wedged agent is worse
    // than a degraded one. Surface loudly; the agent (or a manual re-run) recovers.
    console.error(`[db-bootstrap] FAILED (exit ${code}) — launching AI tool anyway; agent must bootstrap manually`)
  }
}

// Initialize tmux session on startup
async function initializeTmuxSession() {
  try {
    // Check if session already exists
    const { stdout } = await exec(`tmux has-session -t "${SESSION_NAME}" 2>&1`)
    console.log(`✓ tmux session "${SESSION_NAME}" already exists`)
  } catch (error) {
    // Session doesn't exist, create it
    console.log(`Creating new tmux session: ${SESSION_NAME}`)

    try {
      await exec(`tmux new-session -d -s "${SESSION_NAME}" -c "${WORKSPACE}"`)
      console.log(`✓ Created tmux session: ${SESSION_NAME}`)

      // Bring up the loopback DB (flag-gated, no-op for non-DB seats) BEFORE the
      // agent gets the keyboard. Awaited so a DB-isolated agent never starts its
      // tool before Postgres is migrated and ready. Runs in this CMD process (not
      // a Claude hook), so its output goes to container logs, never agent context.
      // The HTTP/health listener is already up (httpServer.listen fired before
      // this callback), so a slow from-empty migrate does not fail the healthcheck.
      await bootstrapDbIfEnabled()

      // Optionally start an AI tool in the session (e.g., 'claude', 'aider', 'cursor').
      //
      // Prepend `unset CI` so the AI tool sees an interactive environment.
      // Dockerfile bakes ENV CI=true (PR #100 / kanban 376265b9) to suppress
      // vitest watch-mode trap during build. But gemini-cli + claude-code both
      // check process.env.CI as a "non-interactive environment" heuristic and
      // degrade: gemini exits to bash on launch, claude drops to basic colors
      // / minimal status bar. Build-time CI=true stays in the image; the AI
      // tool's invocation shell explicitly drops it.
      if (AI_TOOL) {
        // #78 fail-loud: validate the resolved runtime binary is on PATH
        // BEFORE launch. A profile naming a runtime that isn't installed in
        // the image used to drop to a bare shell (or, pre-#171, silently run
        // claude), hiding the misconfiguration from operators. Probe the
        // binary and, when absent, surface a clear error into the session
        // instead of starting a broken/wrong runtime.
        const aiBinary = parseAiToolBinary(AI_TOOL)
        let runtimePresent = true
        try {
          await exec(`command -v "${aiBinary}"`)
        } catch {
          runtimePresent = false
        }
        if (!runtimePresent) {
          const msg = runtimeMissingMessage(aiBinary)
          console.error(`✗ ${msg}`)
          // Echo the cause into the session (stderr) so an attaching operator
          // sees WHY there's no agent running, rather than a silent shell.
          // Do NOT fall back to another runtime — that is the bug being fixed.
          const banner = `AI Maestro: ${msg}`.replace(/'/g, `'\\''`)
          await exec(`tmux send-keys -t "${SESSION_NAME}" "echo '${banner}' >&2" C-m`)
        } else {
          await exec(`tmux send-keys -t "${SESSION_NAME}" "unset CI && ${AI_TOOL}" C-m`)
          console.log(`✓ Started ${AI_TOOL} in session (with CI unset)`)
        }
      } else {
        console.log(`ℹ No AI_TOOL specified - session starts with shell only`)
      }
    } catch (err) {
      console.error(`✗ Failed to create tmux session:`, err.message)
    }
  }
}

// WebSocket connection handler
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress
  console.log(`\n[${new Date().toISOString()}] New WebSocket connection from ${clientIp}`)

  let ptyProcess = null
  const sessionKey = SESSION_NAME

  // Filled by the deferred-spawn block below for new sessions; null for reused sessions.
  // pendingInput buffers 'input' messages that arrive before the first 'resize' triggers spawn.
  // initFallbackTimer is cleared on close to avoid phantom-PTY leak if ws disconnects pre-spawn.
  let deferredSpawn = null
  let initFallbackTimer = null
  const pendingInput = []

  // Get or create PTY process for this tmux session
  if (sessions.has(sessionKey)) {
    console.log(`  → Reusing existing PTY for session: ${sessionKey}`)
    const sessionData = sessions.get(sessionKey)
    ptyProcess = sessionData.pty
    sessionData.clients.add(ws)
    console.log(`  → Total clients connected: ${sessionData.clients.size}`)

    // Send current screen content to new client
    exec(`tmux capture-pane -t "${sessionKey}" -p -S -50000 2>/dev/null || tmux capture-pane -t "${sessionKey}" -p 2>/dev/null || echo ""`)
      .then(({ stdout }) => {
        if (ws.readyState === 1) {
          if (stdout) {
            ws.send(stdout.replace(/\n/g, '\r\n'))
            console.log(`  ✓ Sent ${stdout.length} bytes of history to new client`)
          }
          // Host/cloud parity: emit history-complete so the client runs the
          // canonical post-history fit + PTY resize path (TerminalView's
          // history-complete handler). Without this, cloud agents skip the
          // post-history fit/resize that resyncs xterm grid to PTY/tmux dims.
          ws.send(JSON.stringify({ type: 'history-complete' }))
        }
      })
      .catch((err) => {
        console.error(`  ✗ Failed to capture pane:`, err.message)
        if (ws.readyState === 1) {
          ws.send(JSON.stringify({ type: 'history-complete' }))
        }
      })
  } else {
    console.log(`  → New session: ${sessionKey} (PTY spawn deferred until first resize)`)

    // Defer PTY spawn until the client sends its first resize message with
    // the actual browser viewport dimensions. The client (components/Terminal-
    // View.tsx) sends a resize immediately on WS connect, so spawn typically
    // happens within ms. This avoids the 80x24-then-resize flash where Claude
    // / gemini TUIs initially render at 80 cols then jump to the real size,
    // producing broken-line wrap on first paint (the operator empirical 2026-05-05
    // an agent screenshots).
    //
    // pendingInput (declared in outer scope) buffers any 'input' messages
    // that arrive before spawn (rare — client sends resize before any input
    // — but possible).

    const spawnPty = (cols, rows) => {
      if (sessions.has(sessionKey)) return  // already spawned by a sibling connect
      if (initFallbackTimer) {
        clearTimeout(initFallbackTimer)
        initFallbackTimer = null
      }
      console.log(`  → Spawning PTY at ${cols}x${rows}`)

      ptyProcess = pty.spawn('tmux', ['attach-session', '-t', sessionKey], {
        name: 'xterm-256color',
        cols,
        rows,
        cwd: WORKSPACE,
        env: process.env
      })

      sessions.set(sessionKey, {
        pty: ptyProcess,
        clients: new Set([ws])
      })

      // Capture and send initial screen content to first client
      setTimeout(() => {
        exec(`tmux capture-pane -t "${sessionKey}" -p -S -50000 2>/dev/null || tmux capture-pane -t "${sessionKey}" -p 2>/dev/null || echo ""`)
          .then(({ stdout }) => {
            if (ws.readyState === 1) {
              if (stdout) {
                ws.send(stdout.replace(/\n/g, '\r\n'))
                console.log(`  ✓ Sent ${stdout.length} bytes of initial content to first client`)
              }
              // Host/cloud parity — see reuse-PTY branch above.
              ws.send(JSON.stringify({ type: 'history-complete' }))
            }
          })
          .catch((err) => {
            console.error(`  ✗ Failed to capture initial pane:`, err.message)
            if (ws.readyState === 1) {
              ws.send(JSON.stringify({ type: 'history-complete' }))
            }
          })
      }, 150) // Wait for tmux attach to complete

      // Broadcast PTY output to all connected clients
      ptyProcess.onData((data) => {
        const sessionData = sessions.get(sessionKey)
        if (sessionData) {
          sessionData.clients.forEach((client) => {
            if (client.readyState === 1) { // WebSocket.OPEN
              try {
                client.send(data)
              } catch (err) {
                console.error(`  ✗ Error sending to client:`, err.message)
              }
            }
          })
        }
      })

      ptyProcess.onExit(({ exitCode, signal }) => {
        console.log(`\n[${new Date().toISOString()}] PTY exited for session: ${sessionKey}`)
        console.log(`  Exit code: ${exitCode}, Signal: ${signal}`)

        const sessionData = sessions.get(sessionKey)
        if (sessionData) {
          sessionData.clients.forEach((client) => {
            if (client.readyState === 1) {
              client.close(1000, 'PTY exited')
            }
          })
        }
        sessions.delete(sessionKey)
      })

      // Replay any input that arrived before spawn
      if (pendingInput.length > 0) {
        console.log(`  → Replaying ${pendingInput.length} buffered input chunk(s)`)
        pendingInput.forEach(chunk => ptyProcess.write(chunk))
        pendingInput.length = 0
      }

      console.log(`  ✓ PTY created and attached to tmux session`)
    }

    // Fallback: legacy clients that never send resize get the historical 80x24.
    // Modern clients send resize within the first event-loop tick after connect.
    initFallbackTimer = setTimeout(() => {
      console.log(`  ⚠ No resize within 500ms — falling back to legacy 80x24 default`)
      spawnPty(80, 24)
    }, 500)

    // Expose to message handler in outer scope.
    deferredSpawn = spawnPty
  }

  // Handle messages from client (terminal input)
  ws.on('message', (message) => {
    try {
      // Try to parse as JSON (for control messages)
      const data = JSON.parse(message.toString())

      if (data.type === 'input') {
        // Terminal input. Buffer if PTY hasn't spawned yet (deferred-spawn flow).
        if (ptyProcess) {
          console.log(`  → Input (JSON): "${data.data.substring(0, 50)}"`)
          ptyProcess.write(data.data)
        } else {
          console.log(`  → Input (JSON, buffered pre-spawn): "${data.data.substring(0, 50)}"`)
          pendingInput.push(data.data)
        }
      } else if (data.type === 'resize') {
        // Terminal resize. First resize on a new session triggers PTY spawn at
        // those dimensions (avoids 80x24-flash). Subsequent resizes fan through
        // the existing pty.resize.
        console.log(`  → Resize: ${data.cols}x${data.rows}`)
        if (ptyProcess) {
          ptyProcess.resize(data.cols, data.rows)
        } else if (deferredSpawn) {
          deferredSpawn(data.cols, data.rows)
        } else {
          console.warn(`  ⚠ Resize received but no ptyProcess and no deferredSpawn — ignoring`)
        }
      } else if (data.type === 'ping') {
        // Heartbeat
        ws.send(JSON.stringify({ type: 'pong' }))
      } else if (data.type === 'set-logging') {
        // Logging control - ignore for now (container doesn't support logging yet)
        console.log(`  → Logging ${data.enabled ? 'enabled' : 'disabled'}`)
      } else {
        console.log(`  → Unknown message type: ${data.type}`)
      }
    } catch (e) {
      // Not JSON, treat as raw terminal input. Buffer if PTY hasn't spawned yet.
      const msgStr = message.toString()
      console.log(`  → Input (raw): "${msgStr.substring(0, 50).replace(/[^\x20-\x7E]/g, '?')}"`)
      if (!ptyProcess) {
        pendingInput.push(msgStr)
        return
      }
      ptyProcess.write(msgStr)
    }
  })

  // Handle client disconnect
  ws.on('close', (code, reason) => {
    console.log(`\n[${new Date().toISOString()}] WebSocket disconnected`)
    console.log(`  Code: ${code}, Reason: ${reason || 'none'}`)

    // If ws disconnected before deferred PTY spawn fired, cancel the fallback
    // timer so we don't leak a phantom PTY with no clients.
    if (initFallbackTimer) {
      clearTimeout(initFallbackTimer)
      initFallbackTimer = null
    }

    const sessionData = sessions.get(sessionKey)
    if (sessionData) {
      sessionData.clients.delete(ws)
      console.log(`  → Remaining clients: ${sessionData.clients.size}`)

      // If no more clients, clean up after grace period
      if (sessionData.clients.size === 0) {
        console.log(`  → No clients remaining, starting 30s grace period...`)
        setTimeout(() => {
          const currentSessionData = sessions.get(sessionKey)
          if (currentSessionData && currentSessionData.clients.size === 0) {
            console.log(`  → Grace period expired, cleaning up PTY`)
            currentSessionData.pty.kill()
            sessions.delete(sessionKey)
          }
        }, 30000) // 30 second grace period
      }
    }
  })

  ws.on('error', (error) => {
    console.error(`\n[${new Date().toISOString()}] WebSocket error:`, error.message)
  })

  // Send initial connection success message
  ws.send(JSON.stringify({
    type: 'connected',
    agentId: AGENT_ID,
    sessionName: SESSION_NAME
  }))
})

// Start server
httpServer.listen(PORT, '0.0.0.0', async () => {
  console.log(`
✓ Agent server started successfully!

Health Check:  http://0.0.0.0:${PORT}/health
WebSocket:     ws://0.0.0.0:${PORT}/term

Waiting for browser connections...
`)

  // Configure git with credentials
  await configureGit()

  // Defense-in-depth: re-inject theme=dark into ~/.claude.json if claude-code
  // dropped it on its last shutdown. Host-side provisionCloudClaudeConfig
  // (services/agents-docker-service.ts:413-438, PR #120 / kanban 406ff85d)
  // seeds the field on create + on /recreate-via-migrateAgentPersistence so
  // the first-launch theme picker doesn't fire. But empirical 2026-05-22
  // mesh survey: 4-of-4 cloud claude agents post-launch (numStartups ≥ 22)
  // have theme MISSING, while 4-of-4 non-claude agents (claude never ran)
  // have theme intact — claude-code rewrites ~/.claude.json on launch and
  // doesn't preserve our seed. Running the same shape-aware merge here pre-
  // tmux means claude's next read always sees a complete shape, defending
  // against any future claude behavior that re-triggers the picker on the
  // missing-field signal. Idempotent + safe on non-claude programs (file
  // is bind-mounted unconditionally; no-op if theme already a string).
  ensureClaudeHomeTheme('/home/claude/.claude.json')

  // Gate AI_TOOL autostart behind the host-written restoration-ready sentinel.
  // Closes the Han EACCES race (kanban fcabb870) where docker-run-then-tmux-
  // send-keys fires before host-side mount prep + registry writes finish, so
  // the AI tool's first reads land on a workspace dir that's momentarily
  // root-owned or on bind targets that haven't been populated yet. Host writes
  // the sentinel at the end of createDockerAgent / updateContainerMountsAndExtraEnv;
  // this poll loop times out and proceeds anyway (fail-loud) if the writer
  // doesn't run for any reason — startup never blocks indefinitely.
  await waitForRestorationReady()

  // Initialize tmux session
  await initializeTmuxSession()

  // Begin heartbeat to host ai-maestro (no-op if AIMAESTRO_HOST_URL is unset)
  startHeartbeat()
})

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('\nReceived SIGTERM, shutting down gracefully...')

  if (heartbeatTimer) clearInterval(heartbeatTimer)

  // Close all WebSocket connections
  sessions.forEach((sessionData, sessionKey) => {
    console.log(`  Closing session: ${sessionKey}`)
    sessionData.clients.forEach((client) => {
      client.close(1000, 'Server shutting down')
    })
    sessionData.pty.kill()
  })

  httpServer.close(() => {
    console.log('Server closed')
    process.exit(0)
  })
})

process.on('SIGINT', () => {
  console.log('\nReceived SIGINT, shutting down...')
  process.exit(0)
})
