# OpenCode Containerized Harness — Design Spec

**Status:** Draft for review (KAI, 2026-06-18)
**Spec author:** KAI (dev-aimaestro-admin)
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
The build is **not** "host vs container." The expensive/risky work — classification (`kind: 'opencode'`, `cloudProgram()`) and the chat decoder/normalizer (§6.1) — is **harness-format work, identical for host and container** (OpenCode's `storage/` layout is the same everywhere). That core is built **once, host-agnostic**, and host lights up as a near-free byproduct (one extra `case` in the *host* branch of `resolveConversationDir()`).

The **only genuinely additional** work is the container product layer: Dockerfile bake, provisioning, mount builders, `migrateAgentPersistence`, reserved paths. That is what we ship.

**Host is incidental — used as the decoder test rig, not a supported product path.** Running `opencode` locally to generate real `storage/` and iterating the decoder against it (zero container-rebuild loop) is the fast dev path. But host is **not** first-class, for a concrete reason: all host agents share one `~/.local/share/opencode` (operator home), so multiple host OpenCode agents would **collide in the same session store** and chat couldn't tell them apart. Containers get per-UUID isolation via the mounted data dir; the host launch path can't inject a per-agent `OPENCODE_DATA_DIR` to fix it (the env-injection gap — §2). So host = fine for *one* test agent, not a fleet.

### Why OpenCode specifically
North-Mini-Code was tool-trained on the OpenCode / SWE-Agent / mini-SWE-Agent harnesses. OpenCode is the trained-for harness and the only faithful way to evaluate the model as an agentic coder. (Codex→OpenRouter is reachable today with zero new code but is *not* the trained harness — rejected as the eval path per Shane, 2026-06-18.)

### Non-goals (this spec)
- **Host OpenCode as a *supported product* path.** Container is the product. Host is incidental: the shared core (classification + chat decoder) is built host-agnostic, so a single host OpenCode agent works and serves as the decoder test rig — but we do **not** invest in host-specific persistence, provisioning, UI exposure, or multi-agent isolation (the shared-data-dir collision above). Host launch already works generically (`agents-core-service.ts:1849-1880`); we neither polish nor block it.
- **Token-spend collection itself.** That lives in the Ziggy collector, not ai-maestro. This spec only ensures OpenCode's on-disk usage data is *present and mountable* so Ziggy can decode it later (§6.2).
- **Local-model / self-host (Mac Studio).** Deferred until the free OpenRouter eval proves the model earns a place (per brief §Q1).
- **Production dependency on OpenRouter free tier.** Eval-only (rate limits, possible logging, withdrawable). Production would use the paid Cohere API or self-host.

---

## 2. Verified facts (load-bearing)

### OpenCode on-disk contract
Confirmed against OpenCode docs + ccusage + issue #5238, **plus a real working install** Shane stood up on Holmes + bananajr (2026-06-18): official curl install script, OpenRouter key entered, `cohere/north-mini-code:free` selected, asked "what's the tech stack of this?" inside an ai-maestro checkout — it answered correctly. So real `auth.json`, `opencode.json`, and a populated `storage/` exist on bananajr **now** — Phase 1 captures the exact schemas from those (closes open Qs 1/2/4 empirically before any code).
- **Install method:** Shane used the **official curl install script** (`curl -fsSL https://opencode.ai/install | bash`-style), which drops a prebuilt binary (typically under `~/.local/bin`). The npm package `opencode-ai` (binary `opencode`) is the alternative. Container (§4.1) uses whichever installs cleanly for the non-root `claude` user in Debian — confirm in Phase 2.
- **Auth:** `~/.local/share/opencode/auth.json` — provider→key JSON, perms 600. Provider-key auth can be written directly (no interactive `opencode auth login` required — fits the existing `provisionCloud*` pattern, like `codex-auth.json`). *Exact schema to confirm during build (§7).*
- **Config:** `~/.config/opencode/opencode.json` — provider + default model + options.
- **Conversations:** `~/.local/share/opencode/storage/` as a **fan-out of per-message JSON files**:
  - `storage/message/{sessionID}/msg_{messageID}.json`
  - `storage/session/{projectHash}/{sessionID}.json`
- **Data-dir override:** `OPENCODE_DATA_DIR` (defaults to `~/.local/share/opencode`) — holds auth + storage. Config dir (`~/.config/opencode`) is separate.

**Implication:** conversation history is **neither single-JSONL (claude/codex/gemini) nor one SQLite DB (antigravity)** — it is a directory fan-out of per-message JSON. This is a *new* decoder shape (§6.1) and the single biggest item in this spec.

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
| D3 | **Single mounted data dir via `OPENCODE_DATA_DIR`.** Mount one host dir → `~/.local/share/opencode` (holds auth + storage), plus a small config mount → `~/.config/opencode`. | Mirrors codex/antigravity OPT-B single-dir pattern; minimizes mount count; one dir to migrate on `/recreate`. |
| D4 | **Provision auth.json directly** (write provider-key JSON on the host before docker materializes it), not interactive `opencode auth login`. | Matches `provisionCloudCodexAuth()`; no TTY interaction needed; key comes from create-request `extraEnv`/a dedicated field. |
| D5 | **Default model in `opencode.json`, launch `opencode` bare** (leave `agent.model` empty so maestro does not append `--model`). | Avoids depending on an unverified `--model` TUI flag; config-driven model is OpenCode's first-class path. (Confirm flag during build; if `--model provider/model` works cleanly we can switch.) |
| D6 | **New conversation decoder** for the storage fan-out, wired into **both** WS and REST paths from one shared function. | The two paths drift; a single shared `loadNewestOpencodeConversation()` (like `loadNewestAntigravityConversation()`) keeps them in sync. |
| D7 | **Token-spend is a Ziggy-collector track, not ai-maestro.** This spec only guarantees usage JSON is present + mounted. | Spend collection already lives in Ziggy (per the 2026-06-17 antigravity collector work); ccusage proves OpenCode usage is decodable. Keeps scope clean. |

---

## 4. Touchpoint work breakdown

Keyed to the source. Items marked **[hard]** are the genuine design work; the rest are mechanical pattern-copies.

### 4.1 Image (`agent-container/Dockerfile`)
- Install OpenCode — either add `opencode-ai` to the npm block (`:125-128`) **or** run the official curl install script (the method Shane verified on host). Pick whichever lands a working `opencode` on PATH for the non-root `claude` user; prefer the npm path if it works (consistent with the other CLIs' user-owned npm prefix).
- Pre-create + chown `~/.config/opencode` and `~/.local/share/opencode/storage` (`:159-173`).
- No base-image changes (locale/TERM/PATH/CI are harness-agnostic).
- **Verify + pin a version** (avoid the mid-session self-update-corruption class — see `reference_cloud_agent_self_update_break`); confirm OpenCode has no auto-updater needing a disable flag.

### 4.2 Classification (`lib/program-resolver.ts`)
- `PROGRAM_TABLE:75` → add `kind: 'opencode'` to the opencode row.
- `AgentKind` union (`:50`) → add `'opencode'`.
- Update `program-resolver` test (locks precedence + the binary/kind contract).

### 4.3 Path/classification plumbing (`lib/agent-paths.ts`)
- `cloudProgram()` (`:60-63`) → widen return type to include `'opencode'`; the `resolveKind` switch passes it through once D2 lands.
- `resolveConversationDir()` cloud branch (`:88-121`) → `case 'opencode': return path.join(agentDir, 'opencode-data', 'storage')` (or wherever D3 lands the mount).
- `resolveConversationDir()` **host** branch (`:129-160`) → `case 'opencode': return path.join(hostHome, '.local', 'share', 'opencode', 'storage')`. Trivial, falls out of the shared work; lights up the single-agent host test rig (D1). Same decoder, different root.
- `cloudInstructionsContainerPath()` (`:1651-1662`) → map opencode → its instructions path (OpenCode reads `AGENTS.md`/instructions; confirm — §7).
- Reserved container paths `OPERATOR_RESERVED_CONTAINER_PATH_ROOTS` (`:154-167`) → add `~/.config/opencode` and `~/.local/share/opencode` so operator mounts can't shadow them.

### 4.4 Container create + mounts + persistence (`services/agents-docker-service.ts`)
- `provisionCloudOpenCodeConfig()` — write `opencode.json` (provider=openrouter, default model=`cohere/north-mini-code:free`) + `auth.json` (OpenRouter key) on host pre-mount. (Copy `provisionCloudCodexAuth` shape.)
- `buildCloudOpenCodeDataMount()` — single dir `~/.aimaestro/agents/<UUID>/opencode-data` → `~/.local/share/opencode` (RW); set `OPENCODE_DATA_DIR` accordingly via base env.
- `buildCloudOpenCodeConfigMount()` — `~/.aimaestro/agents/<UUID>/opencode-config` → `~/.config/opencode` (RW).
- Wire both into `buildCloudCommonMounts()` (`:1743`) and the precreate-dirs helper.
- `migrateAgentPersistence()` (`:1304-1380`) → add `opencode-data` + `opencode-config` to dirAssets so `/recreate` carries them.
- `buildAiToolCommand()` (`:121-140`) — opencode needs no `--permission-mode` (claude-only). Per D5, no `--model` appended. Confirm yolo/`--dangerously-skip-permissions` has no opencode analog (OpenCode permission model differs — §7).

### 4.5 Chat — **[hard]** (`server.mjs` + `services/agents-chat-service.ts`)
- New `lib/opencode-conversation.ts`: `loadNewestOpencodeConversation(dataDir)` → glob `storage/message/{sessionID}/*.json`, pick newest session by mtime, sort messages, return `{path, mtime, messages}`. Plus `normalizeOpencodeMessage()` → maestro's normalized chat shape.
- REST: `agents-chat-service.ts:75-156` → add `program === 'opencode'` branch calling the shared loader.
- WS: `server.mjs:180-356` → add `cloudProgram(agent) === 'opencode'` branch calling the **same** shared loader (D6).
- **Verify the OpenCode message JSON schema** (role/content/parts/tool-calls/timestamps) during build — drives the normalizer.

### 4.6 On-wake / instructions / AMP
- AMP bootstrap + inject-readiness are program-agnostic (`inject-readiness.ts:334-335` falls to capture-pane for non-claude). No change required for correctness; busy-detection is less authoritative than claude (acceptable for eval; Tier-2 if it graduates — characterize OpenCode's busy footer for `BUSY_FOOTER_PATTERNS`).
- Instructions file: confirm OpenCode reads an `AGENTS.md`/`opencode.json` instructions field so the on-wake/mesh-primer text reaches the agent (§7).

---

## 5. Phasing

Sequencing front-loads the one **[hard]** item (the chat decoder) onto the **easy host test path**, then layers the mechanical container work on top once the decoder is proven.

- **Phase 0 — Spec sign-off (this doc).** ✅ Key in hand: `incoming/opencode_api_key` on Milo (gitignored, perms 600); bananajr + Holmes already have working installs with the key entered interactively. ✅ Author (CelestIA) + reviewer (KAI / Watson-overnight) assigned. Remaining: Shane sign-off on the spec.
- **Phase 1 — Shared core (host-agnostic) + chat decoder [hard], tested on host.** Classification (`kind: 'opencode'`, `cloudProgram()`), the shared `loadNewestOpencodeConversation` + normalizer, both host & cloud `resolveConversationDir` branches, and both WS + REST wirings. **Step 1 (empirical): capture the real on-disk schemas** from bananajr's existing install — `auth.json`, `opencode.json`, and a sample `storage/message/*/msg_*.json` + `storage/session/*/*.json` — to close open Qs 1/2/4 before coding. Then develop the decoder **against bananajr's already-populated `storage/`** (the "what's the tech stack" session is real test data), iterate with zero container rebuilds, verify WS/REST parity (`reference_chat_two_paths_and_resolver`). Exit: a host OpenCode conversation renders correctly in chat via both paths. The risky work is now de-risked on the easy path.
- **Phase 2 — Container launch.** Dockerfile bake (`opencode-ai`, pre-create dirs), create-with-`extraEnv` (`OPENROUTER_API_KEY`), `OPENCODE_DATA_DIR` wiring. Exit: a container agent launches `opencode` against OpenRouter and completes a coding turn (verified by attaching to the pane).
- **Phase 3 — Container persistence + chat.** Provision (`auth.json`/`opencode.json`) + mount builders + `migrateAgentPersistence` + reserved paths. Exit: auth/config/sessions survive `/update-runtime` and `/recreate` (UUID/AMP stable; DiffIDs + real-history canary disciplines), **and** container conversations render in chat (decoder already proven in Phase 1, now just pointed at the mounted dir).
- **Phase 4 — Eval handoff.** Shane runs the graded backlog task set. Token-spend (Ziggy track) runs in parallel/after (§6.2).

Each phase is a separate PR with the mandatory version bump (§Pre-PR). Build happens **off-Milo** (this box hosts Iron Syndicate meetings; `.next/` is shared — `feedback_next_build_shares_dir`); Phase 1's host decoder testing can use a throwaway local `opencode` on any dev box. Author TBD per §7 assignment; KAI authors the spec + reviews.

---

## 6. The two hard problems (detail)

### 6.1 Chat decoder
Every existing harness is single-JSONL or single-SQLite. OpenCode is a **directory fan-out**: one JSON file per message, grouped by session, with a separate session index. The decoder must: enumerate sessions for the agent's project, select the active/newest one, gather + order its message files, and normalize each to the maestro chat shape. It must be a **single shared function** consumed by both the WS (`server.mjs`) and REST (`agents-chat-service.ts`) paths — these have drifted before and an OpenCode-only divergence would be invisible until a user hits the wrong path. Closest existing analog: `loadNewestAntigravityConversation` (custom decoder, not a JSONL normalizer). This decoder is **host/container-agnostic** (same `storage/` shape everywhere), which is exactly why Phase 1 builds and tests it against a local host `opencode` instance before any container exists. **Open:** session multiplexing — OpenCode supports multiple concurrent sessions per project; "which conversation does chat show" needs a rule (recommend: newest session by mtime, matching the other resolvers).

### 6.2 Token-usage / spend — Ziggy track, not ai-maestro
ai-maestro does **not** collect token usage for any harness today; that is the **Ziggy collector's** job (reads transcripts/DBs off disk per surface — exactly the antigravity collector leg shipped 2026-06-17). `ccusage` already supports OpenCode as a data source, proving usage is extractable from `storage/`. So the spend-tracking work is a **Ziggy-collector decoder addition** (a new surface that reads OpenCode's `storage/message/*.json` usage fields) owned by the Vance/Sam Ziggy lane — *separate from this ai-maestro build*. This spec's only obligation: ensure OpenCode's `storage/` is **persisted + mounted** (Phase 2) so the collector can reach it on the host. See `docs/TOOL-USAGE-TRACKING.md` / `METRICS-ARCHITECTURE-DESIGN.md` for the ai-maestro-side metrics surfaces if we later want in-app display.

---

## 7. Open questions (resolve during build / before Phase that needs them)
1. **auth.json schema** — exact provider→key shape OpenCode expects for OpenRouter (drives `provisionCloudOpenCodeConfig`). Confirm against a real `opencode auth login` output.
2. **`opencode.json` model field** — exact key for default model + provider config block for OpenRouter (`base_url`, key reference). Confirm the `provider/model` string form: `cohere/north-mini-code:free` vs `openrouter/cohere/north-mini-code:free`.
3. **Launch form** — does bare `opencode` (TUI) honor the config default model, and does it run cleanly headless-in-tmux? Does `opencode --model <provider/model>` work if we prefer the flag (D5)? Does it need a `run`/non-interactive mode for anything?
4. **Message JSON schema** — fields per `msg_*.json` (role, parts, tool calls, usage, timestamps) → drives the normalizer (§6.1) and confirms usage presence for §6.2.
5. **Instructions ingestion** — how OpenCode picks up agent instructions / mesh-primer (`AGENTS.md`? config field?) so on-wake context reaches it.
6. **Permission model** — OpenCode's autonomy/permission flags (analog to claude `--permission-mode` / yolo `--dangerously-skip-permissions`), for the supervised-vs-autonomous create option.
7. **Version pinning** — pin `opencode-ai` to avoid mid-session self-update corruption (`reference_cloud_agent_self_update_break`); confirm OpenCode has no auto-updater that needs disabling.

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
