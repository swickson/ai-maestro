#!/usr/bin/env bash
# in-container ephemeral Postgres bootstrap — AI Maestro shared agent image.
#
# TEAM-AGNOSTIC by design: this ships in the single fleet image but is OPTED IN
# per-agent via extraEnv, and NO-OPs unless the gate flag is set. That is what
# lets a new project reuse it with zero image change.
# See docs/CLOUD-AGENT-DB-ISOLATION.md (§3, §3.4).
#
# Invoked from the worker on-wake bootstrap clause AFTER `npm ci` (it needs the
# project's node_modules for the migrate step). Idempotent: safe to re-run.
#
# NOTE: deliberately NOT `set -u` — a sourced host shell snapshot trips
# nounset on an unbound ZSH_VERSION and silently empties command substitutions.
set -o pipefail

# --- ORCHESTRATOR-SCOPED guard: memory-DSN must be set explicitly -------------
# A shared memory-backend pool falls back to DATABASE_URL when MEMORY_DATABASE_URL
# is unset (apps/mcp-server src/db.ts: `memoryDatabaseUrl ?? databaseUrl`). On a
# recall-running orchestrator, DATABASE_URL is the app/test DSN — so an unset
# MEMORY_DATABASE_URL would silently route memory-backend writes into the WRONG
# database. This deterministic, container-enforced gate makes that fatal.
# SCOPED via REQUIRE_MEMORY_DATABASE_URL=1 (set ONLY on the orchestrator, via
# extraEnv) so it never fires for workers or for other agents that
# correctly rely on the DATABASE_URL fallback (their DATABASE_URL already IS the
# memory-backend DB). Independent of the PG-bootstrap gate below.
if [ "${REQUIRE_MEMORY_DATABASE_URL:-0}" = "1" ] && [ -z "${MEMORY_DATABASE_URL:-}" ]; then
  printf '[db-isolation] FATAL: REQUIRE_MEMORY_DATABASE_URL=1 but MEMORY_DATABASE_URL is unset.\n' >&2
  printf '[db-isolation]   the memory-backend would fall back to DATABASE_URL (the app/test DB) and write there.\n' >&2
  printf '[db-isolation]   Set MEMORY_DATABASE_URL in this agent extraEnv to the shared memory Postgres DSN.\n' >&2
  exit 1
fi

# --- gate: opt-in only, so this never fires in non-DB fleet containers --------
[ "${INCONTAINER_PG_BOOTSTRAP:-0}" = "1" ] || exit 0

log() { printf '[pg-bootstrap] %s\n' "$*" >&2; }

# The suite must hit the LOOPBACK db, never the ambient DATABASE_URL — which on
# an orchestrator (or any worker handed an investigation-branch .env) is the dev
# branch, NOT loopback. Resolve the loopback/test DSN explicitly: prefer
# TEST_DATABASE_URL (set in extraEnv whenever ambient DATABASE_URL != loopback),
# else DATABASE_URL (the common worker case, whose .env IS already loopback).
LOOPBACK_DSN="${TEST_DATABASE_URL:-${DATABASE_URL:-}}"
if [ -z "${LOOPBACK_DSN}" ]; then
  log "INCONTAINER_PG_BOOTSTRAP=1 but neither TEST_DATABASE_URL nor DATABASE_URL is set — aborting"; exit 1
fi

# PGDATA must NOT default into /tmp: the container's /tmp is a tmpfs capped at
# size=100m (services/agents-docker-service.ts --tmpfs /tmp), and a real
# from-empty schema + integration fixtures overflows that (ENOSPC mid-migrate).
# /var/tmp lives in the container writable layer — ephemeral (gone on /recreate),
# reinitialized every wake, and not size-capped. The unix socket stays in /tmp
# (a socket file is tiny). Override PGDATA to taste.
PGDATA="${PGDATA:-/var/tmp/aim-pgdata}"
PGPORT="${PGPORT:-5432}"
WORKDIR="${DB_BOOTSTRAP_WORKDIR:-apps/web}"
MIGRATE_CMD="${DB_BOOTSTRAP_MIGRATE_CMD:-npx prisma generate && npx prisma migrate deploy}"

