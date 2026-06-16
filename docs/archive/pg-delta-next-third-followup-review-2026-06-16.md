# pg-delta-next third follow-up review - 2026-06-16

Focused handoff review of the changes that implemented the second follow-up
review findings on `feat/pg-delta-next`.

Reviewed HEAD:

```text
648f027 fix(pg-delta-next): address 2026-06-15 second follow-up review (P1 ownership + P2 prove output)
```

This pass verified the previous P1/P2 fixes and then looked for adjacent
correctness gaps in the same planner seam: accepted renames, owner edges,
role-name-bearing facts, and policy-projected emission.

The previous findings are materially improved:

- accepted table rename + owner change now emits an owner reassignment that
  releases the old owner before `DROP ROLE`;
- accepted table rename + accepted owner-role rename no longer cycles;
- default-privilege hygiene now reads `projectedDesired`;
- the `prove` CLI now reports rewrite-only failures through a pure
  `formatProofFailure` module.

One new P1 remains: accepted role renames are only treated as carrying ownership
when the owned object is also renamed. A role-only rename with a stable owned
object still cycles or falsely fails the capability check.

## Summary

| Priority | Area | Finding |
|---|---|---|
| P1 | Planner / role rename ownership | Role-only rename still emits `ALTER ... OWNER TO` for objects whose stable id did not change, causing a dependency cycle or false capability failure. |
| P2 | Planner / role-name references | Accepted role renames still churn role-name-bearing facts such as ACLs, memberships, and default privileges, even though PostgreSQL carries them by role OID. |
| P3 | Test locality / docs | `isolatedClusterPair()` comments promise role cleanup between scenarios, but cleanup is not automatic. |

## P1 - role-only rename still breaks owned objects that keep the same id

**Files**

- `packages/pg-delta-next/src/plan/plan.ts:670`
- `packages/pg-delta-next/src/plan/plan.ts:735`
- `packages/pg-delta-next/src/plan/internal.ts:70`

### What happens

The new fix builds a `roleRenameMap`:

```ts
const roleRenameMap = new Map<string, string>();
for (const { from, to } of acceptedRenames) {
  if (from.id.kind === "role" && to.id.kind === "role") {
    roleRenameMap.set(
      (from.id as { name: string }).name,
      (to.id as { name: string }).name,
    );
  }
}
```

That map is then applied only while constructing `renamedOwner`, which is keyed
by destination ids from accepted object renames:

```ts
for (const { from, to } of acceptedRenames) {
  const srcIds = subtreeIds(source, from.id);
  const dstIds = subtreeIds(desired, to.id);
  ...
  renamedOwner.set(
    encodeId(dstId),
    roleRenameMap.get(srcOwnerName) ?? srcOwnerName,
  );
}
```

So the "owner is carried by the role rename" case works only when the owned
object is also renamed. If the role is renamed but the table remains `app.t`,
there is still an owner-edge unlink/link on the same object:

```text
unlink table:app.t -> role:r1
link   table:app.t -> role:r2
```

The owner-link loop does not recognize that `role:r1 -> role:r2` is an accepted
role rename. It emits:

```sql
ALTER TABLE "app"."t" OWNER TO "r2"
```

That action consumes `role:r2` and releases `role:r1`. The graph then requires:

- `ALTER ROLE "r1" RENAME TO "r2"` before `ALTER TABLE ... OWNER TO "r2"`
  because the owner action consumes the produced role;
- `ALTER TABLE ... OWNER TO "r2"` before `ALTER ROLE "r1" RENAME TO "r2"`
  because the owner action releases the destroyed old role.

The result is a dependency cycle.

### Reproduction

No Docker required:

```ts
import { buildFactBase } from "./packages/pg-delta-next/src/core/fact.ts";
import { plan } from "./packages/pg-delta-next/src/plan/plan.ts";

const rolePayload = () => ({
  superuser: false,
  inherit: true,
  createRole: false,
  createDb: false,
  login: false,
  replication: false,
  bypassRls: false,
  config: [],
});

const tablePayload = () => ({
  persistence: "p",
  rowSecurity: false,
  forceRowSecurity: false,
  replicaIdentity: "d",
  replicaIdentityIndex: null,
  partitionKey: null,
  partitionBound: null,
  parentTable: null,
});

const r1 = { kind: "role", name: "r1" } as const;
const r2 = { kind: "role", name: "r2" } as const;
const schema = { kind: "schema", name: "app" } as const;
const table = { kind: "table", schema: "app", name: "t" } as const;

const source = buildFactBase(
  [
    { id: r1, payload: rolePayload() },
    { id: schema, payload: {} },
    { id: table, parent: schema, payload: tablePayload() },
  ],
  [{ from: table, to: r1, kind: "owner" }],
);

const desired = buildFactBase(
  [
    { id: r2, payload: rolePayload() },
    { id: schema, payload: {} },
    { id: table, parent: schema, payload: tablePayload() },
  ],
  [{ from: table, to: r2, kind: "owner" }],
);

plan(source, desired, { renames: "auto", compact: false });
```

