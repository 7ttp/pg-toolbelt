# pg-delta-next follow-up branch review

Date: 2026-06-15

Branch reviewed: `feat/pg-delta-next`

Head reviewed: `f4e15ca29c40b1280ccaef4eb24042f2b7c81c70`

Prior review baseline: `f23fffb761d11ce04902ee35de2500d150477edc`

## Scope

This is a second review pass after the 2026-06-15 branch-review findings were
implemented. I focused on the changes landed in these follow-up commits:

- `f035f8e test(pg-delta-next): regression tests + foreign-table corpus for the 2026-06-15 review`
- `4e792af fix(pg-delta-next): address 2026-06-15 branch review (P0-P3)`
- `97d1372 perf(pg-delta-next): reverse-index planner rebuild + bounded-concurrency corpus runner`
- `f4e15ca refactor(pg-delta-next): split extractor by catalog family and rules by kind`

The review bias was the same as the first pass: correctness first, then
performance, locality, and documentation clarity for newcomers.

## Validation performed

The checked-out branch was clean before and after this review.

The following low-cost gates passed:

```bash
cd packages/pg-delta-next && bun run check-types && bun run test
```

Result: 263 tests passed, 0 failed.

I also ran targeted live probes for:

- policy-filtered child facts inlined by create rules;
- `loadSqlFiles` round-budget exhaustion;
- foreign-table relation-level dependency extraction.

## Summary

Most of the earlier fixes landed cleanly. The apply/proof fingerprint gate now
reconstructs the policy/capability view, baseline-shaped plans fail loudly when
the baseline is not supplied, non-transactional apply reports `inDoubt` and
resets session state, SQL export paths are encoded defensively, and role /
membership leakage checks are symmetric.

Three correctness issues still stand out:

1. Policy-filtered child facts can still leak through create-rule inlining.
2. `loadSqlFiles` can return a partially loaded shadow catalog when `maxRounds`
   is exhausted.
3. The `pg_depend` resolver still drops relation-level dependencies on foreign
   tables.

There is also one documentation issue: the new engine-refactor doc overstates
that a canonical projected target is unnecessary, but a filtered-default probe
shows the planner still needs a clearer projected-target seam.

## Findings

### P1: Filtered child facts can still be emitted through create-rule inlining

Files:

- `packages/pg-delta-next/src/plan/plan.ts:207`
- `packages/pg-delta-next/src/plan/plan.ts:214`
- `packages/pg-delta-next/src/plan/plan.ts:457`
- `packages/pg-delta-next/src/plan/plan.ts:502`
- `packages/pg-delta-next/src/plan/rules/tables.ts:153`
- `packages/pg-delta-next/src/plan/rules/tables.ts:158`
- `packages/pg-delta-next/src/plan/rules/tables.ts:164`
- `packages/pg-delta-next/src/plan/rules/tables.ts:177`

The first review's P0 filtered-planning issue was partially fixed by adding the
missing-requirement invariant in `buildActionGraph`. That closes the exact case
where a kept fact depends on a filtered-out fact, such as a table column using an
extension type while the extension add is filtered.

However, action emission still passes the full `desired` fact base into create
rules. Rules that inline child facts via `alsoProduces` can therefore create a
fact whose own add delta was filtered out.

Focused repro:

- source contains schema `app` and table `app.t`;
- desired adds column `app.t.x integer` and default `DEFAULT 42`;
- policy filters out `{ kind: "default", verb: "add" }`;
- planner keeps only `add:column`, filters `add:default`;
- emitted action is:

```sql
ALTER TABLE "app"."t" ADD COLUMN "x" integer DEFAULT 42
```

The action also marks both `column` and `default` as produced. The plan target
fingerprint excludes the default, so proof catches the drift, but a caller that
plans and applies without proof can create managed drift.

The same Module shape exists anywhere create rules inline children:

- `column.create` inlines a `default` child;
- `table.create` inlines partitioned-table columns;
- `type.create` inlines composite `typeAttribute` children;
- publication rules use `alsoProduces` for publication relation/schema facts.

Recommended fix:

- After delta filtering, use the projected target as the rule `FactView` for
  action emission and compaction decisions.
