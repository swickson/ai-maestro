/**
 * Regression coverage for agent-container/incontainer-pg-bootstrap.sh.
 *
 * Locks the fail-loud contract surfaced in review (#261): the script must NOT
 * write the success env fragment (TEST_DATABASE_URL) or exit 0 when the bootstrap
 * cannot legitimately complete — otherwise downstream suite config sees
 * TEST_DATABASE_URL=loopback and passes its DSN assertion against a DB that may
 * be absent / empty / unmigrated (the false-green).
 *
 * SCOPE — these cases are deliberately POSTGRES-FREE: each fails at a guard that
 * fires BEFORE the script would start a Postgres server (the memory-DSN guard,
 * the opt-in gate, and the loopback-DSN-missing abort). That keeps this CI test
 * hermetic and bounded.
 *
 * Why not the migrate-fail / empty-schema (migrate-exits-0-but-no-tables) cases
 * here: those fire AFTER `pg_ctl start`, so the script would launch a real
 * Postgres. On a Postgres-equipped CI runner that daemonized server inherits
 * spawnSync's stderr pipe, so spawnSync blocks reading-to-EOF forever (it hung a
 * CI run ~1h before this was scoped down). Those two false-green cases are
 * validated IN-CONTAINER instead (against the built agent image with a live PG):
 *   migrate=false        -> RC=1, no fragment
 *   migrate exits 0 / 0 tables -> RC=1, no fragment ("no public tables")
 *   real table created   -> RC=0, fragment written
 * plus a full from-empty n4 migrate (77 tables) + integration suite green.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const SCRIPT = path.join(__dirname, '..', 'agent-container', 'incontainer-pg-bootstrap.sh')

// Hard safety net: no invocation in this suite should reach `pg_ctl start`, but
// if a future edit regresses that, the timeout kills it rather than hanging CI.
function runBootstrap(env: Record<string, string>, fragmentPath: string, pgdata: string) {
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    timeout: 15000,
    killSignal: 'SIGKILL',
    env: {
      ...process.env,
      DB_BOOTSTRAP_ENV_FILE: fragmentPath,
      PGDATA: pgdata,
      ...env,
    },
  })
}

describe('incontainer-pg-bootstrap.sh — fail-loud contract (Postgres-free guards)', () => {
  let tmpDir: string
  let fragment: string
  let pgdata: string
  let workdir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aim-pgboot-'))
    fragment = path.join(tmpDir, 'frag.env')
    pgdata = path.join(tmpDir, 'pgdata')
    workdir = path.join(tmpDir, 'app')
    fs.mkdirSync(workdir, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('no-ops (exit 0, no fragment) when the opt-in flag is unset', () => {
    const r = runBootstrap(
      { INCONTAINER_PG_BOOTSTRAP: '', DATABASE_URL: '', TEST_DATABASE_URL: '', DB_BOOTSTRAP_WORKDIR: workdir },
      fragment,
      pgdata,
    )
    expect(r.status).toBe(0)
    expect(fs.existsSync(fragment)).toBe(false)
  })

  it('fails fatal (exit 1, no fragment) when REQUIRE_MEMORY_DATABASE_URL is set but MEMORY_DATABASE_URL is unset', () => {
    // The memory-DSN guard is the FIRST check in the script — fires before the
    // opt-in gate and before any Postgres step.
    const r = runBootstrap(
      {
        REQUIRE_MEMORY_DATABASE_URL: '1',
        MEMORY_DATABASE_URL: '',
        INCONTAINER_PG_BOOTSTRAP: '1',
        DATABASE_URL: '',
        TEST_DATABASE_URL: '',
        DB_BOOTSTRAP_WORKDIR: workdir,
      },
      fragment,
      pgdata,
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('MEMORY_DATABASE_URL')
    expect(fs.existsSync(fragment)).toBe(false)
  })

  it('fails fatal (non-zero, no fragment) when opted in but no loopback DSN is resolvable', () => {
    // INCONTAINER_PG_BOOTSTRAP=1 but neither TEST_DATABASE_URL nor DATABASE_URL
    // set => the script aborts at the loopback-DSN resolution, BEFORE initdb.
    // Fail-loud + no success fragment (no false-green from an unconfigured boot).
    const r = runBootstrap(
      {
        INCONTAINER_PG_BOOTSTRAP: '1',
        DATABASE_URL: '',
        TEST_DATABASE_URL: '',
        DB_BOOTSTRAP_WORKDIR: workdir,
      },
      fragment,
      pgdata,
    )
    expect(r.status).not.toBe(0)
    expect(fs.existsSync(fragment)).toBe(false)
  })
})
