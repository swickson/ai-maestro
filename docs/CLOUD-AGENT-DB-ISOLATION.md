# Runbook: Per-Agent Database Isolation for Cloud-Agent Migration

> **Status:** DRAFT — authored by Hutch (ops, `ops-ziggy-deploy`) out of the N4 Safety migration decision (Hyper Syndicate meeting, 2026-06-20; greenlit by Shane). Companion to [`CLOUD-CODING-AGENT-RUNBOOK.md`](./CLOUD-CODING-AGENT-RUNBOOK.md) §11 (wave-based dev-team architecture): §11 isolates each agent's **git tree**; this doc isolates the **database** the agent's tests + migrations run against. Two project-specific values are marked `<<TBD: Zach spec>>` pending the N4 build and will be filled before this leaves DRAFT.
>
> **Why this is a reusable doc, not an N4 note:** the **AllianceOS** team migrates to cloud agents next on the same ai-maestro container model and hits the same remote-database issue. This is written generically — substitute your project's migrate command, DSN, and Postgres major.
>
> **Conventions:** `<agent-id>` = a UUID, `<operator>` = host user, `<<TBD: ...>>` = a project value to fill in.

---

## 1. The problem this solves

Containerizing a multi-agent team gives each agent its own **git tree** (per §11: `/workspace` per agent, push via `/transport.git`). That dissolves git-HEAD/branch/chat-state collisions. It does **not** touch a **shared database**.

If the team's tests and migrations run against a **real Postgres** (not mocks) and every agent points at **one shared dev DB**, git isolation just relocates the collision one layer down. Three failure modes follow, and they are not hypothetical — N4 hit all three:

1. **Migration drift / P3009.** Two agents mutating schema against one DB drift it. Raw-SQL constructs Prisma can't express (e.g. partial unique indexes) get re-`DROP`ped on every `migrate dev`, contaminating whatever migration is being authored — multiplied across agents.
2. **Fixture cross-contamination.** A real-`pg` integration suite run by two agents at once reads/writes the same tables simultaneously → non-deterministic failures neither agent caused nor can reproduce alone. Flaky by construction.
3. **Un-teardownable cruft (the worst).** If any table is **append-only/immutable at the DB layer** (e.g. an `AuditLog` whose `DELETE` is rejected by a trigger), an integration test that exercises an audited write **cannot tear down** the rows it created — nor the FK-anchored org/user behind them. A shared DB then **monotonically accumulates** cruft across every agent's every run, reclaimable only by a full reset-from-main. Unlike the git tree, which resets clean, the shared DB gets strictly **worse** over time.

**Net:** isolating git without isolating the DB re-creates forced-serial builds — the exact pain the migration exists to remove. Treat DB isolation as a **hard gate on cutover**, not a nice-to-have.

---

## 2. The decision rule (default vs. on-demand)

Separate two genuinely different needs; serving both beats picking one.

| Need | Frequency | Right tool |
|------|-----------|-----------|
| **A — build+test isolation** (every wake, every agent) | constant / hot path | **In-container ephemeral Postgres** (§3) |
| **B — data-driven investigation** ("why does this feature fail on *real data*") | occasional / targeted | **Standing, human-reset dev branch** the orchestrator works against (§4) |

> **A and B are not "workers vs orchestrator."** **A** (the loopback sidecar) is for *every* agent **including the orchestrator** — the orchestrator re-runs the merge-gate suite against loopback exactly like a worker. **B** (the branch) is **orchestrator-exclusive**, for investigation only. So the orchestrator uses **both**; only B is orchestrator-only.

