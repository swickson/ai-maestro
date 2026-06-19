# Model Eval Playbook — Is a Coding Model Worth Adopting?

> **Status:** Authored by the ai-maestro dev team from the north-mini-code:free eval (2026-06-19). A reusable, model-agnostic procedure for deciding whether a candidate coding model earns a place in the fleet — and if so, in which lane. The methodology is the durable asset; the specific model under test is not.
>
> **Companion docs:** [`OPENCODE-HARNESS-SPEC.md`](./OPENCODE-HARNESS-SPEC.md) is the containerized OpenCode/OpenRouter harness this playbook drives. [`CLOUD-CODING-AGENT-RUNBOOK.md`](./CLOUD-CODING-AGENT-RUNBOOK.md) covers standing up cloud coding agents and the dev-team review/gate architecture; this doc covers the *controlled evaluation* of a model's coding ability, which is a different question.

---

## 0. When to use this

Run this playbook whenever you are weighing a **new or untried coding model** as a candidate tier — a cheap free-tier model, a mid-tier paid model, a self-hosted model, anything. Because the OpenCode harness is a **reusable gateway to any OpenRouter model**, swapping the model under test is a one-line config change (`opencode.jsonc` `model:` field) with **no rebuild** — so the cost of evaluating the next candidate is almost entirely the orchestration described here, not infrastructure.

The output is **not** a pass/fail score. It is a **lane assignment**: *which task classes, if any, can this model be trusted on, and is that worth the orchestration tax it imposes?*

---

## 1. The governing axiom

> **No model is trusted to evaluate its own work.**

This single rule generates the entire architecture below. A model's self-reported "tests pass" is **not a trusted signal** — cheap models in particular write plausible code *and* self-tests that encode or miss the same bug (false-green). The only trusted signals are **objective**: a compiler (`tsc`) and an **independently authored** test suite. Everything else is opinion.

---

## 2. Setup — zero blast radius

1. **Harness:** the containerized OpenCode agent pointed at OpenRouter (see the harness spec). Set the candidate via `opencode.jsonc` `model:` (e.g. `openrouter/<provider>/<model>`); `variant: high` for the model's best shot. No rebuild between candidates.
2. **Isolated clone:** the candidate works on a **fresh git clone** with its origin reset and **no push credentials** — it commits locally only. Zero blast radius to the real repo.
3. **Fresh, model-verified one-shot per attempt:** run each task in a **fresh bounded session** (`opencode run "<prompt>"`), not one sprawling session accumulating context. Some harnesses cold-start to a default model — **read the model back from `opencode.db` every run and confirm** it is the candidate before counting the output. A wrong-model turn is a void run.
4. **Grade on the host, never inside the run.** The orchestrator re-runs `tsc` and the test suite itself and reads the real exit code (see §3 traps).

---

## 3. The controls — hold these constant across every task

| Control | Rule |
|---|---|
| **Gate author** | A **capable** model (e.g. Claude) authors the objective gate — the spec-tests. **Identical** gate per task across both orderings, so ordering is the only variable. |
| **Candidate role** | Author-only. **Never** sees the gate-author's tests in code-first; never co-authors the gate. |
| **Two orderings** | **A = code-first:** candidate codes blind to the tests → gate-author runs the gate → candidate fixes to green. **B = test-first:** gate-author writes tests first → candidate iterates to green. |
| **Grading** | From **real** `tsc` + test runs. The candidate's **own** tests are **discounted** — they false-green over edges. |
| **Independent correctness sweep** | After green, the gate-author independently inspects for correctness the tests did not assert — **especially untouched-but-dependent callers** on cross-module tasks. |

