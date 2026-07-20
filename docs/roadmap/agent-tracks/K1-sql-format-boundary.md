# K1 — Honest boundary for sql-format / frontends

**Priority:** Low · **Wave:** 6 · **Ship:** alone · **Parallel with:** almost everything · **Conflicts with:** agents restructuring `frontends/` broadly

## Goal

Make the **engine vs product surface** budget honest: `frontends/sql-format`
(~3.8k LOC) and related export/load helpers should be mentally (and optionally
physically) separate from the trusted extract/diff/plan/proof core.

## Why this track exists

Package LOC ~27k; frontends alone ~7.8k. Overview’s “lean rewrite” story fails
when sql-format counts as “engine.” Architecture reviews asked to treat
sql-format as a separate mental budget so engine size stays truthful (pairs with
D0).

## Out of scope

- Planner/proof/identity changes
- Rewriting the formatter algorithm
- Mandatory new npm package (optional stretch)

## Owned files (write)

Pick **one** delivery tier and state it in the PR:

### Tier A (minimum — docs + exports)

- `docs/overview.md` / architecture README — call out frontend budget (coordinate
  with D0 if both open: D0 owns overview numbers, K1 owns “sql-format is not
  core” wording)
- `packages/pg-delta/src/index.ts` / `frontends/index.ts` — ensure public export
  paths make “core vs frontend” obvious
- Package README structure section

### Tier B (stretch — package boundary)

- Move `frontends/sql-format` to `packages/pg-delta-sql-format` or subpath export
  `@supabase/pg-delta/sql-format`
- Update dependents + changeset for both packages if split

Prefer **Tier A** unless product already wants a split publish.

## Acceptance criteria

- [ ] Docs clearly exclude sql-format from “engine LOC”
- [ ] Import guidance: core embedders need not pull formatter
- [ ] If Tier B: CI/build/exports green; changeset(s) for publish surface
- [ ] No formatter behavior change unless accidental and tested

## Test plan

- Tier A: docs only
- Tier B: `bun run build`, `bun run check-types`, targeted frontend tests

## Done when

Agents measuring “engine size” stop counting sql-format as planner complexity.
