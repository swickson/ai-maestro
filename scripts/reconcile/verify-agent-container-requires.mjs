#!/usr/bin/env node
// verify-agent-container-requires.mjs — build-side guard for the #H crash-on-require class.
//
// PR #161 / #162 crash-looped because agent-server.js require()'d sibling modules
// (claude-home-merge.cjs, restoration-gate.cjs) whose Dockerfile COPY lines the merge
// had dropped — content-grep "present" passed, the container still crashed on boot.
// (Image-verify needs a boot test, not a content grep — [image-verify-needs-boot-test].)
//
// This asserts every RELATIVE require()/import target in agent-container/*.js{,.cjs} that
// the entrypoint loads is actually COPY'd into the image. Generalizes #H so any future
// dropped-COPY regression fails at CI, before it can crash-loop a real agent.

import { execSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { basename, join } from 'node:path';

const DIR = 'agent-container';
const REF = process.argv[2]; // optional git ref; default = working tree
const GENV = { ...process.env, GIT_LITERAL_PATHSPECS: '1' };
const read = (f) => REF
  ? execSync(`git show ${REF}:${f}`, { encoding: 'utf8', env: GENV })
  : readFileSync(f, 'utf8');
const exists = (f) => REF
  ? (() => { try { execSync(`git cat-file -e ${REF}:${f}`, { env: GENV }); return true; } catch { return false; } })()
  : existsSync(f);

const fail = [];

// Entry modules to trace (the ones the container actually boots). agent-server.js is the
// tmux/PTY entrypoint; extend if more .cjs entrypoints get wired.
const ENTRIES = ['agent-server.js'];

// --- Collect Dockerfile COPY source basenames (files landed into the image) ---
const dockerfile = read(join(DIR, 'Dockerfile'));
const copied = new Set();
for (const line of dockerfile.split('\n')) {
  const m = line.match(/^\s*COPY\s+(.+)$/i);
  if (!m) continue;
  // strip --flags, split tokens; last token is dest, the rest are sources
  const toks = m[1].replace(/--\S+\s+/g, '').trim().split(/\s+/);
  if (toks.length < 2) { toks.forEach((t) => copied.add(basename(t.replace(/\*+$/, '')))); continue; }
  toks.slice(0, -1).forEach((t) => copied.add(basename(t.replace(/\*+$/, ''))));
}

// --- For each entry, assert it's COPY'd and every relative require target is COPY'd ---
const reqRe = /(?:require\(\s*|from\s+)['"](\.\/[^'"]+)['"]/g;
for (const entry of ENTRIES) {
  const entryPath = join(DIR, entry);
  if (!exists(entryPath)) { fail.push(`entry ${entryPath} missing`); continue; }
  if (!copied.has(basename(entry))) fail.push(`entry ${entry} is not COPY'd in Dockerfile`);

  const src = read(entryPath);
  const targets = new Set();
  let m;
  while ((m = reqRe.exec(src))) {
    let t = m[1].replace(/^\.\//, '');
    if (!/\.\w+$/.test(t)) t += '.cjs'; // bare relative require — node resolves .js/.cjs; check the .cjs form
    targets.add(t);
  }
  for (const t of targets) {
    const b = basename(t);
    const onDisk = exists(join(DIR, t)) || exists(join(DIR, t.replace(/\.cjs$/, '.js')));
    const isCopied = copied.has(b) || copied.has(b.replace(/\.cjs$/, '.js'));
    if (!onDisk) fail.push(`${entry} require('./${t}') — target file not present in ${DIR}/`);
    else if (!isCopied) fail.push(`${entry} require('./${t}') — present in ${DIR}/ but NOT COPY'd in Dockerfile (would crash on boot)`);
  }
}

if (fail.length) {
  console.log(`✗ agent-container require/COPY check FAILED (${fail.length}):`);
  for (const f of fail) console.log(`  ✗ ${f}`);
  process.exit(1);
}
console.log(`✓ agent-container require/COPY check passed — every relative require target is COPY'd.`);
