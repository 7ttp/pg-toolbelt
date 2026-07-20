# Agent tracks — architecture follow-ups

Detailed, delegation-ready briefs for the architecture work prioritized after
the Jul 2026 reviews. Each track is one agent / one PR unless the brief says
otherwise.

**Commit this folder before delegating** — untracked briefs are invisible to
agents in fresh worktrees.

## Cross-links to live correctness backlog

This folder is scoped to **architecture hygiene** from the Jul reviews. It does
not replace the plan/apply fidelity backlog. When picking corpus pins or rename
scenarios, prefer concrete issues:

- [#332](https://github.com/supabase/pg-toolbelt/issues/332) — extraction/model fidelity gaps
- [#333](https://github.com/supabase/pg-toolbelt/issues/333) — plan/apply correctness gaps

Especially relevant to **P1** (known-bad action shapes) and **I1** (rename
identity scenarios).

## Dependency graph

```text
D0 (docs metrics) ─────────────────────────────────────────── anytime
P3 (autoSeed CI)  ─────────────────────────────────────────── anytime (parallel with V1)

V1 (reconstructManagedView) ──► I1 (pre-diff rename identity)
                            └──► P1 / P2 / C1 may start after V1
                                 (respect conflict matrix)

I1 ──► C1 (dual-prove compact and uncompact) ──► C2 / H1

P1 parallel P3 after or beside V1; serialize P1 vs P2 on prove.ts
P2 after V1; sole owner of prove.ts while open

H1 after C1 (file overlap with internal.ts)
H2 PARKED — evidence-gated, not scheduled
K1 anytime (frontends/sql-format only)
I2 docs anytime (avoid colliding with I1 identity docs)
```

## Parallel waves

| Wave | Ship together? | Tracks | Notes |
|---|---|---|---|
| 0 | Alone | [D0](D0-docs-metrics.md) | Parallel with anything; re-measure LOC/corpus at PR time |
| 1 | **One PR** | [V1](V1-reconstruct-managed-view.md) | Blocks I1; four full call sites only |
| 2 | **One PR** (I1) | [I1](I1-prediff-rename-identity.md), optional [I2](I2-identity-invariants-docs.md) | I2 docs-only parallel I1 if different files |
| 3 | Separate PRs | [P1](P1-action-shape-budgets.md), [P2](P2-unfiltered-drift.md), [P3](P3-autoseed-ci.md) | P3 parallel anything; serialize P1 vs P2 on `prove.ts` |
| 4 | **One PR** (C1) | [C1](C1-compaction-split.md) then [C2](C2-compaction-shrink.md) | C1 = mandatory dual-prove |
| 5 | Lint only | [H1](H1-planner-kind-lint.md) | After C1 |
| — | **Not scheduled** | [H2](H2-declarative-rule-ir.md) | Evidence-gated; do not delegate |
| 6 | Alone | [K1](K1-sql-format-boundary.md) | Anytime |

## Conflict matrix

| Track | Do not run in parallel with |
|---|---|
| V1 | I1, C1, P2 (plan / prove / apply / export) |
| I1 | V1, C1, H1; anyone on `role-rename-carry`, `change-set`, `action-emitter` |
| C1 | V1, I1, C2, H1 |
| P1 vs P2 | both heavy on `prove.ts` / engine harness — one owner or serialize |
| D0, K1, I2, P3 | almost nothing |

## Suggested first delegation

1. **Agent A → V1**
2. **Agent B → D0** (parallel with A); **Agent D → P3** also fine beside A
3. After V1: **Agent C → I1**; parallel **Agent E → P1** (semantic budgets)

## Review amendments (2026-07-20)

Applied after codebase fact-check:

1. **I1** — pinned canonical direction = desired names; rename actions injected
   outside generic diff; RED must be behavioral (no relabel-pair churn), not
   "carry module absent."
2. **C1** — primary deliverable is corpus **dual-prove** compact and uncompact;
   default flips are secondary.
3. **P2** — unfiltered drift = baseline-subtracted catalog (not raw extract).
4. **H2** — parked / evidence-gated.
5. **V1** — only four full composition sites; diff/seed stay resolveView-only.
6. **P1** — semantic budgets first; drop count budgets as primary.
7. **P3** — no V1 dependency.

## Conventions for every agent

- Repo: `packages/pg-delta` under pg-toolbelt. Follow `AGENTS.md` (TDD for
  fix/feat, changeset for behavior changes, focused tests only while iterating).
- Do **not** expand scope into another track's owned files.
- End with: summary of what changed, tests run, residual risks, and whether a
  follow-up track is unblocked.