- Preserve the original desired edge information, or an explicit
  "filtered dependency" view, for missing-requirement checks. The invariant needs
  to know that a dependency was filtered away; emission needs to avoid rendering
  filtered child facts.
- Add a regression for the default example above. The expected result should be
  either:
  - `ALTER TABLE ... ADD COLUMN "x" integer` with no default, or
  - a plan-time error if filtering child facts independently is declared invalid.

Architecture note:

The planner currently exposes too much of the policy projection as caller
discipline inside one Module. The better seam is: "emission sees the plan target;
requirement validation can also inspect the pre-projection desired graph."
That keeps the `FactBase` Interface deep while making the invariant explicit.

### P1: `loadSqlFiles` returns partial state when `maxRounds` is exhausted

Files:

- `packages/pg-delta-next/src/frontends/load-sql-files.ts:300`
- `packages/pg-delta-next/src/frontends/load-sql-files.ts:306`
- `packages/pg-delta-next/src/frontends/load-sql-files.ts:308`
- `packages/pg-delta-next/src/frontends/load-sql-files.ts:480`

The loader's retry loop increments `rounds`, breaks when the budget is exceeded,
and then continues into shared-object checks, body validation, DML rejection, and
final extraction. If progress was made before the budget ran out, the loader can
return a partial fact base instead of throwing.

Probe:

```ts
await loadSqlFiles(
  [
    { name: "00_table.sql", sql: "CREATE TABLE app.t (id integer);" },
    { name: "01_schema.sql", sql: "CREATE SCHEMA app;" },
  ],
  shadow.pool,
  { maxRounds: 1 },
);
```

Observed result:

```json
{"rounds":2,"hasSchema":true,"hasTable":false}
```

That is dangerous because the SQL-file frontend is an Adapter into the fact
graph. Its Interface should be all-or-error: either all declarative files are
loaded and extracted, or no fact base is returned.

Recommended fix:

- Do not `break` on round exhaustion.
- Throw `ShadowLoadError` immediately when `rounds > maxRounds`, including the
  names of pending files and the last failure messages if available.
- Add tests for:
  - `maxRounds: 0` with any file;
  - a two-round dependency chain with `maxRounds: 1`.

### P1: Foreign-table relation-level dependencies are still dropped

Files:

- `packages/pg-delta-next/src/extract/dependencies.ts:73`
- `packages/pg-delta-next/src/extract/dependencies.ts:81`
- `packages/pg-delta-next/src/extract/dependencies.ts:214`
- `packages/pg-delta-next/src/extract/dependencies.ts:290`
- `packages/pg-delta-next/tests/depend-edges-oracle.test.ts:8`

The follow-up fixed extraction of constraints on foreign tables, but the
set-based `pg_depend` resolver still does not map `pg_class.relkind = 'f'` in
the relation resolver CTE. The codec has a `foreignTable` branch, but the SQL
never produces that id for relation-level `pg_class` endpoints.

Live probe:

```sql
CREATE EXTENSION file_fdw;
CREATE SCHEMA app;
CREATE SERVER corpus_srv FOREIGN DATA WRAPPER file_fdw;
CREATE FOREIGN TABLE app.ft (id integer)
  SERVER corpus_srv OPTIONS (filename '/tmp/pg_delta_missing.csv', format 'csv');
CREATE VIEW app.v_count AS SELECT count(*) AS n FROM app.ft;
CREATE VIEW app.v_cols AS SELECT id FROM app.ft;
```

Observed extracted edges:

```text
view:app.v_cols -[depends]-> column:app.ft.id
view:app.v_cols -[depends]-> schema:app
view:app.v_count -[depends]-> schema:app
```

For a normal table, `SELECT count(*) FROM app.t` produces a `view -> table`
dependency edge. For the foreign table, the relation-level dependency is dropped.

Why this matters:

- a view that selects columns may still depend on `column:app.ft.id`;
- a view that references only the relation shape, such as `count(*)`, loses the
  dependency on `foreignTable:app.ft`;
- if the foreign table creation is filtered out, the missing-requirement
  invariant has no dependency edge to trip.

Recommended fix:

- Add `WHEN 'f' THEN 'foreignTable'` to the `rel` CTE mapping.
- Include `'f'` in the `relkind` filter.
- Extend `tests/depend-edges-oracle.test.ts` with a foreign table and a view that
  references it without selecting a column, such as `count(*)`.

### P2: Engine-refactor docs overstate the projected-target conclusion

Files:

- `docs/roadmap/tier-3-engine-refactors.md:11`
- `docs/roadmap/tier-3-engine-refactors.md:18`
- `docs/roadmap/tier-3-engine-refactors.md:26`
- `docs/roadmap/tier-3-engine-refactors.md:34`

The doc says making `projectedDesired` canonical is deliberately not done, and
that the missing-requirement invariant fully addresses the P0 issue. That is too
strong after the filtered-default probe.

The real conclusion is more nuanced:

- using only `projectedDesired` for graph validation would indeed hide some
  filtered dependency edges;
- using full `desired` for emission lets filtered child facts leak into SQL;
- the planner needs two clearly named views, not one ambiguous `desired`.

Recommended wording:

- Emission should use the projected plan target.
- Requirement checks should consult original desired dependency information, or a
  separately retained filtered-edge set.
- The invariant is necessary but not sufficient for delta-set inlining.

### P2: Onboarding docs still point at pre-split implementation files

Files:

- `docs/architecture/onboarding.md:34`
- `docs/architecture/onboarding.md:37`
- `docs/roadmap/tier-3-engine-refactors.md:12`
- `docs/roadmap/tier-3-engine-refactors.md:13`
- `docs/roadmap/tier-3-engine-refactors.md:57`
- `docs/roadmap/tier-3-engine-refactors.md:66`

The implementation now splits extractor families under `src/extract/*.ts` and
rule families under `src/plan/rules/*.ts`, but the onboarding checklist still
sends contributors to monolithic `extract.ts` and `rules.ts`. The roadmap also
marks the split as pending even though `f4e15ca` shipped it.

Recommended fix:

- Update onboarding to say:
  - orchestrator: `src/extract/extract.ts`;
  - family extractors: `src/extract/relations.ts`, `foreign.ts`, `types.ts`, etc.;
  - rule registry Interface: `src/plan/rules.ts`;
  - family rule Implementations: `src/plan/rules/*.ts`.
- Update the roadmap status table to mark extractor/rule split shipped.

## Things that look good

The follow-up work improved several important Modules:

- `FactBase` now exposes lower-allocation lookup and incoming-edge helpers.
- Forced rebuild propagation uses reverse dependency reachability instead of
  repeated full-edge scans.
- `apply()` reconstructs the policy/capability view for the fingerprint gate.
- Baseline-shaped apply/proof paths fail loudly instead of silently comparing the
  wrong state.
- Non-transactional apply uses `inDoubt` and resets session GUCs in `finally`.
- SQL-file shared-object leak detection is symmetric for roles and memberships.
- SQL export uses path-safe identifier segments plus a CLI root-escape guard.
- The extractor and rule-table split improves locality while preserving the
  single deep public Interface.

## Suggested next work order

1. Fix the SQL-file loader `maxRounds` partial-return bug. It is small, sharp,
   and easy to regression-test.
2. Fix foreign-table relation dependency resolution and pin it in the dependency
   oracle.
3. Fix planner emission to use the projected plan target while preserving the
   original desired graph for missing-requirement checks.
4. Update the engine-refactor and onboarding docs to reflect the actual current
   design.
5. Add a focused policy-projection test suite around all `alsoProduces` shapes:
   defaults, partitioned-table columns, composite type attributes, and publication
   subfacts.

## Closing assessment

The branch moved in the right direction after the first review. The remaining
issues are all concentrated around seams where one Module exposes two subtly
different meanings of "desired": full desired catalog, managed desired view, and
projected plan target. Naming and enforcing those views explicitly would buy both
correctness and locality.

The architecture still looks sound: `FactBase` is the right deep Interface, the
rule registry remains a strong planner Interface, and the proof loop is the right
confidence mechanism. The next improvements should make the policy projection
seam explicit enough that rule authors cannot accidentally render facts outside
the plan target.