**Default = A.** The integration suite seeds its **own** fixtures against an empty→migrated DB; it does **not want** prod data (prod data in that loop re-introduces exactly the fixture collisions + immutable-cruft + non-determinism you're solving). A version-pinned empty sidecar **is** the parity that gates merge, because the CI merge gate runs `postgres:16` (N4), not the prod engine.

**Do NOT put the data DB in the worker hot path.** Workers run the suite against the empty loopback sidecar (§3); the real-data branch (§4) is the orchestrator's alone. Keeping them split is an **isolation + correctness** call:

- **Isolation / correctness.** A shared real-data DB across parallel workers reintroduces exactly what §3 kills — migrate-drift, fixture cross-contamination, and un-teardownable immutable-`AuditLog` cruft. The from-empty sidecar is the merge-gate parity *and* the correctness proof; the data branch is for write-path *repro*, a different job.
- **Credential surface.** Workers stay credential-less w.r.t. the data branch — they never hold its DSN; only the orchestrator does. (The branch carries **dev** secrets — dev keys, prod lives in the deploy platform, e.g. Vercel — so handing its `.env` to a worker for a one-off investigation is safe; no prod-PII-in-every-worker to minimize. The earlier PII/CJIS-minimization framing is **retired** per Shane.)
- **Cost.** One standing dev branch (not branch-per-agent) is bounded Neon spend; the routine hot path never touches Neon.

---

## 3. Default: in-container ephemeral Postgres

### 3.1 Why in-container, not a sidecar container

The honest shape on this container model is a Postgres **process inside the agent's own container on loopback** — **not** a second/sibling container. Ground-truth from the model:

- Each agent is a **single `docker run`** (`services/agents-docker-service.ts`) — no compose project, no per-agent docker network.
- There is **no `/var/run/docker.sock`** inside the container (verified absent) — so an agent **cannot** orchestrate a sibling container, and the only lifecycle hook that runs in-container is **on-wake**.
- A true sibling sidecar would therefore require **new host-side code** in the `wake`/`hibernate`/`recreate` paths (per-agent network + second `docker run` + teardown wiring) — the fragile paths. In-container avoids all of it: no compose, no network, no creds, no host-orchestration code.

### 3.2 Build shape (ops-owned)

1. **Image:** add the `postgresql-16` **server** package to `ai-maestro-agent` (the image ships `postgresql-client` only today). **Major-pin only — do NOT exact-pin.** The merge gate runs the floating `postgres:16` Docker tag (itself major-pinned, minors/patches float); matching CI's *semantics* means major-pin. Exact-patch would make the sidecar **tighter than the gate it mirrors** — a false guarantee, plus a manual bump chore for security patches. Couple them: only exact-pin the sidecar if CI ever exact-pins. The package add is **unconditional** (it only costs image size); the *bootstrap* below is what must be scoped (step 2).
2. **Bootstrap on the container start path** (entrypoint / start gate — **not** the operator-editable on-wake hook alone, so it fires deterministically on initial create **and** every wake/restart, and a worker can't skip it). **Crucially, env-gate it with a TEAM-AGNOSTIC flag:** the agent image is shared across the *whole* mesh, so an unconditional initdb+migrate would fire in every non-project container and break them. Activate via a generic per-agent flag set in `extraEnv`; the script no-ops everywhere else. Make the flag **team-agnostic** (e.g. `INCONTAINER_PG_BOOTSTRAP=1`, final string team-ratified) so the *next* team (AllianceOS) opts in with **zero new image change** — a team-specific flag would force a fresh image edit and defeat the reuse goal. The script reads all project specifics from env (see §3.4), so one image mechanism serves every team.

   ```sh
   # start-path bootstrap — runs before the AI tool so the DB is ready before the gate.
   # GATED so it never fires in non-opted-in fleet containers (the agent image is SHARED mesh-wide).
   [ "${INCONTAINER_PG_BOOTSTRAP:-0}" = "1" ] || exit 0  # generic opt-in flag (final string team-ratified)

   export PGDATA=/tmp/pgdata                            # ephemeral; size up the /tmp tmpfs if the suite needs it
   rm -rf "$PGDATA"; initdb -D "$PGDATA" --no-sync --username=postgres
   pg_ctl -D "$PGDATA" -o "-k /tmp -p 5432 -c listen_addresses=localhost" -w start

   # match CI's DSN exactly (test.yml:96): role+pw n4safety, db n4safety_test
   psql -h localhost -U postgres -v ON_ERROR_STOP=1 <<'SQL'
     CREATE ROLE n4safety WITH LOGIN PASSWORD 'n4safety' SUPERUSER;
     CREATE DATABASE n4safety_test OWNER n4safety;
   SQL

   cd apps/web
   # The app/test DSN lives on its OWN env var + code path — NEVER the Ziggy memory-backend DSN.
   # (KAI Phase-3 scope guard: the same wake sequence also wires the shared memory Postgres for
   #  live-recall; the two DSNs must never conflate or race.)
   export DATABASE_URL='postgresql://n4safety:n4safety@localhost:5432/n4safety_test?schema=public'   # test.yml:96
   export ENCRYPTION_MASTER_KEY='<64-hex string, QUOTED>'   # test.yml:97 — YAML int-coercion trap if unquoted
   export NEXTAUTH_SECRET='<...>'                           # test.yml:98
   export NEXTAUTH_URL='http://localhost:3000'              # test.yml:99
   export NEXT_PUBLIC_APP_URL='http://localhost:3000'       # test.yml:100

   npx prisma generate
   npx prisma migrate deploy    # from-empty = the authoritative correctness proof; also recreates the
                                # AuditLog immutability trigger, so it MUST run before the gate.
   # -> pre-completion-check / integration gate runs next, against this loopback DB.
   ```

   Each agent gets its own Postgres on its own in-container `localhost:5432` — **zero creds, zero network exposure**, workers stay credential-less. (Values above are N4's, ground-truthed from `.github/workflows/test.yml`; another project substitutes its own DSN/env block/migrate command.)
3. **Ship** on the standard image path: COPY-parity gate → Holmes canary → **UUID-preserving** fleet roll (`update-runtime`, **not** `/recreate` — see §5). **Cross-review:** the builder does **not** self-verify; a different agent runs the integration suite against the canary to confirm byte-for-byte CI parity **before** the fleet roll.

### 3.3 Why it clears every bar

- **Isolation:** each agent's DB is its own loopback instance, rebuilt **from empty every cycle** — i.e. the clean-DB-from-empty correctness baseline, for free. Partial-index `DROP`s and fixtures contaminate **nobody else**.
- **Immutability survives:** an append-only `AuditLog` trigger is part of the schema, so `migrate deploy` **recreates it intact** on every sidecar. The immutability guarantee holds.
- **Cruft gone by construction:** teardown **drops the datadir** (or discards the writable layer) — it **never issues a `DELETE`** — so the immutable-cruft failure mode (§1.3) **cannot occur**. You don't clean the DB, you replace it.
- **Wake latency:** `initdb` (~1–2s) + `migrate deploy` (your migration count — the same cost CI already pays), on top of the existing per-rebuild `yarn install`. **Mitigation in reserve:** bake an already-`initdb`'d + migrated **template datadir** into the image at build time and `cp -a` it on wake (~1s); agents authoring new migrations just `migrate deploy` the delta.
- **Bootstrap ordering:** the start-path bootstrap brings PG up **before** the AI tool, so `pre-completion-check.sh`'s DB-backed gates (`migration:guard`, `readiness:guard`, integration suite) have a live DB when they run — satisfied natively.

### 3.4 Making it team-agnostic (the reuse contract)

The image ships **one** mechanism; each team opts in purely through `extraEnv`, with **no image change**. The full contract, split by seat:

**Worker-minimal (4 values)** — any agent that just runs the suite against its own loopback DB:
- **`<FLAG>=1`** — the generic opt-in (e.g. `INCONTAINER_PG_BOOTSTRAP`). Absent ⇒ the script `exit 0`s.
- **`DATABASE_URL`** — the loopback DSN (a worker's `.env` already points here). See the resolution note below.
- **`DB_BOOTSTRAP_WORKDIR`** (default `apps/web`) — the app subdir to run migrations from.
- **`DB_BOOTSTRAP_MIGRATE_CMD`** (default `npx prisma generate && npx prisma migrate deploy`) — override for non-Prisma stacks.

**Orchestrator (+3 values)** — the recall-running seat, whose ambient `DATABASE_URL` is a *dev branch*, not loopback:
- **`TEST_DATABASE_URL`** — the loopback DSN the suite must hit; required here because `DATABASE_URL` is the dev branch.
- **`REQUIRE_MEMORY_DATABASE_URL=1`** — makes the next var fatal-if-unset (the deterministic guard).
- **`MEMORY_DATABASE_URL`** — the shared memory-backend DSN, kept off `DATABASE_URL` so memory never bleeds into the app DB.

**DSN resolution (what the script actually parses):** the script resolves `LOOPBACK_DSN = TEST_DATABASE_URL ?? DATABASE_URL` and parses role/password/db out of **that** — never blindly out of `DATABASE_URL` — so it creates + migrates the loopback DB correctly for a worker (`DATABASE_URL` is loopback) *and* an orchestrator (`TEST_DATABASE_URL` is loopback, `DATABASE_URL` is the dev branch). Keep the app/test DSN and the memory DSN on separate env vars.

**Test-env block — who writes what:** the **script** writes only the `TEST_DATABASE_URL` fragment to `${DB_BOOTSTRAP_ENV_FILE:-/var/tmp/aim-db-bootstrap.env}` (sourced before the suite). The **team** wires the rest of the suite's env block (for N4: the `test.yml:96-100` set — `ENCRYPTION_MASTER_KEY` **quoted**, `NEXTAUTH_*`, etc.). Where that block lands is seat-dependent: a **worker** (ephemeral clone, gitignored `.env`) may write `<workdir>/.env`; a **Model-A orchestrator must NOT** — its `.env` is the human's bind-mounted file, so set `DB_BOOTSTRAP_BIND_WORKSPACE=1` and env-inject instead (§3.5).

So **a worker reuses this with 4 env values, an orchestrator with 7** — same image, same script, zero rebuild. That is the property that makes this doc liftable rather than N4-specific.

> **Node caveat (a real image constraint, not an env one):** the migrate + test toolchain runs under the image's Node, and Node is baked into the shared image — it is the one axis the env-contract can't parameterize. Check the project's `engines` floor against the image's Node major (§6). If the floor *exceeds* it, that's a separate **fleet-wide node bump** with its own canary, not a ride-along on the DB build. If the project merely runs a higher Node in CI without *requiring* it (no `engines` floor above the image), ship on the image's Node and log the residual CI-vs-container Node delta as a **minor parity gap — same class as the PG-version pin** — benign until the fleet moves up. (N4: root `engines` is `>=18`, `apps/web` has none, so Node 22 satisfies it; CI runs Node 24 → ship on 22 now, treat 22→24 as a separately-tracked fleet item.) A team that needs a specific Node pins it via the image; the default is whatever the fleet ships.

### 3.5 Orchestrator profile: persistent bind-mounted workspace

The **orchestrator** seat may get a *persistent bind-mount of an on-disk repo* (vs the workers' ephemeral + loopback). The right contract depends entirely on **who owns that tree**. Two models — **prefer Model A; Model B is the riskier fallback.**

**Model A — dedicated agent-exclusive checkout (RECOMMENDED; N4's shape).**
The bind-mounted repo is the *agent's own* checkout on the agent's host, and the human develops **elsewhere** (a different machine / repo / branch) and does not touch this tree. Then the bind-mount is a clean win:
- The agent **writes freely** into the workspace — `node_modules`, generated client, `.env.test`, build artifacts all **persist**, and persistence is a *benefit* (faster wakes, no re-install per cycle). No cross-arch hazard: only the agent, on the container's `linux/amd64`, ever installs here.
- **One constraint:** the bootstrap must not *overwrite* a file the human still maintains in-place. If the human occasionally edits one file (e.g. updates the `.env` DB URL so the mount reflects it live), feed the loopback DSN to the **suite via env-injection** (`DATABASE_URL=<loopback> npm run test:integration`) and never rewrite `.env`. `DB_BOOTSTRAP_BIND_WORKSPACE=1` suppresses the `.env` write while still giving the suite the loopback DSN by env.
- **Git:** adding a `transport` remote to the agent's *own* repo `.git/config` is fine (it's the agent's, not the human's); auth GitHub via a `GH_TOKEN` env (good hygiene regardless).
- **No concurrency contract needed** — single actor on this tree.

**Model B — shared LIVE working tree (AVOID if possible).**
A developer bind-mounts their *own live* working tree and keeps doing hands-on dev in it concurrently. This reintroduces, for the orchestrator seat, the collision classes the ephemeral worker model exists to kill. If unavoidable:
- **Write nothing transient into the mount** — `node_modules`, generated client, `PGDATA`, `.env`/`.env.test`, build artifacts all go **container-local** (especially if the human is macOS arm64 vs the `linux/amd64` container — native modules corrupt for one of them every wake).
- **Don't mutate the human's `.git/config`** — container-scoped git config (`GIT_CONFIG_GLOBAL` / a push-time explicit URL like `git push /transport.git HEAD`) + `GH_TOKEN` env (hard-rail #5).
- **Pin an explicit concurrency contract:** dedicated agent branch, who owns `HEAD`, and what happens if the human `git checkout`s under the agent mid-task.
- **Prefer Model A** — give the agent its own checkout instead.

**Lifecycle (both models).** A host-dir bind-mount survives hibernate (`docker stop`) → wake (`docker start`) on the same container, and re-attaches on `update-runtime` and `/recreate` (operator mounts are persisted in the agent record and re-synthesized, independent of the rotating per-UUID `$HOME`). **Roll the orchestrator via `update-runtime` (UUID/identity-preserving), never `/recreate`** — `/recreate` rotates the seat's AMP identity + keypair, fine for disposable workers but disruptive for a named orchestrator.

---

## 4. Investigation against real data: a standing, human-reset branch (Need B)

Distinct from §3's test/migration isolation: for "debug a feature against **real data**," the orchestrator works against a **standing** branch — not an empty sidecar, and not a spin-and-tear. The final shape (Shane's calls):

1. **A developer's standing dev branch** (e.g. a Neon branch off the dev parent), reached via the DSN in the orchestrator's bind-mounted `.env` (Model A, §3.5) or an `extraEnv` injection. Workers never use it — they stay on the loopback sidecar.
2. **Dev data, dev secrets.** The branch carries dev keys; prod secrets live in the deploy platform (e.g. Vercel). So the branch `.env` is safe to hand to a worker for a one-off investigation — no prod-PII exposure. (The original PII-minimization framing is **retired**.)
3. **Single read-write DSN.** No read-only / read-write split — read-only would block write-path reproduction, and it's unnecessary because the branch is disposable.
4. **Cruft control = human reset, not teardown.** The human periodically **resets the branch from its parent**, which wipes accumulated cruft (including the immutable-`AuditLog` rows that can't be `DELETE`d). The agent never reaps or tears anything down.
5. **The reset is a human SPOF — accepted, with an escalation channel.** The agent can't self-serve a reset, so when it needs one it **escalates to the human** on-demand via that team's channel (for N4: a Teams-bot gateway the orchestrator pings). Generalize: **fail-closed → escalate to the human via `<their escalation channel>`**.

**Per-developer generalization.** Each developer owns their own dev branch + creds; their orchestrator uses that developer's branch DSN. Identical mechanism per developer.

---

## 5. Lifecycle interaction (hibernate / wake / recreate)

The default sidecar (§3) is clean on every transition because it owns **no external named resource**:

| Transition | What happens to the container | What happens to the ephemeral DB |
|-----------|-------------------------------|----------------------------------|
| **hibernate** | `docker stop` (same container, writable layer preserved) | PG process dies with the container; nothing left behind |
| **wake** | `docker start` (same container) | start-path bootstrap re-runs → **fresh** DB (deterministic, since bootstrap `rm -rf $PGDATA && initdb`) |
| **`/recreate`** | `stop` + `rm` + fresh `docker run` + **NEW UUID** | datadir gone with the writable layer → rebuilt from empty; **no orphan** |

Contrast the **standing dev branch** (§4): it's an external named resource, but it's the *human's* — they provision and reset it, the agent only ever holds a DSN — so it's not keyed on the agent's rotating UUID, `/recreate` doesn't orphan it, and no agent-side reaper or quota management is needed.

> **Roll with `update-runtime`, not `/recreate`,** for the image swap that adds Postgres: `/recreate` rotates the UUID (and AMP keypair) and is the wrong tool for a fleet image bump. See `CLOUD-CODING-AGENT-RUNBOOK.md` §11 for the recreate-vs-update-runtime doctrine.

---

## 6. Checklist (per project adopting this pattern)

- [ ] Confirm the CI **merge gate's** Postgres major; pin the sidecar to it.
- [ ] Identify the **migrate-deploy entrypoint** + the **loopback test DSN** the suite must hit; have the suite resolve it from **`TEST_DATABASE_URL`** (never the ambient `DATABASE_URL`, which on an orchestrator is a dev branch), have the bootstrap export it, and inject at the vitest **config-env** — never a `setupFile` (an eager top-level prisma-bind reads `process.env` before a setupFile runs).
- [ ] Add the `postgresql-<major>` server pkg to the agent image; (optional) bake a template datadir for wake-latency.
- [ ] Put the bootstrap in the **start path** (fires on create + every wake), not the on-wake hook alone.
- [ ] Verify PG is up **before** the DB-backed completion gates.
- [ ] **Cross-review:** a different agent runs the suite against the canary before the fleet roll.
- [ ] **Permanent tripwire regression test** (not a one-time cutover check): run the suite with ambient `DATABASE_URL` set to a *bogus non-loopback* value and assert the suite connects to **loopback** (or throws) — **never** the bogus DSN. Because the eager top-level prisma-bind pattern stays live, a future refactor can silently re-introduce the ambient-DSN bypass; a one-time check won't catch the regression, a permanent test will. Bake it in from day one.
- [ ] Define the **Need-B investigation path** (§4): whose standing dev branch, who holds creds + resets it, how the DSN reaches the orchestrator, and the **fail-closed → human-escalation channel** for resets — even if you don't build it day one.
- [ ] Roll via **`update-runtime`** (UUID-preserving), not `/recreate`.

---

## 7. Status (N4)

- **Decision:** greenlit by Shane (Hyper Syndicate, 2026-06-20). **Spec:** ground-truthed from the N4 repo by Zach — PG16 (`test.yml:82`), DSN + env block (`test.yml:96-100`), entrypoint `prisma generate → migrate deploy → gate` in `apps/web`. All folded into §3 above.
- **Bootstrap detail:** write the env block to `apps/web/.env` on wake; the worker's `npm ci` (in the repo, ephemeral per rebuild) must precede `prisma generate` (it provides the prisma CLI). PGDATA stays in the ephemeral writable layer / tmpfs — **no persistent `-v` mount** — so teardown drops the datadir.
- **OPEN — Node version (a fleet-image constraint):** N4 CI pins **Node 24** (`actions/setup-node`), but the shared `ai-maestro-agent` image ships **Node 22** (`agent-container/Dockerfile:40`, `nodesource setup_22.x`). If `apps/web` `package.json` `engines` *hard-requires* ≥24, that's a **separate fleet-wide node22→node24 bump** (touches every agent + baked CLIs + the npm-prefix self-update fix) needing its own canary + sign-off — **not** folded into this DB build. If Node 22 satisfies the toolchain (Prisma + vitest typically do), no node change. Awaiting Zach's read of the `engines` field. **General lesson for adopters:** check the project's Node floor against the shared image's Node *before* assuming the DB add is the only image change.
- **OPEN — activation flag name** for the env-gated bootstrap. Must be **team-agnostic** (CelestIA's call, for AllianceOS reuse) — e.g. `INCONTAINER_PG_BOOTSTRAP=1`, not a team-specific `N4_*`. Zach + KAI ratify the final string in the canonical record; Hutch builds against it (and the parameterized contract in §3.4).
- **Build sequence (Hutch):** package add → env-gated bootstrap script → image rebuild → COPY-parity gate → Holmes canary → (a *different* agent verifies the N4 suite against the canary) → UUID-preserving fleet roll. Never `/recreate` for the roll (§5).
- **Doc map:** this is the canonical committable how-to (ops/runbook layer). The decision-rationale/lessons layer lives in the N4 migration plan §3A + the mesh-recall lessons-memory (CelestIA) and links here. Zach's `Engineer_INSTRUCTIONS` carries the on-wake DB-bootstrap clause + the KAI DSN-separation guard; this doc is the mechanism those reference.
