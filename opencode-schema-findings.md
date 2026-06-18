# OpenCode Harness — Phase 1 Step 1: Empirical Schema Findings

**Author:** CelestIA (dev-aimaestro-bananajr) · 2026-06-18
**Task:** PR #250 spec, Phase 1 Step 1 — capture real on-disk schemas, close open Qs 1/2/4 before building the decoder.
**Source:** the real working install Shane stood up on bananajr (opencode **v1.17.8**, official curl installer).

---

## ⚠️ HEADLINE — the spec's on-disk contract (§2, §6.1) is WRONG for the installed version

The spec (§2 "Verified facts", §6.1) says OpenCode stores conversations as a **directory fan-out of per-message JSON files**:
- `storage/message/{sessionID}/msg_{messageID}.json`
- `storage/session/{projectHash}/{sessionID}.json`

**Reality on bananajr (opencode v1.17.8): there is NO `storage/` directory at all.** Conversations live in a single **SQLite database** `~/.local/share/opencode/opencode.db` (+ `-wal` + `-shm`), with relational tables. This is the antigravity `.pb`→`.db` migration story repeating: the JSON-fan-out era was an older opencode (what the ccusage docs / issue #5238 described); v1.x migrated to SQLite. The DB has **35 schema migrations** through 2026-06-12 (incl. `20260601010001_normalize_storage_paths`, `20260510033149_session_usage`) — fully SQLite-native, not a transitional state.

**Net effect:** this is *good* news — cleaner than a fan-out, relational, with usage data sitting in typed columns, and we already own a proven in-repo SQLite-decode pattern (`lib/antigravity-db-decoder.ts`, better-sqlite3, dual `.db`/`-wal` watch). But it **reshapes the decoder** (§6.1 is now a SQLite query, not a JSON globber) and several touchpoints (§4.3, §4.5). Contract must be re-locked before building.

---

## Install layout (real, bananajr)

| Item | Path | Notes |
|------|------|-------|
| Binary | `~/.opencode/bin/opencode` | curl installer drops it here (NOT `~/.local/bin` as §2 guessed). `~/.opencode/` = install root w/ its own node_modules. |
| Version | **1.17.8** | matches `@opencode-ai/plugin` 1.17.8 in config dir. |
| Data dir | `~/.local/share/opencode/` | holds `auth.json`, **`opencode.db`(+wal+shm)**, `log/`, `repos/`, `snapshot/`. NO `storage/`. `OPENCODE_DATA_DIR` override still applies → D3 mount target unchanged. |
| Config dir | `~/.config/opencode/` | `opencode.jsonc` (note **`.jsonc`**, not `.json`), + auto-created `node_modules`/`package.json` for plugins. |

---

## Q1 — auth.json schema ✅ RESOLVED

`~/.local/share/opencode/auth.json`, perms 600:
```json
{ "openrouter": { "type": "api", "key": "<OpenRouter key, 73 chars, sk-or-...>" } }
```
Top-level keyed by **providerID**; value = `{ "type": "api", "key": "<key>" }`. Plain provider-key JSON — **writable directly, no interactive `opencode auth login`** → D4 confirmed, copy the `provisionCloudCodexAuth` shape exactly.

(The DB's `account`/`credential`/`control_account` tables are for opencode's own cloud/OAuth accounts — all 0 rows here — NOT provider API keys. Provider keys live only in auth.json.)

## Q2 — model / provider config ✅ RESOLVED (reshapes D5)

- `opencode.jsonc` is **essentially empty**: `{ "$schema": "https://opencode.ai/config.json" }`. The model is **NOT** stored in the config file in this install.
- Model + provider are persisted **per-session in the DB**:
  - `session.model` column = `{"id":"cohere/north-mini-code:free","providerID":"openrouter","variant":"high"}`
  - each message `data.model` = `{"providerID":"openrouter","modelID":"cohere/north-mini-code:free","variant":"high"}`
- **String form (answers Q2 directly):** model id = `cohere/north-mini-code:free`; provider = `openrouter` as a **separate field** — NOT slash-concatenated `openrouter/cohere/north-mini-code:free`.
- **Implication for D5 (build, Phase 2):** since interactive selection persists to the DB (not viable for a fresh container), we must set the default model declaratively. opencode's config `model` field uses the slash-joined `provider/model` form (`openrouter/cohere/north-mini-code:free`) per opencode docs — to confirm in Phase 2. The empty config here is because Shane picked the model in the TUI; a provisioned container can't rely on that.

## Q4 — message JSON schema ✅ RESOLVED

Relational, 4 tables matter. Conversation = `project` → `session` → `message` → `part`.

**`project`** (1 row): `id` = 40-char hash of worktree (`6d9f2904…` for `/home/gosub/Documents/Development/ai-maestro`), `worktree` (root path), `vcs`, `time_created`. *This is the "projectHash" — derived from the worktree path.*

**`session`**: `id` (`ses_…`), `project_id` FK, `directory` (cwd), `title`, `version`, `agent` (`"build"`), `model` (JSON, above), `time_created`/`time_updated`, **rolled-up usage columns**: `cost`, `tokens_input`, `tokens_output`, `tokens_reasoning`, `tokens_cache_read`, `tokens_cache_write`. → **Session multiplexing rule (§6.1 open):** newest session by `time_updated`, scoped to the agent's `project_id`/`directory`.

**`message`**: `id` (`msg_…`), `session_id` FK, `time_created`/`time_updated`, `data` (JSON):
- user: `{"role":"user","time":{"created":…},"agent":"build","model":{providerID,modelID,variant},"summary":{…}}`
- assistant: `{"parentID":"msg_…","role":"assistant","mode":"build","agent":"build","variant","path":{"cwd","root"},"cost","tokens":{"total","input","output","reasoning","cache":{"write","read"}},"modelID","providerID","time":{"created","completed"},"finish":"stop"}`

**`part`**: `id` (`prt_…`), `message_id` FK, `session_id` FK, `data` (JSON), **discriminated by `.type`**:
- `text` → `{"type":"text","text":"…","time":{"start","end"}?}`  ← the actual chat content
- `step-start` → `{"type":"step-start","snapshot":"<git-sha>"}`
- `step-finish` → `{"type":"step-finish","reason":"stop","snapshot","tokens":{…},"cost"}`
- **tool parts NOT present** in this simple Q&A session — need a tool-using session to characterize the tool part shape (opencode uses `type:"tool"` per docs). Shape is type-discriminated, so the normalizer dispatches on `part.data.type`.

**Normalizer plan (revised §6.1):** query `session` for newest-by-`time_updated` in the agent's project → join `message` (ordered by `time_created`/seq) → for each message gather `part` rows (ordered) → emit text parts as content, map tool parts to tool calls, attach role/model/tokens from `message.data`. Single shared `loadNewestOpencodeConversation(dataDir)` reading `opencode.db`, consumed by BOTH WS (`server.mjs`) and REST (`agents-chat-service.ts`).

---

## §6.2 token-usage (Ziggy track) — bonus: trivially decodable

Usage is sitting in columns/JSON in three redundant places: `session.tokens_*`/`cost` (rolled up), each assistant `message.data.tokens`, and `step-finish` `part.data.tokens`. Far cleaner than antigravity's protobuf. (Sample real session: input 16979 / output 61 / reasoning 263 / cost 0 — free tier.) Hands the Ziggy collector a clean surface; still their lane.

---

## Touchpoints this correction changes (vs spec §4)

- **§4.3 `resolveConversationDir`** — cloud + host branches should resolve to the **`opencode.db` path** (or data dir, decoder opens the db), NOT `…/storage`.
- **§4.5 chat decoder** — rewrite from "glob `storage/message/*.json`" to a SQLite reader. Closest analog is `loadNewestAntigravityConversation` / `lib/antigravity-db-decoder.ts` — reuse the **dual `.db` + `-wal` watch** discipline (live turns land in `-wal` pre-checkpoint; watching only `.db` mtime misses them — the exact antigravity #233 lesson, [[feedback_sqlite_wal_watch_not_main_db]]).
- **D5 model config** — empty config + DB-persisted model means container provisioning must set the model declaratively (Phase 2 confirm of opencode.json `model` field form).
- Everything else (D2 `kind:'opencode'`, D3 single data-dir mount, D4 direct auth.json provision, D6 one shared loader, mounts/migrate/reserved-paths) stands as written — the mount still carries `opencode.db`, so persistence design is unaffected.

---

## Recommendation

Lock the corrected contract (SQLite, not JSON fan-out) with KAI/Shane, patch spec §2/§6.1/§4.3/§4.5, THEN build Phase 1 decoder against this real `opencode.db`. Do NOT build the normalizer against the obsolete fan-out contract. One open data-gap before the normalizer is final: capture a **tool-using** opencode session to lock the `type:"tool"` part shape.
