/**
 * Regression coverage for agent-container/incontainer-pg-bootstrap.sh.
 *
 * Locks the fail-loud contract surfaced in review: the script must NOT write the
 * success env fragment (TEST_DATABASE_URL) or exit 0 when the bootstrap actually
 * failed — otherwise downstream suite config sees TEST_DATABASE_URL=loopback and
 * passes its DSN assertion against a DB that may be absent / empty / unmigrated
 * (the false-green). Each critical step (initdb, pg_ctl, role/db create, migrate)
 * now guards with an explicit non-zero exit BEFORE the fragment write.
 *
 * These cases are Postgres-free: the failure fires upstream of the fragment write
 * (initdb absent in CI, or a deliberately-failing migrate command), so they run
 * in any environment without a real Postgres server.
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { spawnSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'

const SCRIPT = path.join(__dirname, '..', 'agent-container', 'incontainer-pg-bootstrap.sh')
const LOOPBACK = 'postgresql://appuser:apppass@localhost:5432/app_test?schema=public'

function runBootstrap(env: Record<string, string>, fragmentPath: string, pgdata: string) {
  return spawnSync('bash', [SCRIPT], {
    encoding: 'utf8',
    env: {
      ...process.env,
      DB_BOOTSTRAP_ENV_FILE: fragmentPath,
      PGDATA: pgdata, // keep PGDATA inside the temp dir, never the default /var/tmp
      ...env,
    },
  })
}

describe('incontainer-pg-bootstrap.sh — fail-loud contract', () => {
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
      { INCONTAINER_PG_BOOTSTRAP: '', DATABASE_URL: LOOPBACK, DB_BOOTSTRAP_WORKDIR: workdir },
      fragment,
      pgdata,
    )
    expect(r.status).toBe(0)
    expect(fs.existsSync(fragment)).toBe(false)
  })

  it('fails non-zero and does NOT write the success fragment when the bootstrap fails', () => {
    // Opt-in ON + a deliberately-failing migrate. Whether or not a Postgres
    // server exists in the test env, the script must exit non-zero before the
    // fragment write (initdb-absent guard, or the migrate guard on `false`).
    const r = runBootstrap(
      {
        INCONTAINER_PG_BOOTSTRAP: '1',
        DATABASE_URL: LOOPBACK,
        DB_BOOTSTRAP_WORKDIR: workdir,
        DB_BOOTSTRAP_MIGRATE_CMD: 'false',
      },
      fragment,
      pgdata,
    )
    expect(r.status).not.toBe(0)
    expect(fs.existsSync(fragment)).toBe(false)
  })

  it('fails fatal when REQUIRE_MEMORY_DATABASE_URL is set but MEMORY_DATABASE_URL is unset', () => {
    const r = runBootstrap(
      {
        REQUIRE_MEMORY_DATABASE_URL: '1',
        MEMORY_DATABASE_URL: '',
        INCONTAINER_PG_BOOTSTRAP: '1',
        DATABASE_URL: LOOPBACK,
        DB_BOOTSTRAP_WORKDIR: workdir,
      },
      fragment,
      pgdata,
    )
    expect(r.status).toBe(1)
    expect(r.stderr).toContain('MEMORY_DATABASE_URL')
    expect(fs.existsSync(fragment)).toBe(false)
  })
})