**False-green traps to defend against (these have bitten real runs):**
- **Pipe-masked exit status.** `tsc … | head` returns the *pipe's* status, not `tsc`'s — a failing typecheck reads as success. Always `cmd > log 2>&1; echo EXIT=$?`.
- **Old-behavior tests.** An existing test that asserts the *old* behavior goes **red on the correct fix** and is **silent on every new seam**. Patching that one assertion to green gives false confidence. Run the **full** suite, and read what each red is actually telling you.
- **`.db` mtime ≠ liveness.** SQLite WAL means the main `.db` file mtime can stay frozen while live writes land in `-wal`. Judge a run's progress by message-count / commits, not file mtime.

---

## 4. The escalating-realism ladder — the core instrument

Climb a model up a ladder of increasing realism until **the gate stops protecting it**. The load-bearing question at each rung is **not** "where does it get worse" — it is:

> **At which rung does the gate stop being able to certify correctness?**

| Rung | Class | What it tests |
|---|---|---|
| **R0** | Trivial + edge warmup | Basic reliability. Cheap models are often *sloppiest* here (ships non-compiling trivials). |
| **R1** | Pure utils, enumerable edges (slugify, parsers, validators, formatters) | Can a bounded gate fully spec it? This is the model's best-case lane. |
| **R2** | Stateful / async / side-effecting (LRU cache, etc.) | Holds behavior across calls. |
| **R3** | Codebase-integration — extend **real** existing code in the clone | First exposure to edit-damage of surrounding code. |
| **R4** | Ambiguous / under-spec | Judgment under-spec; does it flail or reason? |
| **R5** | Multi-step | Sequencing; does it complete all steps? |
| **R6** | **Live cross-module refactor** — a change that must ripple across ≥2 modules + call sites | **The breaker.** Where seam-completeness becomes unattainable for a one-shot gate. |
| **R7** *(optional)* | Real bug-fix in live code | Closest to production worker-tier work. |

The deliverable of a run is the **collapse characterization**: which rung breaks it, and *in which mode* (§5).

---

## 5. The failure taxonomy — name the mode, not just the rung

Two failure modes matter, and they behave **oppositely** under a gate:

- **LOUD-structural** — breaks a caller, deletes a brace, bad import → **compile-caught**. *Safe behind any gate*, just costs fix-loops. Code-first tends here.
- **QUIET-seam (gate-green-but-wrong)** — passes `tsc` **and** the gate, but is wrong in a module the gate never enumerated. **This is the true ceiling.** Test-first tends here, because the model converges to *exactly what the tests demand and no more*.

Two named hazards seen at realistic rungs:
- **Over-reach** — broad find-replace edits scope it was never asked to touch (code-first).
- **Overclaim** — declares "consistent across the codebase" after gate-green **without inspecting** the modules it didn't edit (test-first).

> ⚠️ **Type-preserving changes neutralize the compiler.** If a refactor doesn't change types, `tsc` gives **zero** protection — the independent seam sweep is then doing 100% of the work. Flag type-preserving tasks explicitly.

---

## 6. The three decision lenses

These are the load-bearing findings that turn raw run data into an adoption decision.

1. **The seam-completeness ceiling.** A cheap model is a viable author **only as complete as the gate is seam-complete.** A **one-shot gate cannot certify cross-module correctness** — in practice even a *capable gate-author under-enumerates the seams* (the candidate may surface a seam the gate, scout, and first sweep all missed). So on cross-module work, quiet gate-green-but-wrong is **structurally under-detected**, no matter how good the gate-author is.

2. **The capability / gate-completeness anti-correlation.** The tasks where a gate can be made cheaply seam-complete (single-module, type-rich, enumerable) are exactly where the model is **sloppiest**. The tasks where the model is **strongest** (hard, directed) are exactly where the gate **cannot** be made complete one-shot. → *The safety net is thinnest precisely where you'd want to lean on it.*

3. **The economic-inversion test.** To make a cheap model safe on realistic cross-module work you need: a capable model to author a seam-complete gate **+** a different-model cross-reviewer who distrusts its tests **+** fix loops. **Run the arithmetic:** if that capable-model time **exceeds** just having the capable model author the code, the cheap lane is a net loss. Free tokens don't change this — the orchestration tax lands on the **capable** models, and on the bounded tasks where the cheap lane *is* safe, your reliable author is already fast, so the savings are marginal exactly where it works.

