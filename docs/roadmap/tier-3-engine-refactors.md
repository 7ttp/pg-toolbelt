# Tier 3 — engine refactors (locality & allocation)

- **Status (2026-06-15):** the substantive items shipped; the rest are either a
  deliberate non-decision or a pure file-move recommended as its own commit.
  | # | Item | Status |
  |---|---|---|
  | 2 | reverse-index reachability rebuild | ✅ shipped (corpus 420/420) |
  | 3 | `FactBase.getByEncoded` + `incomingEdges` | ✅ shipped |
  | 7 | onboarding map + COVERAGE scope table | ✅ shipped |
  | 6 | non-txn apply state | ✅ substance shipped in the P1 fix (`inDoubt` + reset-in-`finally`) |
  | 1 | `projectedDesired`-canonical | ⛔ deliberately NOT done — redundant with the shipped P0-1 invariant and would *regress* it (see below) |
  | 4 | split extractor by family | 🟡 pure file-move — recommended as a dedicated commit |
  | 5 | split `rules.ts` by family | 🟡 pure file-move — recommended as a dedicated commit |
- Deferred from the 2026-06-15 branch review
  ([../archive/pg-delta-next-branch-review-2026-06-15.md](../archive/pg-delta-next-branch-review-2026-06-15.md)),
  whose **correctness findings all shipped**. None of these changes behaviour.

## 1. `projectedDesired` as the canonical planning view — ⛔ deliberately NOT done

The review offered this as one of **two** ways to fix P0-1 (filtered planning
referencing a missing dependency). We shipped the **other** one: the
missing-requirement invariant in `buildActionGraph` (`src/plan/internal.ts`),
which fails loud when a produced fact's `depends` edge resolves to something
neither produced nor present in source.

Doing *both* is not additive — it is actively harmful here. Routing the graph
build through `projectedDesired` would reconstruct it as a `FactBase` from the
projected facts, and the **filtered-out dependency edge becomes dangling and is
dropped** by the `FactBase` constructor. The P0-1 invariant relies on that edge
being present in `desired` to detect the missing requirement — so switching to
`projectedDesired` would **silently regress the very bug the invariant fixes**,
and the no-policy corpus (where `projectedDesired ≡ desired`) could not catch it.

So P0-1 is fully addressed by the invariant; this refactor is intentionally not
taken. Revisit only if `buildActionGraph` is reworked to consult both views
(projected for ordering, `desired` for the requirement check) — net complexity
with no behaviour gain over today.

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

## 4. Split the extractor by catalog family

`src/extract/extract.ts` is large enough that locality suffers. Keep the public
`extract()` interface; split the internal query builders by object family
(relations, constraints, functions, policies, publications, rls, security-labels,
event-triggers), with shared scope + the dependency resolver in one place. A
locality improvement, not a new abstraction layer. (The stale stage-history
comments the review flagged are already corrected.)

## 5. Split rule definitions by kind

`src/plan/rules.ts` (~2.2k lines): keep the single exported registry as the
planner interface; move rule definitions into per-family files and compose them
in `rules.ts`, with shared helpers in one place. Improves review locality while
preserving the data-driven leverage.

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
