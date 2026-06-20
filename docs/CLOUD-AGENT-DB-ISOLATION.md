# Runbook: Per-Agent Database Isolation for Cloud-Agent Migration

> **Status:** DRAFT — companion to [`CLOUD-CODING-AGENT-RUNBOOK.md`](./CLOUD-CODING-AGENT-RUNBOOK.md) §11 (wave-based dev-team architecture). §11 isolates each agent's **git tree**; this doc isolates the **database** the agent's tests + migrations run against.
>
> **Reusable, not project-specific.** Any cloud-agent dev team on this container model whose tests run against a real database hits the same issue. Written generically — substitute your project's migrate command, DSN, and Postgres major.
>
> **Conventions:** `<project>` = the app being developed, `<agent-id>` = a UUID, `<operator>` = the host user.

---

## 1. The problem this solves

Containerizing a multi-agent team gives each agent its own **git tree** (per §11: `/workspace` per agent, push via `/transport.git`). That dissolves git-HEAD/branch/chat-state collisions. It does **not** touch a **shared database**.

If the team's tests and migrations run against a **real Postgres** (not mocks) and every agent points at **one shared dev DB**, git isolation just relocates the collision one layer down. Three failure modes follow, and they are not hypothetical:

1. **Migration drift / P3009.** Two agents mutating schema against one DB drift it. Raw-SQL constructs an ORM can't express (e.g. partial unique indexes) get re-`DROP`ped on every `migrate dev`, contaminating whatever migration is being authored — multiplied across agents.
2. **Fixture cross-contamination.** A real-`pg` integration suite run by two agents at once reads/writes the same tables simultaneously → non-deterministic failures neither agent caused nor can reproduce alone. Flaky by construction.
3. **Un-teardownable cruft (the worst).** If any table is **append-only/immutable at the DB layer** (e.g. an audit log whose `DELETE` is rejected by a trigger), an integration test that exercises an audited write **cannot tear down** the rows it created — nor the FK-anchored records behind them. A shared DB then **monotonically accumulates** cruft across every agent's every run, reclaimable only by a full reset. Unlike the git tree, which resets clean, the shared DB gets strictly **worse** over time.

**Net:** isolating git without isolating the DB re-creates forced-serial builds — the exact pain the migration exists to remove. Treat DB isolation as a **hard gate on cutover**, not a nice-to-have.

---

## 2. The decision rule (default vs. on-demand)

Separate two genuinely different needs; serving both beats picking one.

| Need | Frequency | Right tool |
|------|-----------|-----------|
| **A — build+test isolation** (every wake, every agent) | constant / hot path | **In-container ephemeral Postgres** (§3) |
| **B — data-driven investigation** ("why does this feature fail on *real data*") | occasional / targeted | **Standing, human-reset dev branch** the orchestrator works against (§4) |

> **A and B are not "workers vs orchestrator."** **A** (the loopback sidecar) is for *every* agent **including the orchestrator** — the orchestrator re-runs the merge-gate suite against loopback exactly like a worker. **B** (the branch) is **orchestrator-exclusive**, for investigation only. So the orchestrator uses **both**; only B is orchestrator-only.

