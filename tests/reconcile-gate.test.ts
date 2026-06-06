/**
 * RELAND partition gate — vitest wrapper.
 *
 * Wires the deterministic KEEP_OURS gate (scripts/reconcile/verify-keep-ours.mjs) and the
 * agent-container require/COPY check (verify-agent-container-requires.mjs) into `yarn test`
 * so the 23blocks reconciliation re-land CANNOT merge with the #161 failure class present.
 *
 * Expected to be RED until the keepOurs restore worklist + surgical fixes land, then GREEN.
 * That is intentional: these tests are the merge gate, not unit coverage. See
 * scripts/reconcile/README.md for the partition + how to clear the worklist.
 */
import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const run = (script: string) => {
  try {
    const out = execFileSync('node', [join(root, 'scripts/reconcile', script)], { encoding: 'utf8' });
    return { code: 0, out };
  } catch (e: any) {
    return { code: e.status ?? 1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
};

describe('23blocks reconciliation RELAND gate', () => {
  it('partition is exhaustive and keepOurs==ours / adoptUpstream==upstream', () => {
    const { code, out } = run('verify-keep-ours.mjs');
    if (code !== 0) console.error(out);
    expect(code, out).toBe(0);
  });

  it('every relative require() target in agent-container entrypoints is COPY\'d (no #H crash-on-require)', () => {
    const { code, out } = run('verify-agent-container-requires.mjs');
    if (code !== 0) console.error(out);
    expect(code, out).toBe(0);
  });
});
