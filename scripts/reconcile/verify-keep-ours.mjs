#!/usr/bin/env node
// verify-keep-ours.mjs — the RELAND partition gate.
//
// Closes the #161 failure class permanently. #161 shipped because should-be-ours files
// hid silently in the took-upstream bucket and were discovered serially, never as a set.
// This gate makes that structurally impossible:
//
//   1. EXHAUSTIVE PARTITION — re-derives the full contested set independently and asserts
//      keepOurs ∪ adoptUpstream ∪ handMerge == contested, exactly. FAILS on ANY unclassified,
//      extra, or duplicated contested file. No file can land as took-upstream un-decided.
//   2. PER-BUCKET RESOLUTION — keepOurs files MUST == ours (18f373a); adoptUpstream files
//      MUST == upstream (pinned merge-base). Any drift fails the build.
//   3. handMerge files are gate-blind by design (intra-file regressions) — reported for the
//      mandatory per-file human review, never silently trusted.
//
// Run standalone (CI / pre-PR) or via the vitest wrapper. Exit non-zero on any violation.
// Usage: node verify-keep-ours.mjs [ref]   (ref defaults to HEAD — the tree being validated)

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const REF = process.argv[2] || 'HEAD';
const OURS = '18f373a';
const EXPECT_BASE = 'e48965751c58a85c186f6e43b152a176589930da';
const EXPECT_COUNT = 250;
const RECONCILE_BRANCH = 'reconcile/23blocks-merge';

// Literal pathspecs are MANDATORY — 24 bracketed route paths (app/api/.../[id]/...) would
// otherwise be glob-interpreted by git and silently mis-compared.
const GENV = { ...process.env, GIT_LITERAL_PATHSPECS: '1' };
const sh = (c) => execSync(c, { encoding: 'utf8', env: GENV }).trim();
const same = (a, b, f) => { try { execSync(`git diff --quiet ${a} ${b} -- "${f}"`, { env: GENV }); return true; } catch { return false; } };

const fail = [];
const note = (m) => console.log(m);

// --- 1a. Pin upstream base via merge-base (self-correcting vs a moving origin/main) ---
let BASE;
try { BASE = sh(`git merge-base ${RECONCILE_BRANCH} origin/main`); }
catch { BASE = sh(`git merge-base ${RECONCILE_BRANCH} origin/HEAD`); }
if (BASE !== EXPECT_BASE) fail.push(`upstream merge-base ${BASE} != pinned ${EXPECT_BASE} (wrong upstream commit — partition drift)`);

// --- 1b. Re-derive the contested set INDEPENDENTLY of the manifest ---
const contested = sh(`git diff --name-only ${OURS} ${BASE}`).split('\n').filter(Boolean);
if (contested.length !== EXPECT_COUNT) fail.push(`contested set ${contested.length} != ${EXPECT_COUNT}`);
const contestedSet = new Set(contested);

// --- Load the manifest ---
const manifest = JSON.parse(readFileSync(new URL('./reland-manifest.json', import.meta.url), 'utf8'));
const { keepOurs = [], adoptUpstream = [], handMerge = [] } = manifest;

// --- 2. Exhaustive + disjoint partition check ---
const union = [...keepOurs, ...adoptUpstream, ...handMerge];
const seen = new Map();
for (const f of union) seen.set(f, (seen.get(f) || 0) + 1);
const dups = [...seen.entries()].filter(([, n]) => n > 1).map(([f]) => f);
if (dups.length) fail.push(`manifest has duplicate entries across buckets: ${dups.join(', ')}`);

const unclassified = contested.filter((f) => !seen.has(f));
if (unclassified.length) fail.push(`UNCLASSIFIED contested files (the #161 hole): ${unclassified.length}\n    ${unclassified.join('\n    ')}`);

const extra = union.filter((f) => !contestedSet.has(f));
if (extra.length) fail.push(`manifest lists non-contested files: ${extra.join(', ')}`);

// --- 3. Per-bucket resolution against REF ---
const koMiss = keepOurs.filter((f) => !same(OURS, REF, f));
if (koMiss.length) fail.push(`keepOurs files NOT == ours @${OURS} (restore worklist): ${koMiss.length}\n    ${koMiss.join('\n    ')}`);

const auMiss = adoptUpstream.filter((f) => !same(BASE, REF, f));
if (auMiss.length) fail.push(`adoptUpstream files NOT == upstream @${EXPECT_BASE.slice(0,7)}: ${auMiss.length}\n    ${auMiss.join('\n    ')}`);

// --- handMerge: report only (gate-blind; covered by mandatory per-file review) ---
const hmOurs = handMerge.filter((f) => same(OURS, REF, f));
const hmUp = handMerge.filter((f) => same(BASE, REF, f));
const hmBoth = handMerge.filter((f) => !same(OURS, REF, f) && !same(BASE, REF, f));

// --- Report ---
note(`RELAND gate @${REF}`);
note(`  contested=${contested.length} keepOurs=${keepOurs.length} adoptUpstream=${adoptUpstream.length} handMerge=${handMerge.length}`);
note(`  handMerge resolution: differs-from-both=${hmBoth.length}  ==ours=${hmOurs.length}  ==upstream=${hmUp.length}`);
if (hmOurs.length) note(`    [review] handMerge files currently == ours (surgical edit may be pending): ${hmOurs.join(', ')}`);
if (hmUp.length) note(`    [review] handMerge files currently == upstream (surgical edit may be pending): ${hmUp.join(', ')}`);

if (fail.length) {
  note(`\n✗ GATE FAILED (${fail.length}):`);
  for (const f of fail) note(`  ✗ ${f}`);
  process.exit(1);
}
note(`\n✓ GATE PASSED — partition exhaustive; keepOurs == ours; adoptUpstream == upstream.`);
