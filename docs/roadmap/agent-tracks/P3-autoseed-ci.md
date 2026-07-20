# P3 — autoSeed on by default in CI corpus

**Priority:** Medium · **Wave:** 3 · **Ship:** alone (tiny) · **Parallel with:** P1 (if P1 avoids prove defaults), D0, K1, V1 · **Depends on:** nothing (V1 not required)

## Goal

Turn on **data-proof seeding** (`autoSeed`) for the corpus / CI path so empty
tables don’t silently get `contentMode: "none"` and green-wash data safety.

## Why this track exists

`prove.ts` already supports coverage modes and opt-in `autoSeed`. Reviews noted
empty tables → weak data proof. Productizing honesty means CI exercises the
stronger path.

## Out of scope

- Budgets (P1), unfiltered drift (P2)
- Changing fingerprint algorithms
- Seeding strategy redesign beyond enabling existing autoSeed

## Owned files (write)

| Area | Paths |
|---|---|
| Corpus harness | `packages/pg-delta/tests/engine.test.ts` |
| CI | `.github/workflows/tests.yml` only if an env flag is required |
| Prove defaults (careful) | Prefer harness-level `autoSeed: true` over changing global library default |
| Docs | One line in `packages/pg-delta/README.md` prove section or corpus docs |

## Design requirements

1. Prefer **test/CI opt-in** over changing library default for all `provePlan`
   callers (avoid surprising embedders).
2. If some scenarios cannot seed (extensions, exotic types), allowlist skips with
   reason — don’t weaken the global default for everyone.
3. Failures must be actionable (which scenario, which table, coverage mode).

## RED → GREEN

1. Enable autoSeed on corpus; run:
   ```bash
   cd packages/pg-delta
   PGDELTA_TEST_IMAGE=postgres:17-alpine bun test tests/engine.test.ts
   ```
2. Fix or skip scenarios that fail for environmental reasons; do not disable
   autoSeed globally to silence them.

## Acceptance criteria

- [ ] Corpus CI path runs with autoSeed enabled
- [ ] Library default for ad-hoc `provePlan` unchanged (or documented if changed)
- [ ] Skip list (if any) documented
- [ ] Changeset if prove public defaults change; else `test`/`ci` only

## Conflicts

- Light touch on `engine.test.ts` — coordinate with P1 if both land the same week
- Avoid editing `prove.ts` control flow (P2’s turf)

## Done when

CI data proof is meaningfully stronger than fingerprint-on-empty-tables.
