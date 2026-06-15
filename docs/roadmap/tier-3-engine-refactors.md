# Tier 3 — engine refactors (locality & allocation)

- **Status (2026-06-15):** the substantive items shipped; the rest are either a
  deliberate non-decision or a pure file-move recommended as its own commit.
  | # | Item | Status |
  |---|---|---|
  | 2 | reverse-index reachability rebuild | ✅ shipped (corpus 420/420) |
  | 3 | `FactBase.getByEncoded` + `incomingEdges` | ✅ shipped |
  | 7 | onboarding map + COVERAGE scope table | ✅ shipped |
  | 6 | non-txn apply state | ✅ substance shipped in the P1 fix (`inDoubt` + reset-in-`finally`) |
  | 1 | `projectedDesired` planning view | 🟢 emission seam shipped (follow-up review P1 #1); graph build stays on `desired` (see below) |
  | 4 | split extractor by family | ✅ shipped (`f4e15ca`) |
  | 5 | split `rules.ts` by family | ✅ shipped (`f4e15ca`) |
- Deferred from the 2026-06-15 branch review
  ([../archive/pg-delta-next-branch-review-2026-06-15.md](../archive/pg-delta-next-branch-review-2026-06-15.md)),
  whose **correctness findings all shipped**. None of these changes behaviour.

## 1. `projectedDesired` as the planning view — two views, deliberately distinct

This item conflated two consumers that want DIFFERENT views. The follow-up
review (P1 #1) showed why an earlier "do nothing, the invariant covers it"
framing was too strong, and the resolution is now shipped:

- **Emission uses the projected plan target.** `plan()` renders create / recreate
  / in-place-alter actions against `projectedDesired` (`src/plan/plan.ts`), so a
  child fact whose own add delta was policy-filtered (a column's DEFAULT, a
  partitioned table's columns, a composite type's attributes, a publication's
  relations) is never inlined via `alsoProduces` and never claimed as produced.
  Rendering against full `desired` leaked filtered children into the SQL —
  managed drift on a non-proof apply path.
- **The graph build stays on un-projected `desired`.** The missing-requirement
  invariant in `buildActionGraph` (`src/plan/internal.ts`) fails loud when a
  produced fact's `depends` edge resolves to something neither produced nor
  present in source. It relies on that edge being PRESENT in `desired`. Routing
  the graph build through `projectedDesired` would reconstruct a `FactBase` whose
  filtered-out dependency edge is dangling and **dropped by the constructor** —
  silently regressing the very bug the invariant fixes, invisibly to the
  no-policy corpus (where `projectedDesired ≡ desired`).

So the invariant is **necessary but not sufficient** for delta-set inlining: it
catches a kept fact that needs a filtered-away dependency, but it cannot stop
emission from rendering a filtered child it can still see. Projected for
emission, `desired` for the requirement check — the "two clearly named views"
the review asked for, kept distinct in `plan()`. There is intentionally no single
canonical view.

## 2. Precompute planner maps + a reverse dependency index

`src/plan/plan.ts`: the forced-rebuild loop rescans **all** `source.edges` each
round, and replacement paths call `source.facts().find(...)` / `desired.facts().find(...)`
repeatedly — `O(rounds × edges)` + array copies in the hottest module. For large
schemas, build `sourceFactsById` / `desiredFactsById` maps once, build a reverse
dependency index once, and express forced-rebuild propagation as a reachability
walk from the initially-forced ids. Pure performance; behaviour-identical (the
corpus + differential are the gate).

## 3. `FactBase` lower-allocation iteration helpers

`src/core/fact.ts`: `get`/`has`/`outgoingEdges` already exist and are good. A few
consumers still call `facts()` then `.find(...)`, rebuilding their own indices.
Add `incomingEdges(id)` if reverse walks become common (see #2). The goal is to
stop consumers drifting from the canonical representation, **not** to widen the
interface for convenience.

## 4. Split the extractor by catalog family — ✅ shipped (`f4e15ca`)

`src/extract/extract.ts` is now just the orchestrator; the per-family query
builders live in their own files (`relations.ts`, `foreign.ts`, `types.ts`,
`routines.ts`, `policies.ts`, `publications.ts`, `roles.ts`, `schemas.ts`,
`event-triggers.ts`, `security-labels.ts`, …) with shared scope in `scope.ts`
and the authoritative `pg_depend` resolver in `dependencies.ts`. The public
`extract()` interface is unchanged — a locality improvement, not a new
abstraction layer. (The stale stage-history comments the review flagged were
corrected at the same time.)

## 5. Split rule definitions by kind — ✅ shipped (`f4e15ca`)

`src/plan/rules.ts` is now the registry/interface only; the rule definitions
live in per-family files under `src/plan/rules/` (`tables.ts`, `types.ts`,
`constraints.ts`, `indexes.ts`, `views.ts`, `policies.ts`, `publications.ts`,
`routines.ts`, `sequences.ts`, `triggers.ts`, `roles.ts`, `schemas.ts`,
`foreign.ts`, `metadata.ts`) with shared rendering helpers in `helpers.ts`. The
single exported registry stays the planner's interface, preserving the
data-driven leverage while improving review locality.

## 6. Non-transactional apply as an explicit state machine

`src/apply/apply.ts`: the `inDoubt` status + `RESET ALL` in `finally` (review P1)
landed. The fuller refactor models non-transactional apply as an explicit
`Pending → Applied/InDoubt → ResetOk/ResetFailed` machine so retry behaviour and
CLI messaging are uniform. Optional polish on top of the shipped fix.

## 7. Docs: newcomer map + evidence-shaped coverage

- A short newcomer architecture map (extract → fact base → diff → plan → apply/
  prove; where policy/capability/baseline enter) + an "add a new object kind"
  checklist. `docs/overview.md` §3 has the pipeline diagram; this is the
  contributor-oriented version.
- `COVERAGE.md`: move toward a per-family `Extracted | Planned | Proven | Scope
  limits` table (the foreign-table CHECK-constraint gap, now fixed, was the
  motivating example of the current categories being too coarse).

## Cross-links

- The review (all correctness findings shipped):
  [../archive/pg-delta-next-branch-review-2026-06-15.md](../archive/pg-delta-next-branch-review-2026-06-15.md).
- Planner/apply/extract: `src/plan/{plan,internal,rules}.ts`,
  `src/apply/apply.ts`, `src/extract/extract.ts`, `src/core/fact.ts`.