**Default = A.** The integration suite seeds its **own** fixtures against an empty→migrated DB; it does **not want** real data (real data in that loop re-introduces exactly the fixture collisions + immutable-cruft + non-determinism you're solving). A version-pinned empty sidecar **is** the parity that gates merge, because the CI merge gate runs a pinned `postgres:<major>` service, not the prod engine.

**Do NOT put the data DB in the worker hot path.** Workers run the suite against the empty loopback sidecar (§3); the real-data branch (§4) is the orchestrator's alone. Keeping them split is an **isolation + correctness** call:

- **Isolation / correctness.** A shared real-data DB across parallel workers reintroduces exactly what §3 kills — migrate-drift, fixture cross-contamination, un-teardownable immutable cruft. The from-empty sidecar is the merge-gate parity *and* the correctness proof; the data branch is for write-path *repro*, a different job.
- **Credential surface.** Workers stay credential-less w.r.t. the data branch — they never hold its DSN; only the orchestrator does. (Where the branch carries only **dev** secrets — prod secrets living in the deploy platform — handing its `.env` to a worker for a one-off investigation is safe. Tighten this if the branch could expose production data your threat model won't allow in an agent container.)
- **Cost.** One standing dev branch (not branch-per-agent) is bounded managed-DB spend; the routine hot path never touches the managed DB.

---

## 3. Default: in-container ephemeral Postgres

### 3.1 Why in-container, not a sidecar container

The honest shape on this container model is a Postgres **process inside the agent's own container on loopback** — **not** a second/sibling container:

- Each agent is a **single `docker run`** — no compose project, no per-agent docker network.
- There is **no `/var/run/docker.sock`** inside the container — so an agent **cannot** orchestrate a sibling container, and the only lifecycle hook that runs in-container is **on-wake**.
- A true sibling sidecar would require **new host-side code** in the `wake`/`hibernate`/`recreate` paths (per-agent network + second `docker run` + teardown wiring) — the fragile paths. In-container avoids all of it: no compose, no network, no creds, no host-orchestration code.

### 3.2 Build shape (image + bootstrap)

1. **Image:** add the `postgresql-<major>` **server** package (the image typically ships only the client). Major-pin to match the CI merge gate's floating `postgres:<major>` tag — **major-pin only, not exact-patch** (CI's floating tag tracks minors; exact-pinning makes the sidecar tighter than the gate it mirrors). Suppress the distro's auto-created default cluster — the bootstrap inits its own throwaway datadir.

2. **Bootstrap on the container start path** (entrypoint / start gate — **not** the operator-editable on-wake hook alone, so it fires deterministically on initial create **and** every wake/restart, and a worker can't skip it). **Env-gate it with a TEAM-AGNOSTIC flag:** the agent image is shared across the whole fleet, so an unconditional `initdb`+migrate would fire in every non-DB container and break them. Activate via a generic per-agent flag in `extraEnv` (e.g. `INCONTAINER_PG_BOOTSTRAP=1`); the script no-ops everywhere else. Keep the flag generic (not project-specific) so the next adopting team opts in with **zero image change**. The script reads all project specifics from env (§3.4).

   The bootstrap, in order: resolve the loopback DSN (§3.4) → `initdb` a throwaway datadir → `pg_ctl` start on a loopback socket + `listen_addresses=localhost` (TCP loopback, to match a `localhost:<port>` DSN) → create role+db parsed from the DSN → run the project's **from-empty migrate** (the authoritative correctness proof; it also recreates any immutable-audit-log trigger the integration suite depends on, so it MUST complete before the gate) → export the loopback DSN + write a sourceable env fragment for the on-wake clause.

3. **PGDATA location.** Do **not** default `PGDATA` into `/tmp`: the container `/tmp` is commonly a small (~100MB) `tmpfs`, and a real from-empty schema + integration fixtures overflows it (`ENOSPC` mid-migrate). Use the container **writable layer** (e.g. `/var/tmp`) — ephemeral (gone on `recreate`), reinitialized every wake, not size-capped. The unix socket can stay in `/tmp` (a socket file is tiny).

4. **Ship** on the standard image path: build → COPY-parity gate → canary on one host → **a different agent verifies the integration suite against the canary** (the builder does not self-verify) → fleet roll. Roll via identity-preserving `update-runtime`, **not** `recreate` (which rotates the agent's identity/keypair — fine for disposable workers, disruptive for a named orchestrator).

### 3.3 Why it clears every bar

- **Isolation:** each agent's DB is its own loopback instance, rebuilt **from empty every cycle** — the clean-DB baseline, for free. Partial-index `DROP`s and fixtures contaminate **nobody else**.
- **Immutability survives:** an append-only audit-log trigger is part of the schema, so `migrate` **recreates it intact** on every cycle.
- **Cruft gone by construction:** teardown **drops the datadir** — it **never issues a `DELETE`** — so the immutable-cruft failure mode (§1.3) **cannot occur**. You don't clean the DB, you replace it.
- **Bootstrap ordering:** PG is up **before** the AI tool, so the DB-backed gate has a live DB when it runs.

### 3.4 Making it team-agnostic (the reuse contract)

The image ships **one** mechanism; each team opts in purely through `extraEnv`, no image change.

**Worker-minimal (4 values)** — any agent that just runs the suite against its own loopback DB:
- `INCONTAINER_PG_BOOTSTRAP=1` — the generic opt-in (absent ⇒ the script `exit 0`s).
- `DATABASE_URL` — the app/test DSN (for a worker, this is loopback).
- `DB_BOOTSTRAP_WORKDIR` (default `apps/web`) — the app subdir migrations run from.
- `DB_BOOTSTRAP_MIGRATE_CMD` (default the ORM's `generate && migrate deploy`) — override for other stacks.

**Orchestrator (+3 values)** — the recall-running seat, whose ambient `DATABASE_URL` is a *dev branch*, not loopback:
- `TEST_DATABASE_URL` — the loopback DSN (so the suite/migrate hit loopback even though `DATABASE_URL` is the branch).
- `REQUIRE_MEMORY_DATABASE_URL=1` + `MEMORY_DATABASE_URL` — see the memory-DSN guard below.

So **a worker reuses this with 4 env values, an orchestrator with 7** — same image, same script, zero rebuild. That is what makes this doc liftable.

**DSN resolution (what the script actually parses):** the script resolves `LOOPBACK_DSN = TEST_DATABASE_URL ?? DATABASE_URL` and parses role/password/db out of **that** — never blindly out of `DATABASE_URL` — so it creates + migrates the loopback DB correctly for a worker (`DATABASE_URL` is loopback) *and* an orchestrator (`TEST_DATABASE_URL` is loopback, `DATABASE_URL` is the branch). Keep the app/test DSN and any memory-backend DSN on **separate env vars**.

**Test-env block — who writes what:** the **script** writes only the `TEST_DATABASE_URL` fragment to a sourceable env file (sourced before the suite). The **team** wires the rest of the suite's env block (secrets, app URLs — quote any digit-only value to avoid YAML int-coercion). Where that block lands is seat-dependent: a **worker** (ephemeral clone, gitignored `.env`) may write `<workdir>/.env`; a **Model-A orchestrator must NOT** — its `.env` is the human's bind-mounted file, so set `DB_BOOTSTRAP_BIND_WORKSPACE=1` and env-inject instead (§3.5).

**Memory-DSN guard (if the agent also runs a shared memory backend).** A memory-backend pool that falls back to `DATABASE_URL` when its own DSN is unset will, on a recall-running orchestrator, silently route memory writes into the **app** DB. Guard it: set the memory DSN on its **own** var (`MEMORY_DATABASE_URL`) and make its absence **fatal**, scoped via `REQUIRE_MEMORY_DATABASE_URL=1` to the orchestrator only (so other agents that legitimately rely on the fallback are untouched). Enforce the fatal-if-unset in the **deterministic bootstrap**, not an instruction file (instruction-file rules are advisory; the container gate is not).

**Suite-DSN injection — a hard timing constraint.** If the app's DB client binds at **import time** (a top-level `process.env.DATABASE_URL` read / eager client instantiation), the loopback DSN must be set at the test runner's **config-env level** (before any test module imports the client) — **never in a setup file** (which runs after imports; the eager bind already grabbed the ambient DSN). Pair it with a **permanent tripwire regression test**: run the suite with ambient `DATABASE_URL` set to a bogus non-loopback value and assert the suite connects to loopback **or throws** — never the bogus DSN. A one-time check won't catch a future refactor re-introducing the bypass; a permanent test will.

> **Node caveat (an image constraint, not an env one):** the migrate + test toolchain runs under the image's Node, which the env-contract can't parameterize. Check the project's `engines` floor against the image's Node major. If the floor *exceeds* it, that's a separate **fleet-wide Node bump** with its own canary, not a ride-along on the DB build. If the project merely runs a higher Node in CI without *requiring* it, ship on the image's Node and log the residual CI-vs-container Node delta as a **minor parity gap** (same class as the PG-version pin), benign until the fleet moves up.

### 3.5 Orchestrator profile: persistent bind-mounted workspace

The **orchestrator** seat may get a *persistent bind-mount of an on-disk repo* (vs the workers' ephemeral + loopback). The right contract depends on **who owns that tree** — **prefer Model A; Model B is the riskier fallback.**

**Model A — dedicated agent-exclusive checkout (RECOMMENDED).** The bind-mounted repo is the *agent's own* checkout, and the human develops **elsewhere** (a different machine / repo / branch) and does not touch this tree:
- The agent **writes freely** — `node_modules`, generated client, `.env.test`, build artifacts **persist** (a benefit: faster wakes, no re-install). No cross-arch hazard: only the agent, on the container's arch, installs here.
- **One constraint:** the bootstrap must not *overwrite* a file the human still maintains in-place (e.g. an `.env` whose DB URL the human edits). Feed the loopback DSN to the **suite via env-injection** and never rewrite `.env` (`DB_BOOTSTRAP_BIND_WORKSPACE=1`).
- **Git:** a `transport` remote in the agent's *own* repo `.git/config` is fine; auth via a token env.
- **No concurrency contract needed** — single actor on the tree.

**Model B — shared LIVE working tree (AVOID if possible).** A developer bind-mounts their *own live* working tree and keeps doing hands-on dev in it concurrently — reintroducing, for the orchestrator seat, the collision classes the worker model exists to kill. If unavoidable:
- **Write nothing transient into the mount** — `node_modules`, generated client, `PGDATA`, `.env*`, build artifacts go **container-local** (especially if the human's arch differs from the container — native modules corrupt for one of them every wake).
- **Don't mutate the human's `.git/config`** — container-scoped git config + a token env.
- **Pin an explicit concurrency contract:** dedicated agent branch, who owns `HEAD`, what happens if the human checks out under the agent mid-task.
- **Prefer Model A** — give the agent its own checkout instead.

**Lifecycle (both models).** A host-dir bind-mount survives hibernate (`docker stop`) → wake (`docker start`), and re-attaches on `update-runtime` and `recreate` (operator mounts are persisted in the agent record and re-synthesized, independent of the rotating per-UUID `$HOME`). Roll the orchestrator via `update-runtime`, never `recreate`.

---

## 4. Investigation against real data: a standing, human-reset branch

For "debug a feature against **real data**," the orchestrator works against a **standing** branch — not an empty sidecar, and not a spin-and-tear:

1. **A developer's standing dev branch** (e.g. a managed-DB branch off the dev parent), reached via the DSN in the orchestrator's bind-mounted `.env` (Model A, §3.5) or an `extraEnv` injection. Workers never use it.
2. **Dev data, dev secrets** (prod secrets live in the deploy platform). Tighten if your threat model won't allow the branch's data in an agent container.
3. **Single read-write DSN.** No read-only/read-write split — read-only would block write-path reproduction, and it's unnecessary because the branch is disposable.
4. **Cruft control = human reset, not teardown.** The human periodically **resets the branch from its parent**, which wipes accumulated cruft (including immutable-audit-log rows that can't be `DELETE`d). The agent never reaps anything.
5. **The reset is a human SPOF — accept it with an escalation channel.** The agent can't self-serve a reset; when it needs one it **fails closed and escalates to the human** on-demand via the team's channel. A `migrate status` check after pulling new code surfaces drift; if the branch is *behind* the code (undeployed migrations) the fix is to migrate the delta or investigate the deployed ref, not reset.

**Per-developer generalization.** Each developer owns their own dev branch + creds; their orchestrator uses that developer's branch DSN. Identical mechanism per developer.

---

## 5. Lifecycle interaction (hibernate / wake / recreate)

- **hibernate** (`docker stop`) → the in-container PG dies with the container; nothing left behind.
- **wake** (`docker start`) → the start-path bootstrap re-runs, fresh DB from empty.
- **`recreate`** → datadir gone with the writable layer, rebuilt from empty; the standing data branch (§4) is human-owned, so it is **not** orphaned and needs **no agent-side reaper**. Prefer `update-runtime` over `recreate` for the orchestrator (identity preservation).

---

## 6. Adoption checklist (per project)

- [ ] Add the `postgresql-<major>` server to the shared image, major-pinned to the project's CI gate; suppress the auto-created default cluster.
- [ ] Confirm the bootstrap is **opt-in** (`INCONTAINER_PG_BOOTSTRAP=1`) and no-ops without it (shared-fleet-image safe).
- [ ] Set `PGDATA` to the writable layer (e.g. `/var/tmp`), never the size-capped `/tmp` tmpfs.
- [ ] Identify the migrate entrypoint + the loopback test DSN the suite must hit; have the suite resolve it from **`TEST_DATABASE_URL`** (never the ambient `DATABASE_URL`, which on an orchestrator is a dev branch), have the bootstrap export it, and inject at the test-runner **config-env level — never a setup file** (an eager top-level client bind reads `process.env` before a setup file runs).
- [ ] If the agent runs a shared memory backend, set `MEMORY_DATABASE_URL` on its own var with a deterministic **fatal-if-unset** gate, scoped to the orchestrator (`REQUIRE_MEMORY_DATABASE_URL=1`).
- [ ] **Permanent tripwire regression test** (not a one-time check): run the suite with ambient `DATABASE_URL` set to a bogus non-loopback value and assert the suite connects to loopback (or throws) — never the bogus DSN. The eager-import bind pattern stays live, so a future refactor can silently re-introduce the bypass; a permanent test catches it.
- [ ] Validate on a canary with a **different agent** running the integration suite (no self-verify) before the fleet roll.
- [ ] For real-data investigation, stand up one human-reset dev branch (§4), orchestrator-only, with a documented escalation channel for resets.
- [ ] Check the project's Node `engines` floor against the image's Node major (§3.4 caveat).