---

## 7. The decision template — assign lanes, don't grade

A candidate that doesn't clear "general worker-tier author" can still earn a **narrow** lane. Output one of:

**TRUST (cheap-author-behind-gate earns its keep):**
- Single-module pure functions, parsers, validators, formatters, isolated utils with **enumerable** edges; throwaway scaffolding a human eyeballs. `tsc` + a bounded test set **is** the complete spec there.
- Run **code-first-from-full-prose** (loud breakage, caught). **Never** trust a test-first 7/7 green — that is the false-comfort signal that makes an orchestrator stop looking.

**THE DIVERGENT-SCOUT LANE (often the higher-value use of a cheap model):**
- The candidate's *weaknesses* (over-reach + greps-wide) become an **asset** for **seam discovery**. Run **N cheap divergent passes**; a capable model adjudicates; their **disagreements flag under-enumerated seams** a single gate misses. Free + diverse beats one-reliable-author for seam **discovery** — never for seam **authoring**, and never as the last line of defense.

**NEVER hand it:**
- Cross-module refactors; **type-preserving** changes (compiler protection = zero); anything touching tenancy / auth / money / cascades; "make it consistent across the codebase" (overclaims); broad find-replace (over-reaches).

**Context modifier — what's the token-cap pressure?** If the fleet runs on flat-rate plans (Max/Ultra) with **no** token-cap pain, the bar is higher: a cheap model's savings must beat the orchestration tax, and that tax is paid in capable-model time regardless. With **real** token pressure, the same model may clear a bar it wouldn't otherwise. State the cost context in the verdict.

---

## 8. Worked example — north-mini-code:free (2026-06-19)

The run that produced this playbook. Ladder R0→R6, both orderings, Claude-authored gate, graded from real `tsc`/`vitest`, isolated clone.

- **R0–R1:** sloppy on trivials (shipped non-compiling code committed-as-done; false-green self-tests); **counterintuitively better on hard/directed tasks** than trivial ones.
- **R1 (pure utils):** viable behind the gate (all attempts reached green). Test-first paid (0 fix rounds vs 1). But both orderings shipped an identical latent bug the gate didn't test → **green ≠ correct; the gate's coverage is the ceiling.**
- **R2–R5:** no catastrophic collapse. Code-first = loud structural breakage (caught); test-first = quiet under-implementation when the gate under-covered.
- **R6 (live cross-module refactor):** the ceiling. **2–4 quiet seams per attempt**, every one `tsc`-clean **and** gate-green, in modules never enumerated. Type-preserving → `tsc` gave zero protection. **The model surfaced a seam the human gate-author had missed.**

**Verdict:** **Not** a viable general worker coding agent; viable in two narrow lanes (bounded-pure-function author behind a cheap-complete gate; cheap adversarial seam-scout feeding a capable adjudicator). **Not adopted into the fleet** — under Max/Ultra plans with no token-cap pressure, the narrow restrictions plus the orchestration tax outweighed the marginal savings (the economic-inversion test, §6.3). The reusable harness + this playbook were the durable outcome.

---

## 9. Running the next candidate — checklist

1. Name the model; set `opencode.jsonc` `model:` (+ `variant: high`). **No rebuild.**
2. Fresh isolated clone, no push creds.
3. Capable model authors the per-task objective gate (identical across orderings).
4. Climb the ladder (§4), both orderings, fresh model-verified one-shot per attempt.
5. Grade on the host (§3 traps); independent seam sweep after green.
6. Fill the scorecard per attempt: iterations-to-green, edge-bugs-caught, convergence, final correctness, quiet-seam count, **net cost vs capable-author-solo**, model-verified-each-run.
7. Apply the three decision lenses (§6) and emit a **lane assignment** (§7), with the token-cost context stated.
8. Keep the clone + per-batch `RESULTS.md` as the evidence record; tear down the eval agent + container.