# Anchor a RELATIVE WORKDIR to the repo git-root so this script works regardless
# of the caller's CWD. The `cd "${WORKDIR}"` before the migrate step assumed CWD
# was already the repo root; invoking from elsewhere (e.g. from inside apps/web)
# aborted with a spurious "workdir missing". When WORKDIR is relative and we're
# inside a git work tree, resolve it against the git toplevel; otherwise leave it
# CWD-relative (unchanged fallback). The agent-server.js entrypoint stage sets CWD
# to the repo root already, so this is belt-and-suspenders there and the real fix
# for any hand-invocation from a subdir.
case "${WORKDIR}" in
  /*) : ;;  # absolute path: honor as given
  *)
    GIT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
    [ -n "${GIT_ROOT}" ] && WORKDIR="${GIT_ROOT}/${WORKDIR}"
    ;;
esac

# Fail FAST (before initdb) when the project workdir / its deps aren't present —
# nothing downstream can migrate without them, so don't spin up Postgres first.
# (The agent-server.js entrypoint gate already skips invoking us when node_modules
# is absent; this is the defense-in-depth + the hand-invocation guard.)
if [ ! -d "${WORKDIR}" ]; then
  log "workdir '${WORKDIR}' missing — has 'npm ci' run yet? aborting"; exit 1
fi

# postgres server binaries (initdb/pg_ctl/postgres) live in the versioned dir,
# which is not on the default PATH. Scope it here rather than baking the image
# PATH (the runtime PATH is overridden by createDockerAgent and wouldn't carry).
export PATH="/usr/lib/postgresql/16/bin:${PATH}"

# --- parse role / password / db out of the LOOPBACK dsn (no separate creds) ----
# postgresql://USER:PW@HOST:PORT/DB?params
proto_stripped="${LOOPBACK_DSN#*://}"
creds="${proto_stripped%%@*}"
PG_USER="${creds%%:*}"
PG_PW="${creds#*:}"
hostpart="${proto_stripped#*@}"
dbpart="${hostpart#*/}"
PG_DB="${dbpart%%\?*}"
if [ -z "${PG_USER}" ] || [ -z "${PG_DB}" ]; then
  log "could not parse role/db from the loopback DSN — aborting"; exit 1
fi

# --- bring up an ephemeral throwaway PG on loopback, FRESH FROM EMPTY ----------
# Runs as the unprivileged container user (uid 1000); never as root.
if pg_ctl -D "${PGDATA}" status >/dev/null 2>&1; then
  log "postgres already running at ${PGDATA} (reuse)"
else
  log "initdb -> fresh empty datadir at ${PGDATA}"
  rm -rf "${PGDATA}"; mkdir -p "${PGDATA}"
  initdb -D "${PGDATA}" --no-sync --username=postgres >/dev/null \
    || { log "FATAL: initdb failed (is the postgresql-<major> server pkg in the image + on PATH?)"; exit 1; }
  pg_ctl -D "${PGDATA}" -o "-k /tmp -p ${PGPORT} -c listen_addresses=localhost" -w start \
    || { log "FATAL: pg_ctl start failed"; exit 1; }
fi

# Fail loud if Postgres is not actually accepting connections. Without this, a
# silently-failed start/initdb lets the create+migrate steps below no-op and the
# script would STILL write the success fragment + exit 0 — the false-green
# (broken/empty/unmigrated loopback DB looking ready) caught in review.
psql -h localhost -p "${PGPORT}" -U postgres -tAc 'SELECT 1' >/dev/null 2>&1 \
  || { log "FATAL: postgres not accepting connections on localhost:${PGPORT}"; exit 1; }

