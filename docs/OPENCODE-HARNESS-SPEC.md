# OpenCode Containerized Harness — Design Spec

**Status:** Draft for review (KAI, 2026-06-18) · **Phase-1 Step-1 empirical correction applied (CelestIA, 2026-06-18)** — on-disk contract is **SQLite (`opencode.db`), not a `storage/*.json` fan-out**; §2/§4.3/§4.4/§4.5/§6.1/§6.2/§7 updated to match real v1.17.8. Decoder now modeled on `lib/antigravity-db-decoder.ts`. Shape/phasing/host-container framing unchanged.
**Spec author:** KAI (dev-aimaestro-admin); **empirical correction:** CelestIA.
**Build author:** CelestIA (`dev-aimaestro-bananajr`) — assigned by Shane 2026-06-18; dev agent landing on bananajr, her host.
**Requested by:** Shane, via Vance research brief (`north-mini-code-evaluation-2026-06-18.md`)
**Reviewer:** KAI by default; **Watson** (`dev-aimaestro-holmes`) for any phase that runs **overnight** (Milo sleeps — keep the reviewer on an always-on host). Shane: sign-off.

---

## 1. Goal & non-goals

### Goal
Add **OpenCode** (`opencode-ai`, binary `opencode`) as a **first-class containerized (cloud/docker) agent harness** in AI Maestro, end-to-end:
- Launches in a container pointed at **OpenRouter** running `cohere/north-mini-code:free`.
- Auth + config + conversation history **persist** across `/update-runtime` and `/recreate` (UUID/AMP stable).
- Conversations **show up in chat** (WS + REST paths) like any other harness.
- Token/usage spend is **attributable** (via the Ziggy collector track — see §6.2, separate from this build).