Observed error:

```text
dependency cycle among 2 actions - this is a rule/emission bug, fix the rule (guardrail 4):
  ALTER ROLE "r1" RENAME TO "r2"
  ALTER TABLE "app"."t" OWNER TO "r2"
```

With an applier capability that is not allowed to set owner `r2`, the same case
fails before graph construction:

```text
capability: cannot set owner of table:app.t to role "r2" - applier "applier" is not a superuser or a member of that role; grant membership or apply as a member/superuser
```

That capability failure is false: PostgreSQL carries the table owner through
`ALTER ROLE "r1" RENAME TO "r2"` by role OID. No `ALTER TABLE ... OWNER TO`
is needed.

### Suggested fix

Teach the owner-link loop that a role rename carries ownership even when the
owned object id did not change.

Concretely, before the capability check and before emitting `ALTER ... OWNER TO`:

1. Look up the old owner for the object:

   ```ts
   const oldRoleId =
     oldOwnerByFact.get(objKey) ?? renamedOwnerId.get(objKey);
   ```

2. If `oldRoleId` is a role and `roleRenameMap.get(oldOwnerName) === roleName`,
   skip the owner action. The ownership is already correct after the role rename.

Pseudo-shape:

```ts
const oldRoleId =
  oldOwnerByFact.get(objKey) ?? renamedOwnerId.get(objKey);

if (
  oldRoleId?.kind === "role" &&
  roleRenameMap.get((oldRoleId as { name: string }).name) === roleName
) {
  continue;
}
```

This should happen before the capability check, because there is no owner action
to authorize.

### Suggested regressions

Add both unit and integration coverage:

1. Unit:
   - source has `role:r1`, `schema:app`, `table:app.t`, owner edge
     `table:app.t -> role:r1`;
   - desired has structurally identical `role:r2`, same table id, owner edge
     `table:app.t -> role:r2`;
   - `plan(..., { renames: "auto" })` should not throw;
   - plan should contain `ALTER ROLE "r1" RENAME TO "r2"`;
   - plan should not contain `OWNER TO "r2"`.

2. Capability unit:
   - same setup, with `capability` that cannot set owner `r2`;
   - plan should still not throw, because no `ALTER ... OWNER TO` is required.

3. Integration:
   - use the same direct-sacrificial-source proof style used by the new
     `owner-edge.test.ts` role-drop tests;
   - do not use a clone for plans that drop or rename roles, because roles are
     cluster-global and a clone can leave the original source database pinning
     the old role.

## P2 - role-name-bearing facts still churn across accepted role renames

**Files**

- `packages/pg-delta-next/src/plan/rules/roles.ts:112`
- `packages/pg-delta-next/src/plan/rules/metadata.ts:68`
- `packages/pg-delta-next/src/plan/rules/helpers.ts:246`
- `packages/pg-delta-next/src/plan/rules/helpers.ts:319`

### What happens

The remaining P1 above is one instance of a broader planner modeling issue:
PostgreSQL role renames preserve role OIDs, but several modeled facts carry role
names in their stable identifiers:

- owner edges;
- ACL grantee ids;
- membership ids;
- default-privilege `role` and `grantee` ids.

When a role rename is accepted, many of these facts can be carried by the role
rename rather than removed and recreated.

Today they churn. For example:

```ts
const dp1 = {
  kind: "defaultPrivilege",
  role: "r1",
  schema: "app",
  objtype: "r",
  grantee: "PUBLIC",
} as const;

const dp2 = {
  kind: "defaultPrivilege",
  role: "r2",
  schema: "app",
  objtype: "r",
  grantee: "PUBLIC",
} as const;
```

With `role:r1 -> role:r2` accepted as a rename and identical default privileges,
the planner emits:

```text
0: ALTER DEFAULT PRIVILEGES FOR ROLE "r1" IN SCHEMA "app" REVOKE ALL ON TABLES FROM PUBLIC
1: ALTER ROLE "r1" RENAME TO "r2"
2: ALTER DEFAULT PRIVILEGES FOR ROLE "r2" IN SCHEMA "app" GRANT SELECT ON TABLES TO PUBLIC
```

