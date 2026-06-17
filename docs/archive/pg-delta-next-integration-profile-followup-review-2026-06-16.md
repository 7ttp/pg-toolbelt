# pg-delta-next integration profile follow-up review

Date: 2026-06-16  
Branch reviewed: `feat/pg-delta-next`  
HEAD reviewed: `06e3e4192200a396981bf49671d567c998f6034d`  
Previous review: `docs/archive/pg-delta-next-architecture-handoff-review-2026-06-16.md`

## Scope

This is a follow-up review after implementing the architecture handoff review's
managed-view / integration-profile recommendations. It focused on whether the
previous P0/P1 risks were actually closed:

- managed extension objects must not be dropped through the default safe path;
- extension handlers must run inside the same extraction snapshot as core
  catalog extraction;
- planning, proof, and apply must reconstruct the same managed view;
- the public surface and CLI must expose a usable profile path;
- `loadSqlFiles` must reject user DML without rejecting extension-owned internal
  rows.

## Summary

The implementation is directionally strong and materially closes the serious
findings from the previous review.

The new `IntegrationProfile` / `ResolvedProfile` Module is the right seam. It
gives callers one resolved context containing handler-aware extraction plus
plan/prove/apply option bundles. `extract` now accepts handlers and runs them
inside the same repeatable-read transaction. `resolveView` now projects
`managedBy` in the same place as `memberOfExtension`, so managed object
projection has one definition. Apply and proof can use the profile's
handler-aware re-extractor, and targeted integration tests prove the partman
apply fingerprint gate passes with operational children present.

I do not see a remaining P0/P1 blocker in this implementation. The remaining
items are hardening and documentation follow-ups.

## Findings

### P2: Plan artifacts do not record the profile that produced them

References:

- `packages/pg-delta-next/src/plan/plan.ts:89`
- `packages/pg-delta-next/src/plan/plan.ts:949`
- `packages/pg-delta-next/src/cli/profile.ts:30`
- `packages/pg-delta-next/src/cli/commands/apply.ts:52`
- `packages/pg-delta-next/src/cli/commands/prove.ts:104`

The new CLI comments correctly say the apply/prove profile must match the plan
profile. But that invariant is only comment-level today.

The `Plan` artifact persists:

- source and target fingerprints;
- policy;
- applier capability;
- deltas/actions/safety report.

It does not persist the profile id or handler set that produced the source
fingerprint. Meanwhile `apply` and `prove` default to the `raw` profile when
`--profile` is omitted. A plan produced with `--profile supabase` can therefore
be handed to:

```bash
pg-delta-next apply --plan plan.json --target ...
pg-delta-next prove --plan plan.json --clone ... --desired-snapshot ...
```

and those commands will resolve the raw profile, not the Supabase profile.

This likely fails safely for the known pg_partman case: the fingerprint gate or
proof drift should see operational children reappear and reject the run. But the
error is indirect, and the Interface still relies on the operator remembering to
repeat the profile exactly.

#### Suggested fix

Stamp the plan artifact with the selected profile id when the CLI uses a known
profile.

Possible shape:

```ts
interface Plan {
  // ...
  profile?: { id: string };
}
```

Then make CLI `apply` and `prove` behave as follows:

- if `--profile` is omitted and `plan.profile?.id` exists, use that profile;
- if both are present and differ, fail before opening the apply/proof path;
- if the profile id is unknown to this binary, fail with a direct message;
- keep raw/no-profile behavior available for library-produced artifacts.

This turns the current comment-level contract into an artifact-level Interface.
The leverage is high: one small field prevents every future profile command from
having to rediscover mismatches through drift or fingerprint failure.

Suggested tests:

- serialize/parse round-trips `profile.id`;
- CLI profile resolver defaults to the artifact profile when `--profile` is
  omitted;
- CLI rejects `plan.profile.id = "supabase"` with `--profile raw`;
- apply/prove still allow legacy artifacts without a profile field.

### P3: Phase B roadmap docs still describe removed helper Interfaces

References:

- `docs/roadmap/extension-intent-phase-b.md:24`
- `docs/roadmap/extension-intent-phase-b.md:27`
- `docs/roadmap/extension-intent-phase-b.md:74`
- `docs/roadmap/tier-1-extension-intent-phase-b.md:26`
- `docs/roadmap/tier-1-extension-intent-phase-b.md:30`
- `docs/roadmap/tier-1-extension-intent-phase-b.md:58`

The canonical architecture docs were refreshed, but the Phase B roadmap still
names the pre-profile substrate:

- `excludeManaged(factBase)` as the main subtraction path;
- `ExtensionHandler` + `extractWithHandlers` + `extractManaged`;
- proof re-capture via `extractManaged`.

The implementation intentionally removed that recipe. The new substrate is:

- handlers passed to `extract(pool, { handlers })`;
- handler capture inside the extraction transaction;
- `resolveView(...)` as the single projection point for `managedBy`;
- `resolveProfile(...)` as the public composition Module;
- `ctx.proveOptions.reextract` / `ctx.applyOptions.reextract` for proof and
  fingerprint reconstruction.

This is not runtime risk, but it is likely to mislead the next implementor who
picks up Phase B extension intent.

#### Suggested fix

Update the Phase B roadmap docs to describe the profile-based substrate and mark
the old helper names as historical only if they need to be mentioned at all.

The key wording should be:

> Phase A's substrate is now the integration profile: extension handlers are run
> by `extract(pool, { handlers })` inside the extraction snapshot; `resolveView`
> projects `managedBy`; `resolveProfile` supplies the handler-aware extract,
> proof, and apply option bundles.

## What was verified as fixed

### Managed view projection

`resolveView(...)` now projects both extension-member and managed-object
provenance:

- `memberOfExtension`;
- `managedBy`.

This makes `resolveView` the single projection point instead of requiring
callers to compose `excludeManaged`.

### Snapshot-bound handlers

`extract(...)` now accepts `handlers` and runs each handler before the extraction
transaction commits. The handler Interface receives a snapshot-bound
`HandlerContext`, not a `Pool`, so handler queries see the same repeatable-read
snapshot as core extraction.

### Profile composition

`resolveProfile(...)` now returns:

- `extract`;
- `planOptions`;
- `proveOptions`;
- `applyOptions`.

The Supabase profile composes the Supabase policy and the pg_partman handler.
The public root exports the headline profile path, and the `./integrations`
subpath exports custom-profile building blocks.

### CLI profile path

`plan`, `apply`, and `prove` now accept `--profile raw|supabase`. The profile is
resolved into the extraction and option bundles used by those commands. This
addresses the previous issue where the CLI had no way to reach the managed-view
path.

### SQL-file DML check

`loadSqlFiles` now scopes its row-observation DML rejection to managed user
tables, using the extraction scope predicate and excluding extension-owned
relations. Extension-created internal rows no longer look like user DML.

## Verification performed

Working tree reviewed:

```text
/Users/jgoux/Code/supabase/pg-toolbelt
```

Commands run:

```bash
cd packages/pg-delta-next && bun run check-types
cd packages/pg-delta-next && bun run test
cd packages/pg-delta-next && bun run test tests/profile-e2e-partman.test.ts tests/load-sql-files-extension-rows.test.ts
git diff --check 1a5a0ef3a6c5a2ff48478dfddbb8285d09b0aa69..HEAD
```

Results:

- `bun run check-types` passed.
- `bun run test` passed: 310 tests, 0 failures.
- Targeted integration command passed: 313 tests, 0 failures, including:
  - `tests/profile-e2e-partman.test.ts`;
  - `tests/load-sql-files-extension-rows.test.ts`.
- `git diff --check` passed.

Not run:

- Full corpus.
- `bun run knip --fix`.
- Full Docker integration matrix.

## Notes for the implementor agent

Start with the P2 artifact/profile item. It is the only remaining review finding
that affects the operational safety Interface. It should be a small, targeted
change:

1. add profile metadata to `Plan`;
2. round-trip it through plan serialization;
3. have CLI `plan` stamp it;
4. have CLI `apply` / `prove` infer or validate it;
5. add focused unit tests.

Then update the Phase B roadmap docs so future extension-intent work builds on
the new profile Module instead of the removed helper recipe.
