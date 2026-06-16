# pg-delta-next fourth follow-up review

Date: 2026-06-16  
Branch reviewed: `feat/pg-delta-next`  
HEAD reviewed: `3a77788f2fbf4ad4ab8b3546dfda6f986732c3dc`

## Scope

This pass reviewed the changes implemented after the third follow-up review, centered on:

- `packages/pg-delta-next/src/plan/role-rename-carry.ts`
- `packages/pg-delta-next/src/plan/plan.ts`
- `packages/pg-delta-next/src/plan/role-rename-carry.test.ts`
- `packages/pg-delta-next/src/plan/rename-ownership.test.ts`
- `packages/pg-delta-next/tests/owner-edge.test.ts`
- `packages/pg-delta-next/tests/containers.ts`

The implemented fix is directionally strong. I do not see a new P0/P1 correctness blocker in the newly added role-rename carry path. The previous role-only owner and default-privilege regressions are covered, the focused unit tests pass, and the live owner-edge integration file proves clean against PostgreSQL.

The main thing that still stands out is an optimization/depth opportunity: role-name-bearing facts are now carried only when their payloads are identical. If the role rename and the fact payload change happen together, the planner still emits old-name teardown plus post-rename setup. That converges, but it is not the technically optimal representation of PostgreSQL's OID semantics.

## Findings

### P2: Payload-changing role-name-bearing facts still churn around a role rename

References:

- `packages/pg-delta-next/src/plan/role-rename-carry.ts:121`
- `packages/pg-delta-next/src/plan/role-rename-carry.ts:147`
- `packages/pg-delta-next/src/plan/role-rename-carry.ts:151`
- `packages/pg-delta-next/src/plan/plan.ts:274`
- `packages/pg-delta-next/src/plan/plan.ts:279`

The new carry Module deliberately treats a role-name-bearing fact as carried only when the remove-side payload and add-side payload are exactly equal:

```ts
if (
  add !== undefined &&
  canonicalize(add.payload) === canonicalize(d.fact.payload)
) {
  carriedFactKeys.add(sourceKey);
  carriedFactKeys.add(relabeledKey);
}
```

The comment above it says that a pair whose payload also changed is not carried and "the churn is left intact." That is safe for convergence in the examples I checked, but it is not the technically optimal plan.

PostgreSQL carries the object identity through `ALTER ROLE old RENAME TO new` by OID even when a role-referencing fact's payload also needs to change. The better mental model is:

1. rename carries the identity from the old role name to the new role name;
2. then apply the payload mutation against the post-rename identity.

The current planner instead models this as:

1. tear down the old-name fact;
2. rename the role;
3. create or replace the new-name fact.

Manual characterization examples from this review:

```text
--- membership payload changed under role rename ---
0: REVOKE "grp" FROM "r1" CASCADE
1: ALTER ROLE "r1" RENAME TO "r2"
2: GRANT "grp" TO "r2" WITH ADMIN OPTION

--- acl payload changed under grantee role rename ---
0: REVOKE ALL ON TABLE "app"."t" FROM "r1"
1: ALTER ROLE "r1" RENAME TO "r2"
2: REVOKE ALL ON TABLE "app"."t" FROM "r2"
3: GRANT SELECT, INSERT ON TABLE "app"."t" TO "r2"

--- user mapping payload changed under role rename ---
0: DROP USER MAPPING FOR "r1" SERVER "srv"
1: ALTER ROLE "r1" RENAME TO "r2"
2: CREATE USER MAPPING FOR "r2" SERVER "srv" OPTIONS ("a" 'c')
```

The optimal shape is closer to:

```text
ALTER ROLE "r1" RENAME TO "r2";
-- then mutate the existing post-rename role-bearing fact
```

Concrete opportunities:

- `membership.admin`: use the existing `admin` alter rule on the relabeled id. For false -> true, emit `GRANT grp TO r2 WITH ADMIN OPTION`; for true -> false, emit `REVOKE ADMIN OPTION FOR grp FROM r2`.
- `userMapping.options`: carry the mapping identity and emit `ALTER USER MAPPING FOR r2 SERVER srv OPTIONS (...)`.
- `comment.text` and `securityLabel.label`: carry the target identity and emit the existing alter form on the post-rename target.
- `acl.privileges` / `acl.grantable`: avoid the pre-rename old-name revoke. If replacement is still the selected rule shape, run the target-side replacement only after the role rename.
- `defaultPrivilege.privileges` / `defaultPrivilege.grantable`: same idea as ACLs: replace against the post-rename role id, not both old and new names.

I would extend `computeRoleRenameCarry` into a slightly deeper planning Interface:

- exact payload match -> current `carriedFactKeys`;
- relabeled id match with payload difference -> a `changedRoleRenameFacts` pair `{ from, to }`;
- the planner consumes that pair by removing the old-name `remove` delta and scheduling a target-id payload mutation after the role rename.

That keeps the good part of this change, namely one role-rename carry Seam, while giving it enough Depth to model identity carry and payload mutation separately.