### Shape: shared host-agnostic core + container product layer
The build is **not** "host vs container." The expensive/risky work — classification (`kind: 'opencode'`, `cloudProgram()`) and the chat decoder/normalizer (§6.1) — is **harness-format work, identical for host and container** (OpenCode's `opencode.db` SQLite layout is the same everywhere). That core is built **once, host-agnostic**, and host lights up as a near-free byproduct (one extra `case` in the *host* branch of `resolveConversationDir()`).

The **only genuinely additional** work is the container product layer: Dockerfile bake, provisioning, mount builders, `migrateAgentPersistence`, reserved paths. That is what we ship.

**Host is incidental — used as the decoder test rig, not a supported product path.** Running `opencode` locally to generate a real `opencode.db` and iterating the decoder against it (zero container-rebuild loop) is the fast dev path. But host is **not** first-class, for a concrete reason: all host agents share one `~/.local/share/opencode` (operator home), so multiple host OpenCode agents would **collide in the same session store** and chat couldn't tell them apart. Containers get per-UUID isolation via the mounted data dir; the host launch path can't inject a per-agent `OPENCODE_DATA_DIR` to fix it (the env-injection gap — §2). So host = fine for *one* test agent, not a fleet.

### Why OpenCode specifically
North-Mini-Code was tool-trained on the OpenCode / SWE-Agent / mini-SWE-Agent harnesses. OpenCode is the trained-for harness and the only faithful way to evaluate the model as an agentic coder. (Codex→OpenRouter is reachable today with zero new code but is *not* the trained harness — rejected as the eval path per Shane, 2026-06-18.)

### Non-goals (this spec)
- **Host OpenCode as a *supported product* path.** Container is the product. Host is incidental: the shared core (classification + chat decoder) is built host-agnostic, so a single host OpenCode agent works and serves as the decoder test rig — but we do **not** invest in host-specific persistence, provisioning, UI exposure, or multi-agent isolation (the shared-data-dir collision above). Host launch already works generically (`agents-core-service.ts:1849-1880`); we neither polish nor block it.
- **Token-spend collection itself.** That lives in the Ziggy collector, not ai-maestro. This spec only ensures OpenCode's on-disk usage data is *present and mountable* so Ziggy can decode it later (§6.2).
- **Local-model / self-host (Mac Studio).** Deferred until the free OpenRouter eval proves the model earns a place (per brief §Q1).
- **Production dependency on OpenRouter free tier.** Eval-only (rate limits, possible logging, withdrawable). Production would use the paid Cohere API or self-host.

---

## 2. Verified facts (load-bearing)

### OpenCode on-disk contract — ✅ CAPTURED EMPIRICALLY (CelestIA, 2026-06-18, bananajr v1.17.8)

> **CORRECTION (2026-06-18):** an earlier draft of this section (from OpenCode docs + ccusage + issue #5238) described a `storage/*.json` **fan-out**. That is an **older** OpenCode format. The real working install Shane stood up on bananajr runs **opencode v1.17.8**, which stores conversations in a **single SQLite database** — there is **no `storage/` directory at all**. The agy `.pb`→`.db` migration story repeating. Full capture: **`opencode-schema-findings.md`** (repo root, committed to this branch). This is strictly better for us (relational, usage in typed columns, and we already own the SQLite-decode pattern in `lib/antigravity-db-decoder.ts`).

Real `auth.json`, `opencode.jsonc`, and a populated `opencode.db` exist on bananajr now (curl install, OpenRouter key, `cohere/north-mini-code:free`, real Q&A + tool-using sessions). Open Qs 1/2/4 are **closed** (see §7).
- **Install method:** Shane used the **official curl install script**, which drops the binary at **`~/.opencode/bin/opencode`** (NOT `~/.local/bin`) with its own install root `~/.opencode/`. The npm package `opencode-ai` (binary `opencode`) is the container alternative — Container (§4.1) uses whichever installs cleanly for the non-root `claude` user in Debian; confirm in Phase 2. **Pin the version** (§7 Q7).
- **Auth:** `~/.local/share/opencode/auth.json`, perms 600 — `{ "<providerID>": { "type": "api", "key": "<key>" } }` (e.g. `{"openrouter":{"type":"api","key":"sk-or-…"}}`). Provider-key auth is written **directly** — no interactive `opencode auth login` — fits the existing `provisionCloud*` pattern (like `codex-auth.json`). **Q1 closed.**
- **Config:** `~/.config/opencode/opencode.jsonc` (note **`.jsonc`**) — in the captured install it is essentially **empty** (`{ "$schema": "https://opencode.ai/config.json" }`); the model is **not** stored here. The config dir also gets an auto-created `node_modules`/`package.json` for plugins. Model selection persists **per-session in the DB** (`session.model`), so a provisioned container must set the default model **declaratively** in `opencode.jsonc` (the config `model` field; slash-joined `openrouter/cohere/north-mini-code:free` form — Phase-2 confirm) since interactive TUI selection isn't available. **Q2 closed.**
- **Conversations:** `~/.local/share/opencode/opencode.db` (SQLite, + `-wal` + `-shm`) — relational tables, conversation = **`project → session → message → part`**:
  - `project` — `id` (40-char hash of the worktree path), `worktree`, `vcs`, `time_*`.
  - `session` — `id` (`ses_…`), `project_id` FK, `directory` (cwd), `title`, `version`, `agent`, **`model`** (JSON `{id,providerID,variant}`), `time_created`/`time_updated`, and **rolled-up usage columns** (`cost`, `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`).
  - `message` — `id` (`msg_…`), `session_id` FK, `time_*`, `data` (JSON: `{role, model, tokens, finish, path, …}`).
  - `part` — `id` (`prt_…`), `message_id` FK, `session_id` FK, `data` (JSON, **discriminated by `.type`**: `text` / `step-start` / `step-finish` / `tool`). **Q4 closed** (full shapes in §6.1).
- **Data-dir override:** `OPENCODE_DATA_DIR` (defaults to `~/.local/share/opencode`) — holds **auth.json AND opencode.db** (so one mount covers both — see D3/§4.4 WIN A). Config dir (`~/.config/opencode`) is separate and near-empty.

**Implication:** conversation history is **one SQLite DB (like antigravity), not single-JSONL (claude/codex/gemini) and not a JSON fan-out.** The decoder (§6.1) is a SQLite query modeled directly on `loadNewestAntigravityConversation` / `lib/antigravity-db-decoder.ts` — still the single biggest item in this spec, but a known pattern.

### ai-maestro container machinery (already exists — we extend it)
- **Image:** `agent-container/Dockerfile` — `debian:bookworm-slim`, Node 22, non-root `claude` user, user-owned npm prefix `/home/claude/.npm-global/bin`. CLIs baked at `Dockerfile:125-128` (`@anthropic-ai/claude-code`, `@google/gemini-cli`, `@openai/codex`). Per-program dirs pre-created `Dockerfile:159-173`.
- **Create/launch:** `services/agents-docker-service.ts` — `buildAiToolCommand()` (`:121-140`), AI_TOOL composed + `resolveStartCommand()` remap at `:2283-2304`, container launches `tmux send-keys "unset CI && ${AI_TOOL}"` (`agent-server.js:167`).
- **Env injection:** `extraEnv` exists and is **operator-injectable today** — `mergeEnv({...baseEnv, ...ampEnv}, body.extraEnv)` (`:2374`), validated by `validateExtraEnv()` (`:246-266`: safe key regex, no shell metachars, reserved keys `AGENT_ID`/`AI_TOOL`/`PATH` blocked). **`OPENROUTER_API_KEY` passes this validation.**
- **Persistence/mounts:** `buildCloudCommonMounts()` (`:1743`) assembles per-program mounts; `migrateAgentPersistence()` (`:1293-1392`) carries assets across `/recreate`. Per-program mount builders exist for claude/gemini/codex/antigravity. Single-dir "OPT-B" pattern (codex `:955-963`, antigravity `:1060-1068`) is the model to copy.
- **Classification:** `lib/program-resolver.ts` `PROGRAM_TABLE` (`:68-83`) — opencode row exists but **has `binary` and NO `kind`** (`:75`), so `cloudProgram()` (`agent-paths.ts:60-63`) falls back to `'claude'` → **wrong mounts + wrong chat dir today.**
- **Chat:** `resolveConversationDir()` (`agent-paths.ts:82-160`) switches on `cloudProgram()`; REST normalize in `agents-chat-service.ts:75-156`; WS path in `server.mjs:180-356` (`parseJsonlLines` + per-program normalizers + antigravity DB decode). **WS and REST paths historically drift — both must be updated.**

---

## 3. Architecture decisions

| # | Decision | Rationale |
|---|----------|-----------|
| D1 | **Shared host-agnostic core + container product layer.** Classification + chat decoder built once (host-agnostic); container adds the only extra work (Dockerfile/provision/mounts/migrate). Host falls out for free as a single-agent test rig, not a supported product path. | The expensive work is harness-format, identical host/container. Container is more capable (extraEnv, per-UUID mounts); host can't isolate multiple agents (shared `~/.local/share/opencode`). |
| D2 | **Add `kind: 'opencode'`** to `PROGRAM_TABLE` and widen the `AgentKind` union + `cloudProgram()` return type to include `'opencode'`. | Without a kind, opencode silently resolves to claude (wrong mounts/chat). This is the keystone change everything else hangs off. |
| D3 | **Single mounted data dir via `OPENCODE_DATA_DIR`** (WIN A). Mount one host dir → `~/.local/share/opencode` — it holds **both `auth.json` AND `opencode.db`** (+wal+shm), so one mount covers auth *and* conversations. Config dir (`~/.config/opencode`) is empty/optional — mount only if we later need a config override. | Mirrors codex/antigravity OPT-B single-dir pattern; auth+db colocation means **one** dir to mount and migrate on `/recreate`; minimal mount count. |
| D4 | **Provision auth.json directly** (write provider-key JSON on the host before docker materializes it), not interactive `opencode auth login`. | Matches `provisionCloudCodexAuth()`; no TTY interaction needed; key comes from create-request `extraEnv`/a dedicated field. |
| D5 | **Default model declaratively in `opencode.jsonc`** (the config `model` field, slash-joined `openrouter/cohere/north-mini-code:free`); launch `opencode` bare (no maestro `--model`). | Captured config is empty + model persists per-session in the DB, so a fresh container can't rely on interactive selection — it must be set declaratively. The `-m provider/model` run-flag works (verified: `openrouter/cohere/north-mini-code:free`) as a fallback if the config field proves finicky (Phase-2 confirm). |
| D6 | **New conversation decoder over the SQLite DB**, wired into **both** WS and REST paths from one shared function. | The two paths drift; a single shared `loadNewestOpencodeConversation()` modeled on `loadNewestAntigravityConversation()` (SQLite reader, not a JSONL normalizer) keeps them in sync. |
| D7 | **Token-spend is a Ziggy-collector track, not ai-maestro.** This spec only guarantees the DB is present + mounted. | Spend collection already lives in Ziggy (per the 2026-06-17 antigravity collector work). OpenCode's `session` usage columns + `session_usage` table make this **easier than antigravity** (usage in typed columns, no protobuf/JSON parse). Keeps scope clean. |

---

## 4. Touchpoint work breakdown

Keyed to the source. Items marked **[hard]** are the genuine design work; the rest are mechanical pattern-copies.

### 4.1 Image (`agent-container/Dockerfile`)
- Install OpenCode — either add `opencode-ai` to the npm block (`:125-128`) **or** run the official curl install script (the method Shane verified on host). Pick whichever lands a working `opencode` on PATH for the non-root `claude` user; prefer the npm path if it works (consistent with the other CLIs' user-owned npm prefix).
- Pre-create + chown `~/.config/opencode` and `~/.local/share/opencode` (`:159-173`) — the data dir holds `auth.json` + `opencode.db` (+wal+shm); there is **no `storage/` subdir** (corrected contract, §2).
- No base-image changes (locale/TERM/PATH/CI are harness-agnostic).
- **Verify + pin a version** (avoid the mid-session self-update-corruption class — see `reference_cloud_agent_self_update_break`); confirm OpenCode has no auto-updater needing a disable flag.

### 4.2 Classification (`lib/program-resolver.ts`)
- `PROGRAM_TABLE:75` → add `kind: 'opencode'` to the opencode row.
- `AgentKind` union (`:50`) → add `'opencode'`.
- Update `program-resolver` test (locks precedence + the binary/kind contract).

### 4.3 Path/classification plumbing (`lib/agent-paths.ts`)
- `cloudProgram()` (`:60-63`) → widen return type to include `'opencode'`; the `resolveKind` switch passes it through once D2 lands.
- `resolveConversationDir()` cloud branch (`:88-121`) → `case 'opencode': return path.join(agentDir, 'opencode-data')` — the **data dir** (the decoder opens `opencode.db` inside it), mirroring how the antigravity branch resolves the dir the DB lives in. NOT a `storage/` path (none exists).
- `resolveConversationDir()` **host** branch (`:129-160`) → `case 'opencode': return path.join(hostHome, '.local', 'share', 'opencode')`. Trivial, falls out of the shared work; lights up the single-agent host test rig (D1). Same decoder, different root.
- `cloudInstructionsContainerPath()` (`:1651-1662`) → map opencode → its instructions path (OpenCode reads `AGENTS.md`/instructions; confirm — §7).
- Reserved container paths `OPERATOR_RESERVED_CONTAINER_PATH_ROOTS` (`:154-167`) → add `~/.local/share/opencode` (and `~/.config/opencode` if a config mount is added) so operator mounts can't shadow them.

### 4.4 Container create + mounts + persistence (`services/agents-docker-service.ts`)
- `provisionCloudOpenCodeAuth()` — write `auth.json` (`{ "openrouter": { "type": "api", "key": "<OpenRouter key>" } }`, perms 600) into the data-dir on host pre-mount. (Copy `provisionCloudCodexAuth` shape exactly.) Optionally write a minimal `opencode.jsonc` with the declarative default model (D5) — either into the data dir's sibling config mount or skip if the `-m` run-flag path is chosen.
- `buildCloudOpenCodeDataMount()` — **single dir** `~/.aimaestro/agents/<UUID>/opencode-data` → `~/.local/share/opencode` (RW); set `OPENCODE_DATA_DIR` accordingly via base env. **This one mount carries auth.json + opencode.db** (WIN A) — no separate auth/conversation mounts.
- (Config mount optional) only if D5 lands the default model in `opencode.jsonc`: `~/.aimaestro/agents/<UUID>/opencode-config` → `~/.config/opencode` (RW). Skip if the model is set via the launch flag.
- Wire the data mount (and optional config mount) into `buildCloudCommonMounts()` (`:1743`) and the precreate-dirs helper.
- `migrateAgentPersistence()` (`:1304-1380`) → add `opencode-data` (+ `opencode-config` if used) to dirAssets so `/recreate` carries them — this preserves `opencode.db` (conversations) + auth across recreate.
- `buildAiToolCommand()` (`:121-140`) — opencode needs no `--permission-mode` (claude-only). Per D5, no `--model` appended (default set in config) — or append `-m openrouter/cohere/north-mini-code:free` if the flag path is chosen. Confirm yolo/`--dangerously-skip-permissions` has no opencode analog (OpenCode permission model differs — §7).

### 4.5 Chat — **[hard]** (`server.mjs` + `services/agents-chat-service.ts`)
- New `lib/opencode-db-decoder.ts` (modeled on `lib/antigravity-db-decoder.ts`): `loadNewestOpencodeConversation(dataDir)` opens `opencode.db` with **better-sqlite3 (readonly)**, picks the **newest `session` by `time_updated`** (optionally scoped to the agent's `project`/`directory`), joins its `message` rows (ordered by `time_created`/seq) and each message's `part` rows (ordered), and returns `{ dbPath, mtime, messages }`. Plus `normalizeOpencodeMessage()` → maestro's normalized chat shape, dispatching on `part.data.type` (`text` → content; `tool` → tool call from `{tool, callID, state:{status,input,output}}`; `step-start`/`step-finish` → step/usage boundaries). **Reuse antigravity's discipline:** instantiate `new Database()` to verify the native ABI (don't trust `require()` — lazy-binding false-green); pin `better-sqlite3` to the live pm2 node's ABI; **watch BOTH `opencode.db` AND `opencode.db-wal`** (live turns land in `-wal` before checkpoint — the #233 WAL lesson).
- REST: `agents-chat-service.ts:75-156` → add `program === 'opencode'` branch calling the shared loader (mirror the antigravity DB-decode branch).
- WS: `server.mjs:180-356` → add `cloudProgram(agent) === 'opencode'` branch calling the **same** shared loader (D6), alongside the existing antigravity DB-decode path.
- **Schema is captured** (§2 / §6.1 / `opencode-schema-findings.md`) — the `tool` part arm was locked from a real tool-using session (bash/read/edit). A WS↔REST parity test guards drift.

### 4.6 On-wake / instructions / AMP
- AMP bootstrap + inject-readiness are program-agnostic (`inject-readiness.ts:334-335` falls to capture-pane for non-claude). No change required for correctness; busy-detection is less authoritative than claude (acceptable for eval; Tier-2 if it graduates — characterize OpenCode's busy footer for `BUSY_FOOTER_PATTERNS`).
- Instructions file: confirm OpenCode reads an `AGENTS.md`/`opencode.jsonc` instructions field so the on-wake/mesh-primer text reaches the agent (§7).

---

## 5. Phasing

Sequencing front-loads the one **[hard]** item (the chat decoder) onto the **easy host test path**, then layers the mechanical container work on top once the decoder is proven.

- **Phase 0 — Spec sign-off (this doc).** ✅ Key in hand: `incoming/opencode_api_key` on Milo (gitignored, perms 600); bananajr + Holmes already have working installs with the key entered interactively. ✅ Author (CelestIA) + reviewer (KAI / Watson-overnight) assigned. Remaining: Shane sign-off on the spec.
- **Phase 1 — Shared core (host-agnostic) + chat decoder [hard], tested on host.** Classification (`kind: 'opencode'`, `cloudProgram()`), the shared `loadNewestOpencodeConversation` + normalizer (SQLite reader over `opencode.db`), both host & cloud `resolveConversationDir` branches, and both WS + REST wirings. **Step 1 (empirical) — ✅ DONE (CelestIA, 2026-06-18):** real schemas captured from bananajr's `opencode.db`; Qs 1/2/4 closed; the SQLite-not-fan-out correction folded into §2/§6.1; `tool`-part shape locked from a real tool-using session. See `opencode-schema-findings.md`. Then develop the decoder **against bananajr's already-populated `opencode.db`** (the "tech stack" Q&A + tool-using sessions are real test data), iterate with zero container rebuilds, verify WS/REST parity (`reference_chat_two_paths_and_resolver`). Exit: a host OpenCode conversation renders correctly in chat via both paths. The risky work is now de-risked on the easy path.
- **Phase 2 — Container launch.** Dockerfile bake (`opencode-ai`, pre-create dirs), create-with-`extraEnv` (`OPENROUTER_API_KEY`), `OPENCODE_DATA_DIR` wiring. Exit: a container agent launches `opencode` against OpenRouter and completes a coding turn (verified by attaching to the pane).
- **Phase 3 — Container persistence + chat.** Provision (`auth.json`/`opencode.jsonc`) + mount builders + `migrateAgentPersistence` + reserved paths. Exit: auth/config/sessions survive `/update-runtime` and `/recreate` (UUID/AMP stable; DiffIDs + real-history canary disciplines), **and** container conversations render in chat (decoder already proven in Phase 1, now just pointed at the mounted dir).
- **Phase 4 — Eval handoff.** Shane runs the graded backlog task set. Token-spend (Ziggy track) runs in parallel/after (§6.2).

Each phase is a separate PR with the mandatory version bump (§Pre-PR). Build happens **off-Milo** (this box hosts Iron Syndicate meetings; `.next/` is shared — `feedback_next_build_shares_dir`); Phase 1's host decoder testing can use a throwaway local `opencode` on any dev box. Author TBD per §7 assignment; KAI authors the spec + reviews.

---

## 6. The two hard problems (detail)

### 6.1 Chat decoder
OpenCode (v1.17.8) stores conversations in **one SQLite DB** — relational `project → session → message → part`, with JSON in `*.data` columns. The decoder must: find the agent's `project` (by worktree), select the **newest `session` by `time_updated`**, gather its `message` rows (ordered), pull each message's `part` rows (ordered), and normalize to the maestro chat shape — **dispatching on `part.data.type`** (the captured discriminated union):
- `text` → `{ type:"text", text }` — chat content (user prompt or assistant prose).
- `tool` → `{ type:"tool", tool:"<name>", callID, state:{ status:"completed"|…, input:{…tool-specific}, output, metadata, title?, time:{start,end} }, metadata }` — map to a maestro tool-call/result. **Locked from a real tool-using session** (bash: `input.command`; read: `input.filePath`; edit: `input.{filePath,oldString,newString}`).
- `step-start` → `{ type:"step-start" }` (optional `snapshot`) — agent-step boundary.
- `step-finish` → `{ type:"step-finish", reason, tokens:{…}, cost }` — step usage/finish.

`message.data` carries role + `model{providerID,modelID,variant}` + (assistant) `tokens` + `finish` + `path{cwd,root}`.

It must be a **single shared function** consumed by both WS (`server.mjs`) and REST (`agents-chat-service.ts`) — these have drifted before and an OpenCode-only divergence would be invisible until a user hits the wrong path. **Direct analog: `loadNewestAntigravityConversation` / `lib/antigravity-db-decoder.ts`** (SQLite reader, not a JSONL normalizer) — reuse its `new Database()`-ABI-verify, node-ABI pin, and **dual `.db`+`-wal` watch** disciplines. Host/container-agnostic (same DB shape everywhere), which is exactly why Phase 1 builds + tests it against the **already-populated** host `opencode.db` before any container exists. **Session multiplexing rule:** newest session by `time_updated`, matching the other resolvers.

### 6.2 Token-usage / spend — Ziggy track, not ai-maestro (WIN B)
ai-maestro does **not** collect token usage for any harness today; that is the **Ziggy collector's** job (reads transcripts/DBs off disk per surface — exactly the antigravity collector leg shipped 2026-06-17). OpenCode's DB makes this **easier than any prior harness**: usage is in **typed columns** on the `session` table (`cost`, `tokens_input/output/reasoning/cache_read/cache_write`) plus a dedicated **`session_usage`** projection, plus per-assistant-`message.data.tokens` — **no protobuf or JSON-fan-out parse needed** (`ccusage` already supports OpenCode, confirming extractability). So the spend-tracking work is a **Ziggy-collector decoder addition** (a SQLite read of the `session`/`session_usage` columns) owned by the Vance/Sam Ziggy lane — *separate from this ai-maestro build*. This spec's only obligation: ensure `opencode.db` is **persisted + mounted** (Phase 2/3, via the single data-dir mount) so the collector can reach it on the host. See `docs/TOOL-USAGE-TRACKING.md` / `METRICS-ARCHITECTURE-DESIGN.md` for the ai-maestro-side metrics surfaces if we later want in-app display.

---

## 7. Open questions (resolve during build / before Phase that needs them)
1. ✅ **RESOLVED — auth.json schema.** `{ "<providerID>": { "type": "api", "key": "<key>" } }`, perms 600 (e.g. `{"openrouter":{"type":"api","key":"sk-or-…"}}`). Write directly; no `opencode auth login`. Drives `provisionCloudOpenCodeAuth`.
2. ✅ **RESOLVED (mostly) — model config.** `opencode.jsonc` is empty in the captured install; model persists per-session in the DB as `{id:"cohere/north-mini-code:free", providerID:"openrouter", variant}` (provider + modelID are **separate** fields, NOT slash-joined). The `-m` run-flag form **is** slash-joined: `openrouter/cohere/north-mini-code:free` (verified). *Phase-2 confirm:* the exact `opencode.jsonc` `model`/`provider` block needed to set a declarative default for a fresh container (incl. whether the OpenRouter key is referenced from auth.json automatically).
3. **Launch form** — does bare `opencode` (TUI) honor the config default model, and run cleanly headless-in-tmux? `opencode run [message..]` (non-interactive) and `-m openrouter/cohere/north-mini-code:free` both work on host (verified Phase-1 capture); confirm the **TUI** launch-in-tmux path for the container (D5).
4. ✅ **RESOLVED — message/part schema.** Relational `message`/`part` with JSON `data`; `part.data` discriminated by `.type` (`text`/`step-start`/`step-finish`/`tool`); tool arm `{tool,callID,state:{status,input,output,…}}` locked from a real tool-using session. Drives the §6.1 normalizer; usage present for §6.2 (typed columns).
5. **Instructions ingestion** — how OpenCode picks up agent instructions / mesh-primer (`AGENTS.md`? config field?) so on-wake context reaches it.
6. **Permission model** — OpenCode's autonomy/permission flags (analog to claude `--permission-mode` / yolo `--dangerously-skip-permissions`), for the supervised-vs-autonomous create option.
7. **Version pinning** — pin OpenCode to **v1.17.8** (the captured/working version) to avoid mid-session self-update corruption (`reference_cloud_agent_self_update_break`); note `opencode upgrade` exists as a subcommand → confirm no background auto-updater needs disabling in-container.

---

## 8. Risks
- **Chat parity drift (WS vs REST)** — mitigated by the single shared loader (D6) + a WS-probe parity test.
- **Free-tier instability** — rate limits / withdrawal; eval-only, not a production dep (brief §Q2 caveat).
- **Busy-detection fidelity** — non-claude capture-pane fallback is less authoritative; acceptable for a solo eval agent, flagged Tier-2.
- **Tool-call fidelity of the model itself** — this is what the eval *measures*, not a build risk; mini-north is pass@1 67.6% (strong mid-tier, not Opus parity per brief §Hype-vs-substance).
- **Self-update corruption** — pin the version (Q7).

---

## 9. Sources
- Vance brief: `north-mini-code-evaluation-2026-06-18.md` (AMP attachment, msg_1781804930_fab4e4b8)
- OpenCode docs: https://opencode.ai/docs/providers/ · https://opencode.ai/docs/config/ · https://opencode.ai/docs/cli/
- OpenRouter × OpenCode: https://openrouter.ai/docs/cookbook/coding-agents/opencode-integration
- OpenCode storage/auth: ccusage https://ccusage.com/guide/opencode/ · issue #5238 (auth.json location)
- North-Mini-Code: https://cohere.com/blog/north-mini-code · https://openrouter.ai/cohere/north-mini-code:free