# --- create role + db to match the DSN (idempotent) ---------------------------
role_exists="$(psql -h localhost -p "${PGPORT}" -U postgres -tAc \
  "SELECT 1 FROM pg_roles WHERE rolname='${PG_USER}'" 2>/dev/null)"
if [ "${role_exists}" != "1" ]; then
  psql -h localhost -p "${PGPORT}" -U postgres -v ON_ERROR_STOP=1 \
    -c "CREATE ROLE \"${PG_USER}\" WITH LOGIN PASSWORD '${PG_PW}' SUPERUSER;" \
    || { log "FATAL: CREATE ROLE ${PG_USER} failed"; exit 1; }
fi
db_exists="$(psql -h localhost -p "${PGPORT}" -U postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname='${PG_DB}'" 2>/dev/null)"
if [ "${db_exists}" != "1" ]; then
  psql -h localhost -p "${PGPORT}" -U postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE \"${PG_DB}\" OWNER \"${PG_USER}\";" \
    || { log "FATAL: CREATE DATABASE ${PG_DB} failed"; exit 1; }
fi

# --- migrate from empty -------------------------------------------------------
# This from-empty run IS the authoritative correctness proof; it also recreates
# the append-only AuditLog immutability trigger the integration suite depends on,
# so it MUST complete before the DB-backed gate runs.
cd "${WORKDIR}" || exit 1
# Migrate AGAINST LOOPBACK explicitly — never the ambient DATABASE_URL (which on
# an orchestrator is the dev branch). Prisma reads DATABASE_URL, so pin it here.
log "migrating in $(pwd) against loopback: ${MIGRATE_CMD}"
DATABASE_URL="${LOOPBACK_DSN}" bash -c "${MIGRATE_CMD}" \
  || { log "FATAL: migrate command failed (${MIGRATE_CMD}) — NOT writing the success fragment"; exit 1; }

# --- anti-false-green: verify the migrate actually produced schema ------------
# A migrate that exits 0 but produced NO schema (a no-op command, or a failure
# swallowed upstream) would still let an EMPTY loopback DB pass the suite's
# DSN-value assertion. Require the loopback DB to actually have tables before we
# declare success. GENERIC (public-table count) on purpose — NOT _prisma_migrations
# or a named table — so the check stays team-agnostic for non-Prisma migrate cmds.
verify_tables="$(psql -h localhost -p "${PGPORT}" -U postgres -d "${PG_DB}" -tAc \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'" 2>/dev/null)" \
  || { log "FATAL: post-migrate verification could not query db '${PG_DB}'"; exit 1; }
if [ "${verify_tables:-0}" -lt 1 ]; then
  log "FATAL: migrate exited 0 but db '${PG_DB}' has no public tables — refusing success (would false-green an empty DB)"
  exit 1
fi
log "post-migrate check: db '${PG_DB}' has ${verify_tables} public table(s)"

# Hand the loopback DSN to the integration suite via TEST_DATABASE_URL. The N4
# suite config resolves TEST_DATABASE_URL ?? DATABASE_URL ?? .env and asserts
# loopback (the suite-config assert), so this is what makes the suite hit loopback even
# when the agent's ambient DATABASE_URL is a dev branch. A bare `export` only
# reaches a child/same-shell, so ALSO drop a sourceable fragment for the on-wake
# clause to `source` before it invokes the suite.
export TEST_DATABASE_URL="${LOOPBACK_DSN}"
BOOTSTRAP_ENV="${DB_BOOTSTRAP_ENV_FILE:-/var/tmp/aim-db-bootstrap.env}"
printf 'export TEST_DATABASE_URL=%q\n' "${LOOPBACK_DSN}" > "${BOOTSTRAP_ENV}"
log "bootstrap complete -> db '${PG_DB}' on localhost:${PGPORT}; TEST_DATABASE_URL exported + written to ${BOOTSTRAP_ENV}"
