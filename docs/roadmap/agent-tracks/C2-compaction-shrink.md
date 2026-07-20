# C2 — Shrink load-bearing compaction elisions

**Priority:** Medium–Low · **Wave:** 4 (after C1) · **Ship:** alone · **Depends on:** C1 (dual-prove safety net) · **Conflicts with:** H1 (same `internal.ts`)

## Goal

After compaction is off the correctness default, **delete or move** elisions that
encode ADP/default-ACL/create-as-applier semantics into the rule table (or leave
them only on the pretty path with explicit tests).

## Why this track exists

Even as a pretty-printer, `internal.ts` kind-switches (policy drops, PUBLIC
defaults, ACL revoke/grant folding). Reviews: anything needing “is this
load-bearing?” should consult payload+edges in one helper or not elide.

## Out of scope

- Default compact flip (already C1)
- Full declarative rule IR (H2)
- Identity (I1)

## Owned files (write)

- `packages/pg-delta/src/plan/internal.ts` (+ `internal.test.ts`)
- Possibly `plan/rules/metadata.ts` if an elision becomes a rule suppress
- Docs: comment pass list in README compact section

## Method

1. Inventory compaction passes (README already lists ~5).
2. Classify each: **pure cosmetic** vs **encodes PG default/create model**.
3. For load-bearing ones:
   - move suppress/redirect into `KindRules`, or
   - keep behind pretty-only with a named export + unit tests proving
     equivalence on fixtures.
4. Prefer fewer passes over cleverer passes.

## RED → GREEN

Per elision removed/moved: a unit test that pins before/after SQL or action
lists on a minimal fact fixture (TDD).

## Acceptance criteria

- [ ] `internal.ts` LOC trending down (target: meaningful cut, not drive-by)
- [ ] No elision that ignores payload refs the way
      `elideCascadeSubsumedPolicyDrops` historically could
- [ ] Pretty path still useful for common ACL noise
- [ ] Changeset `refactor` or `fix` if behavior of `--compact` changes

## Done when

Compaction is honestly a peephole pretty-printer; H1 lint can ban new kind
switches in `internal.ts` without a huge allowlist.