The final state can still converge, so this is lower priority than the P1
cycle. But it is not technically optimal:

- it does unnecessary DDL;
- it may require privileges that a pure role rename would not require;
- it spreads "role rename carries this by OID" knowledge across ad hoc planner
  branches instead of one deep Module.

### Suggested direction

Introduce a single planner Module, or at least a local helper, that answers:

```text
Does this delta represent a role-name-bearing fact that PostgreSQL carries
through an accepted role rename?
```

That Module's Interface should probably be data-shaped:

- input: accepted role rename map plus a delta/fact/edge id;
- output: carry / do not carry, and the corresponding source/destination ids.

Then the planner can cancel or skip carried role-name-bearing deltas in one
place, improving locality. Owner-edge carry would be one adapter/use case; ACL,
membership, and default privileges could be added incrementally.

This is a Depth opportunity: the caller should not need to know every role-name
field across the stable-id union. That knowledge belongs behind one seam.

## P3 - isolated cluster pair comments overstate role cleanup

**File**

- `packages/pg-delta-next/tests/containers.ts:3`

### What happens

The test-container header says:

```text
one shared PostgreSQL cluster ... plus a lazily started PAIR of clusters for
scenarios whose point is cluster-level state (roles/memberships/default
privileges) - those run state A and state B on different clusters, with role
cleanup between scenarios.
```

But `isolatedClusterPair()` is a singleton pair:

```ts
let isolatedPair: Promise<[Cluster, Cluster]> | null = null;
export async function isolatedClusterPair(): Promise<[Cluster, Cluster]> {
  isolatedPair ??= Promise.all([startCluster(), startCluster()]);
  return isolatedPair;
}
```

The helper exposes `dropRolesExcept`, but it is not called automatically. The
new owner-edge integration tests use distinctive role names/configs, so this is
not an immediate flake in the implementation I reviewed. Still, future tests may
read that comment and assume automatic cluster-role cleanup exists.

### Suggested fix

Either:

- update the comment to say role cleanup is the caller's responsibility; or
- add a role-cleanup wrapper for cluster-level tests and make those tests use it.

For test locality, the second option is better if more role-heavy tests are
coming. The test's Interface should not require every caller to remember the
cluster-global role lifecycle.

## Note on clone-based role regressions

The other agent's warning is correct:

> A clone-based regression for owner role drops can falsely fail because roles
> are cluster-global, and the original source database can keep the old role
> pinned after cloning.

For plans that drop or rename roles, applying/proving directly against a
sacrificial source database is the right pattern. The new `owner-edge.test.ts`
comments document this well, and the integration tests follow the same style as
`renames.test.ts`.

## What looked good

- The owner-change-under-table-rename fix now gives the owner action
  `releases: [oldRole]`, which orders it before old-role drop.
- The table rename + owner-role rename fix is covered by both a no-Docker unit
  test and a Docker integration test.
- Default-privilege hygiene now uses `projectedDesired`, matching the emission
  seam used by create/recreate/in-place alter rendering.
- `formatProofFailure` is a good small Module. It gives the CLI formatting logic
  a testable Interface without needing a database.
- The new integration tests correctly avoid clone-based role-drop false
  failures.

## Validation commands run

Focused unit tests:

```text
cd packages/pg-delta-next &&
  bun test \
    src/plan/rename-ownership.test.ts \
    src/plan/filtered-child-inlining.test.ts \
    src/cli/commands/prove.test.ts \
    src/proof/prove.test.ts
```

Result:

```text
12 pass
0 fail
```

Type check:

```text
cd packages/pg-delta-next && bun run check-types
```

Result:

```text
tsc --noEmit
```

Targeted Docker integration:

```text
cd packages/pg-delta-next &&
  PGDELTA_TEST_IMAGE=postgres:17-alpine bun test tests/owner-edge.test.ts
```

Result:

```text
6 pass
0 fail
```

I did not run the full corpus in this review round.

## Suggested implementation order

1. Fix the role-only rename ownership carry first. This is the remaining P1 and
   should be a small extension of the current `roleRenameMap` logic.
2. Add the unit, capability, and direct-source integration regressions for that
   case.
3. Decide whether to generalize role-rename carry for ACLs, memberships, and
   default privileges now or track it as a follow-up. It is not as urgent as the
   P1 cycle, but it is the technically cleaner direction.
4. Clean up the `isolatedClusterPair()` comment or add a role-cleanup test
   wrapper before more role-heavy tests accumulate.