Why this matters:

- fewer DDL statements;
- lower lock and privilege footprint;
- less transient privilege churn;
- avoids `REVOKE ... CASCADE` in membership cases where only the admin option changed;
- better matches PostgreSQL's OID-level behavior.

Suggested regression tests:

- role rename plus `membership.admin` false -> true emits no full `REVOKE role FROM member CASCADE`;
- role rename plus `userMapping.options` change emits `ALTER USER MAPPING`, not drop/create;
- role rename plus ACL privilege change emits no pre-rename `REVOKE ... FROM old_role`;
- at least one live proof for a payload-changing role-bearing fact, preferably user mapping or membership.

### P3: Live integration coverage is still thinner than the carry Module's ownership

References:

- `packages/pg-delta-next/src/plan/role-rename-carry.test.ts:25`
- `packages/pg-delta-next/src/plan/role-rename-carry.test.ts:38`
- `packages/pg-delta-next/src/plan/role-rename-carry.test.ts:64`
- `packages/pg-delta-next/tests/owner-edge.test.ts:450`
- `packages/pg-delta-next/tests/owner-edge.test.ts:499`

The pure tests cover relabeling for `acl`, `membership`, `defaultPrivilege`, `userMapping`, and nested `comment`. The integration tests now prove:

- role-only rename carries ownership of a stable object;
- role rename carries default privileges.

That is a good improvement, and the live `owner-edge.test.ts` file passed locally. The remaining gap is that the carry Module now owns more catalog families than the live proof exercises.

I would add one compact integration test that creates a source/destination pair with an accepted role rename and at least:

- table ACL granted to the renamed role;
- role membership involving the renamed role;
- user mapping for the renamed role, if `postgres_fdw` is available in the test image.

The assertion should be the same shape as the default-privilege test:

- `ALTER ROLE ... RENAME TO ...` is emitted;
- no `GRANT`/`REVOKE`/`DROP USER MAPPING`/`CREATE USER MAPPING` churn for identical facts;
- `provePlan` returns `ok: true` with zero drift.

I manually characterized the pure planner path for identical ACL and user mapping facts and it emits only the role rename:

```text
ACL identical [ "ALTER ROLE \"r1\" RENAME TO \"r2\"" ]
userMapping identical [ "ALTER ROLE \"r1\" RENAME TO \"r2\"" ]
```

So this is not a known correctness bug. It is a coverage hardening recommendation because the extractor/proof path is the real Interface that users depend on.

### P3: Future role-name-bearing stable ids can be missed silently

Reference:

- `packages/pg-delta-next/src/plan/role-rename-carry.ts:52`
- `packages/pg-delta-next/src/plan/role-rename-carry.ts:90`

`relabelRoleNames` currently uses a switch with a default that returns the id unchanged:

```ts
default:
  return id;
```

That is fine for today's `StableId` union, and the handled cases cover the role-name-bearing ids I see today:

- `role`
- `membership`
- `userMapping`
- `defaultPrivilege`
- `acl.grantee`
- recursive `acl/comment/securityLabel.target`

The maintenance risk is that a future stable id could embed a role name and still compile while returning unchanged through the default branch. Since role-name carry is now a correctness-sensitive planner Module, I would add a small guard.

Possible approaches:

- define a `ROLE_NAME_BEARING_KINDS` registry next to `relabelRoleNames`, and add a test that documents every handled role-bearing kind;
- add a stable-id inventory test that fails when a new `StableId.kind` appears and requires explicitly marking it as role-bearing or not;
- split the default through a helper such as `assertNoRoleNameFields(id)` so the non-role-bearing cases are documented deliberately.

This is not urgent, but it would keep this nice single Seam from becoming stale as the model grows.

## Verification Performed

Focused unit tests:

```bash
cd packages/pg-delta-next
bun test src/plan/role-rename-carry.test.ts src/plan/rename-ownership.test.ts
```

Result: 19 pass, 0 fail.

Typecheck:

```bash
cd packages/pg-delta-next
bun run check-types
```

Result: passed.

Focused live integration proof:

```bash
cd packages/pg-delta-next
PGDELTA_TEST_IMAGE=postgres:17-alpine bun test tests/owner-edge.test.ts
```

Result: 8 pass, 0 fail.

Manual planner characterization:

- identical ACL under role rename emits only `ALTER ROLE ... RENAME TO ...`;
- identical user mapping under role rename emits only `ALTER ROLE ... RENAME TO ...`;
- payload-changing membership, ACL, and user mapping under role rename still emit teardown/setup churn as shown in the P2 finding.

## Bottom Line

The implemented fix addresses the prior owner/default-privilege role-rename regressions well. I would not block on a P1/P0 from this pass.

The best next improvement is to deepen the role-rename carry Module so it handles "same role-bearing identity, changed payload" as identity carry plus post-rename mutation, rather than falling back to old-name teardown and new-name create. That would move the planner closer to the technically optimal PostgreSQL plan shape.
