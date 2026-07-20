# C1 — Prove compaction is not required for convergence

**Priority:** Medium · **Wave:** 4 · **Ship:** one PR · **Depends on:** I1 preferred (avoid rename+compact fights) · **Conflicts with:** V1, I1, C2, H1

## Goal

**Enforce** “compaction must not be required for convergence” in the corpus by
**dual-proving every scenario compact and uncompact**. Treat any default flip
for library/CLI as a **secondary** product decision, not the correctness fix.

## Why this track exists

`plan/internal.ts` (~992 LOC) runs multi-pass elision (`compact !== false` in
`plan/plan.ts`). Reviews: “cosmetic” ACL/ADP/policy elisions encode create-model
semantics; `--no-compact` vs compact can diverge in review while both claim to
prove. Compaction is a second planner on the hot path.

**Why not “just default uncompact for prove”?** If CLI users still emit and apply
compacted plans, and prove uses the same compact setting as the plan under test,
compaction remains on the user-facing correctness path. Flipping library/prove
defaults only changes which variant CI exercises — and can *reduce* coverage of
the path humans actually run. Dual-prove fixes the stated problem directly.

## Out of scope

- Rewriting every elision into rules (that’s C2)
- Identity normalize (I1)
- sql-format (K1)

## Owned files (write)

| Area | Paths |
|---|---|
| Corpus harness | `packages/pg-delta/tests/engine.test.ts` — dual prove loop |
| Plan options | `plan/plan.ts` only as needed to make compact on/off explicit and testable |
| Prove | `proof/prove.ts` only if harness needs a clean “prove this plan artifact” API |
| Docs | README / corpus note: both shapes must converge |
| Optional product | CLI flags / library default — **after** dual-prove is green |

## Design requirements

### Primary (required)

1. **Corpus dual-prove:** for every scenario × direction, build/apply/prove a
   plan with `compact: true` **and** with `compact: false`. Both must converge
   (state proof; data proof per existing coverage rules).
2. Failure message must name scenario, direction, and which compact mode failed.
3. Cost: expect ~2× corpus wall time per PG version (~2–3 min → ~5 min on
   `postgres:17-alpine`). Acceptable; do not “optimize” by sampling unless CI
   matrix forces a documented shard strategy.
4. Fingerprint/apply for each mode uses the **same** compact setting as that
   plan (no cross-wired compact/uncompact).

### Secondary (optional in same PR or follow-up)

5. Product default for human CLI `plan` output may stay compacted; library
   embedders may choose either. Document clearly.
6. Do **not** land a default flip that removes compact from CI coverage.

## RED → GREEN

1. **RED:** Harness runs dual-prove; if any scenario fails uncompact (or compact)
   today, that failure is the pin — fix planner/compaction or skip with issue
   link only if environmental.
2. **GREEN:** Dual-prove green on PG17 full corpus.
3. Run:
   ```bash
   cd packages/pg-delta
   bun test src/plan/internal.test.ts
   PGDELTA_TEST_IMAGE=postgres:17-alpine bun test tests/engine.test.ts
   ```

## Acceptance criteria

- [ ] Every corpus scenario proves under `compact: true` and `compact: false`
- [ ] Docs state compaction is a pretty-printer, not a correctness dependency
- [ ] plan == prove == apply compact setting preserved per mode
- [ ] Changeset: `test` / `fix` as appropriate (harness is the main deliverable)
- [ ] Optional default flips called out separately in the PR body if included

## Conflicts / do not touch

- `role-rename-carry` / identity normalize
- Deep rewrite of individual elisions (C2)

## Done when

CI will fail if a future elision makes uncompacted (or compacted) plans diverge
from convergence; C2 can shrink elisions with a real safety net.
