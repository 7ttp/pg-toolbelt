# H1 — Planner-body kind-switch lint

**Priority:** Low–Medium · **Wave:** 5 · **Ship:** alone · **Depends on:** C1 (prefer after C2) · **Parallel with:** H2 if H1 is lint-only · **Conflicts with:** I1, C1, C2 while those edit `internal.ts`

## Goal

Add a guard test (like `diff.guard.test.ts`) that fails when new per-kind
switches appear in planner **body** modules outside the rule table / approved
allowlist — so Guardrail 3 doesn’t rot into folklore.

## Why this track exists

Generic diff is kind-free; `plan/` still has many kind checks (~127 historically).
`internal.ts` knows schema/acl/owner/role. Without a lint, the next PG feature
lands as another late pass.

## Out of scope

- Large behavioral refactors (do those in C2/H2 first)
- Touching `core/diff.ts` guard (already exists)

## Owned files (write)

- New: `packages/pg-delta/src/plan/plan.guard.test.ts` (name flexible)
- Allowlist comment block documenting approved files:
  - `plan/rules/**` — allowed
  - `plan/phases/replacement-expansion.ts` — allowed with note
  - `plan/internal.ts` — temporary allowlist entries shrinking over time
- Optional: tiny cleanups **only** if needed to make the baseline lint pass

## Design requirements

1. Mirror the spirit of `diff.guard.test.ts` (grep for kind string literals or
   `kind ===` in disallowed paths).
2. Start with a **baseline allowlist** that matches today’s code — lint is
   ratchet, not a rewrite.
3. PR description lists allowlist entries and which track will remove them.

## RED → GREEN

1. Write guard in failing mode against a known bad pattern, then set allowlist
   so CI is green.
2. Optionally add one intentional violation in a test fixture file to prove the
   guard catches regressions.

## Acceptance criteria

- [ ] Guard runs in `bun test src/`
- [ ] Allowlist documented
- [ ] No unrelated refactors
- [ ] Changeset usually unnecessary (`test` only)

## Done when

New kind switches in `plan/plan.ts` / `internal.ts` fail CI unless explicitly
allowlisted.
