/**
 * antigravity-usage-emit — node-invocable EMIT wrapper around
 * extractAntigravityUsage (Part 1.5 of the antigravity token-accounting work).
 *
 * Prints the LOCKED cross-language contract JSON (see AntigravityUsageContract
 * in lib/antigravity-db-decoder.ts) for ONE antigravity conversation `.db` to
 * stdout, so the Ziggy spend pipeline (Python, github.com/swickson/ziggy
 * apps/token-ingest) can consume it WITHOUT re-implementing the protobuf field
 * map. Part 1 (the TS decoder) stays the sole source of truth.
 *
 *   npx tsx scripts/antigravity-usage-emit.mts <conversation.db>
 *
 * Output (stdout, single line): { sourcePath, model,
 *   gens:[{input,output,thinking,ts}], totals:{input,output,thinking},
 *   identityRate:{checked,ok}, tsPlausibilityRate:{checked,ok} }
 * - `sourcePath` echoes the db arg verbatim so each record self-attributes. The
 *   aggregator is DUMB — collects every token from every agent, NO filtering /
 *   exclusion; the DB/dashboard does ALL attribution + scoping by agent/project.
 *   So sourcePath is for (1) cross-host DEDUP via its stable suffix (agent-uuid +
 *   conversation-uuid) and (2) DB-side per-agent attribution — NOT a gate/exclusion.
 * - `gens[].ts` = per-gen unix SECONDS (or null) for per-day event_date bucketing.
 * - `identityRate` guards the token fields; `tsPlausibilityRate` guards `ts`
 *   (sec-range) — collector uses ts when plausible, else a db-mtime fallback.
 * The wrapper itself does NO tenancy parsing and is stateless per-.db.
 *
 * Exit codes (so a batch consumer can branch deterministically):
 *   0 — usage emitted to stdout
 *   2 — usage error (missing/extra args)
 *   3 — no extractable usage (db missing/garbage, or no gen_metadata) — stdout
 *       empty, diagnostic on stderr; the consumer skips this file
 *
 * This wrapper handles ONE .db. Iterating conversation roots is the consumer's
 * job; on a host both roots hold .db files and BOTH must be walked:
 *   - per-agent:  ~/.aimaestro/agents/<id>/antigravity-app-data/conversations/
 *   - host operator: ~/.gemini/antigravity-cli/conversations/
 * (Old encrypted `.pb` files carry no gen_metadata — skip them, .db only.)
 *
 * Dynamic import (not a static named import) mirrors the WS decode path and
 * avoids the tsx/esbuild named-binding quirk on this require()-using module.
 */

const dbPath = process.argv[2]
if (!dbPath || process.argv.length > 3) {
  process.stderr.write('usage: tsx scripts/antigravity-usage-emit.mts <conversation.db>\n')
  process.exit(2)
}

const { extractAntigravityUsage, toUsageContract } = await import('../lib/antigravity-db-decoder')

const usage = extractAntigravityUsage(dbPath)
if (!usage) {
  process.stderr.write(`[antigravity-usage-emit] no extractable usage in ${dbPath}\n`)
  process.exit(3)
}

// Echo dbPath verbatim as sourcePath — the collector attributes from it.
process.stdout.write(`${JSON.stringify(toUsageContract(usage, dbPath))}\n`)
