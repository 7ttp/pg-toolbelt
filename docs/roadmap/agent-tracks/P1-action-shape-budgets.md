# P1 — Action-shape budgets in corpus

**Priority:** High (proof quality) · **Wave:** 3 · **Ship:** alone · **Depends on:** V1 preferred · **Serialize with:** P2 if both edit `prove.ts`

## Goal

Make the corpus catch **convergent but catastrophic** plans (e.g. DROP+CREATE
where in-place ALTER is required) via **action-shape budgets** / semantic
assertions — not only hash convergence.

## Why this track exists

Proof answers “does the managed view converge?” Drop+create almost always proves
green. Reviews called this out: proof is a backstop, not a synthesis oracle.
Without budgets, maintainers optimize for green proofs over idiomatic DDL.

## Out of scope

- Unfiltered drift mode (P2)
- Changing autoSeed defaults (P3) — coordinate if you share `engine.test.ts`
- Compaction defaults (C1)
- Rewriting the rule table for every noisy scenario — only pin high-risk kinds

## Owned files (write)

| Area | Paths |
|---|---|
| Budget helper | New `packages/pg-delta/src/proof/budgets.ts` (preferred) **or** test-only helper under `tests/` |
| Harness | `packages/pg-delta/tests/engine.test.ts` (minimal hook) |
| Fixtures | Opt-in per-scenario files under `packages/pg-delta/corpus/<scenario>/` e.g. `budget.json` or `expect.yaml` |
| Unit tests | `src/proof/budgets.test.ts` |

**Avoid large edits to** `proof/prove.ts` — if you need a hook, add a small
exported `summarizeActions(plan)` and keep prove’s control flow intact so P2
can own prove API changes.

## Design requirements

1. Budgets are **opt-in per scenario** (don’t break 300+ scenarios on day one).
2. Start with a small allowlist of high-risk scenarios (replace-vs-alter for
   tables/columns, views/policies rebuild storms, extension drops).
3. Budget dimensions — **lead with semantic assertions** (stable, express intent):
   - forbid `drop`/`create` of kind K when alter is expected
   - forbid `replace` when `alter` expected (or require specific action kinds)
   - **Avoid** raw `max actions total` as a primary budget — it rots into
     snapshot-churn on every unrelated planner improvement. Use counts only as
     a last resort for a known pathological storm, with a comment explaining why.
4. Failure message must show **actual vs budget** and scenario name.
5. Document fixture schema in `corpus/README` or `tests/README` if one exists;
   otherwise a short section in this track’s PR description + comment on helper.
6. Cross-link known-bad shapes to live issues when possible:
   [#332](https://github.com/supabase/pg-toolbelt/issues/332),
   [#333](https://github.com/supabase/pg-toolbelt/issues/333) — prefer pinning
   real backlog bugs over purely synthetic fixtures.

## RED → GREEN

1. Pick one known noisy-but-wrong-shape scenario (or craft a tiny corpus case)
   that today converges with too many DROP+CREATE.
2. **RED:** Add `budget.json` that fails on current plan shape.
3. **GREEN:** Only if the track includes a planner fix — **this track’s default
   is harness-only**. If the first scenario fails for a real planner bug, either:
   - land harness + known-failing budget as `test.skip` / expected-fail list, or
   - split: P1 lands harness + budgets for scenarios that already pass; file
     follow-up issues for failing ones.
4. Prefer: land 3–5 budgets that **pass on current main**, proving the harness,
   plus one skipped RED documenting a known bad shape.

## Acceptance criteria

- [ ] Fixture format + loader documented
- [ ] Engine harness enforces budgets when present
- [ ] ≥3 live scenarios with passing budgets
- [ ] ≥1 documented known-bad shape (skip or issue link) if no planner fix in-PR
- [ ] Changeset: `test` or `feat` if public prove helpers exported

## Conflicts

- **P2:** do not both rewrite `prove.ts` / `engine.test.ts` heavily — if P2 is
  active, P1 owns only `budgets.ts` + corpus fixtures; P2 owns prove API.
- **I1:** avoid rename corpus churn while I1 open; pick non-rename scenarios.

## Done when

Corpus can express “this migration must look like X,” unblocking later planner
tightening without expanding prove’s convergence contract.
