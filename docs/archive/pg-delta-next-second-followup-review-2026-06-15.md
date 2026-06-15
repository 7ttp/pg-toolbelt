# pg-delta-next second follow-up review — 2026-06-15

This is a focused handoff review of the follow-up commits on
`feat/pg-delta-next` after the previous review findings were implemented.

Reviewed HEAD:

```text
93fbd68 fix(pg-delta-next): address 2026-06-15 follow-up review (P1 + docs)
```

The branch has made strong progress. The prior P1 items are mostly addressed:
projected emission now prevents filtered child facts from leaking into create and
alter SQL, `loadSqlFiles` fails loudly on round-budget exhaustion, and the
foreign-table dependency resolver now models `relkind = 'f'`.

This pass found two remaining P1 planner correctness issues and one P2 CLI
diagnostic gap. The two P1s are both in the planner boundary where accepted
renames, ownership edges, and policy-projected targets meet.

## Summary

| Priority | Area | Finding |
|---|---|---|
| P1 | Planner / ownership | Accepted table rename + owner change can drop the old owner role before reassigning the renamed table. |
| P1 | Planner / rename graph | Accepted table rename + accepted owner-role rename can create a dependency cycle. |
| P1 | Planner / policy projection | Default-privilege hygiene still scans unprojected `desired`, so filtered default ACL changes can emit impossible `REVOKE` actions. |
| P2 | CLI proof reporting | `pg-delta-next prove` exits on rewrite-only proof failures without printing the rewrite violations. |

## P1 — accepted rename + owner change can drop the old owner too early

**Files**

- `packages/pg-delta-next/src/plan/plan.ts:647`
- `packages/pg-delta-next/src/plan/plan.ts:659`
- `packages/pg-delta-next/src/plan/plan.ts:713`

### What happens

The new ownership-preserving rename logic correctly avoids redundant owner
actions when a renamed object keeps the same owner. The changed-owner case still
misses the release edge that protects the old role from being dropped too early.

The planner builds `oldOwnerByFact` from `unlink` owner deltas:

```ts
oldOwnerByFact.set(encodeId(delta.edge.from), delta.edge.to);
```

For an accepted rename, the source-side owner unlink is keyed by the source id,
for example:

```text
table:app.old_t
```

The desired owner link is keyed by the renamed destination id:

```text
table:app.new_t
```

Later, owner action emission looks up the old role by the destination key:

```ts
const oldRoleId = oldOwnerByFact.get(objKey);
```

That returns `undefined`, so the generated `ALTER ... OWNER TO` action does not
carry `releases: [oldRole]`. Without the release edge, the old role drop can sort
before the owner reassignment.

### Reproduction

This in-memory repro does not require Docker:

```ts
import { buildFactBase } from "./packages/pg-delta-next/src/core/fact.ts";
import { plan } from "./packages/pg-delta-next/src/plan/plan.ts";

const rolePayload = (login = false) => ({
  superuser: false,
  inherit: true,
  createRole: false,
  createDb: false,
  login,
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

const role1 = { kind: "role", name: "r1" } as const;
const role2 = { kind: "role", name: "r2" } as const;
const schema = { kind: "schema", name: "app" } as const;
const oldTable = { kind: "table", schema: "app", name: "old_t" } as const;
const newTable = { kind: "table", schema: "app", name: "new_t" } as const;

const source = buildFactBase(
  [
    { id: role1, payload: rolePayload(false) },
    { id: schema, payload: {} },
    { id: oldTable, parent: schema, payload: tablePayload() },
  ],
  [{ from: oldTable, to: role1, kind: "owner" }],
);

const desired = buildFactBase(
  [
    { id: role2, payload: rolePayload(true) },
    { id: schema, payload: {} },
    { id: newTable, parent: schema, payload: tablePayload() },
  ],
  [{ from: newTable, to: role2, kind: "owner" }],
);

const p = plan(source, desired, { renames: "auto", compact: false });
console.log(p.actions.map((a, i) => `${i}: ${a.sql}`).join("\n"));
```

Observed action order:

```text
0: CREATE ROLE "r2" WITH NOSUPERUSER INHERIT NOCREATEROLE NOCREATEDB LOGIN NOREPLICATION NOBYPASSRLS
1: ALTER TABLE "app"."old_t" RENAME TO "new_t"
2: DROP OWNED BY "r1"; DROP ROLE "r1"
3: ALTER TABLE "app"."new_t" OWNER TO "r2"
```

This should fail when applied to PostgreSQL: after the rename, `app.new_t` is
still owned by `r1`, so `DROP ROLE "r1"` cannot run before
`ALTER TABLE "app"."new_t" OWNER TO "r2"`.

### Suggested fix

Accepted renames need a source-id to destination-id owner transfer map that
carries the old owner `StableId`, not only the old owner name.

One concrete shape:

1. While processing `acceptedRenames`, zip source and destination subtree ids as
   today.
2. For each zipped pair, find the source owner edge.
3. Store both:
   - destination key -> old owner name, for the unchanged-owner skip;
   - destination key -> old owner `StableId`, for release ordering.
4. In the owner `link` loop, if the new owner differs from the carried old owner,
   include `releases: [oldOwnerId]` on the `ALTER ... OWNER TO` action.

The regression should cover:

- source: `r1` owns `app.old_t`;
- desired: `app.new_t` is accepted as a rename and owned by `r2`;
- `r1` is removed;
- plan order places `ALTER TABLE app.new_t OWNER TO r2` before `DROP ROLE r1`;
- the plan applies successfully against a real database.

## P1 — accepted table rename + accepted owner-role rename can create a planner cycle

**Files**

- `packages/pg-delta-next/src/plan/plan.ts:479`
- `packages/pg-delta-next/src/plan/internal.ts:94`
- `packages/pg-delta-next/src/plan/graph.ts:98`

### What happens

If both the table and its owner role are structurally accepted as renames, the
planner can form a cycle between:

- the role rename;
- the table rename;
- the owner action on the renamed table.

Repro output:

```text
dependency cycle among 3 actions — this is a rule/emission bug, fix the rule (guardrail 4):
  ALTER ROLE "r1" RENAME TO "r2"
  ALTER TABLE "app"."old_t" RENAME TO "new_t"
  ALTER TABLE "app"."new_t" OWNER TO "r2"
```

The cycle is understandable from the current graph model:

- the table rename action claims to produce the destination table subtree;
- `buildActionGraph` walks desired outgoing edges for produced ids and sees the
  destination owner edge to `role:r2`, so it wants the role rename before the
  table rename;
- source ownership still means the old role is tied to the old table until the
  table ownership transition is resolved.

In other words, the table rename is being treated as if it produces the final
desired owner edge, but PostgreSQL rename semantics preserve the old owner.

### Reproduction

Same fixture shape as the previous finding, but make `role:r1` and `role:r2`
structurally identical so the role rename is accepted too:

```ts
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

const p = plan(source, desired, { renames: "auto", compact: false });
```

The planner throws the dependency cycle shown above.

### Suggested fix

This is likely the same conceptual fix as the first P1: accepted object renames
should model ownership as carried from the source object, not as immediately
converged to the desired owner edge.

Possible implementation directions:

- When an accepted rename produces the destination subtree, do not let desired
  owner edges on that produced subtree force dependencies as if the rename
  creates those edges.
- Treat the owner transition as a separate owner action that consumes the renamed
  object and new role, and releases the old role.
- Add a regression that combines table rename, owner-role rename, and final
  ownership convergence.

The important invariant is that `ALTER ... RENAME` changes identity, not owner.
The action graph should preserve that distinction.

## P1 — default-privilege hygiene still scans unprojected `desired`

**Files**

- `packages/pg-delta-next/src/plan/plan.ts:515`
- `packages/pg-delta-next/src/plan/plan.ts:530`
- `packages/pg-delta-next/src/plan/project.ts:29`

### What happens

The previous projected-target fix moved create, recreate, and in-place alter
emission to `projectedDesired`. That fixed the delta-set inlining leak for
filtered child facts.

The default-privilege hygiene block still uses unprojected state:

```ts
for (const fact of added.values()) {
  ...
  const ownerEdge = desired.outgoingEdges(fact.id).find((e) => e.kind === "owner");
  ...
  for (const dp of desired.facts()) {
    if (dp.id.kind !== "defaultPrivilege") continue;
    ...
  }
}
```

That means a policy can filter out a `defaultPrivilege` add and its grantee role,
but the hygiene loop still sees the unprojected default ACL and emits:

```sql
REVOKE ALL ON TABLE "app"."t" FROM "g"
```

The action then fails the planner's own missing-requirement check because `role:g`
was correctly filtered away.

### Reproduction

This in-memory repro does not require Docker:

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

const roleOwner = { kind: "role", name: "owner" } as const;
const roleG = { kind: "role", name: "g" } as const;
const schema = { kind: "schema", name: "app" } as const;
const table = { kind: "table", schema: "app", name: "t" } as const;
const dp = {
  kind: "defaultPrivilege",
  role: "owner",
  schema: "app",
  objtype: "r",
  grantee: "g",
} as const;

const source = buildFactBase(
  [
    { id: roleOwner, payload: rolePayload() },
    { id: schema, payload: {} },
  ],
  [],
);

const desired = buildFactBase(
  [
    { id: roleOwner, payload: rolePayload() },
    { id: roleG, payload: rolePayload() },
    { id: schema, payload: {} },
    { id: table, parent: schema, payload: tablePayload() },
    { id: dp, payload: { privileges: ["SELECT"], grantable: [] } },
  ],
  [{ from: table, to: roleOwner, kind: "owner" }],
);

const policy = {
  id: "drop-role-and-defacl",
  filter: [
    {
      match: { all: [{ kind: "role" }, { name: "g" }, { verb: "add" }] },
      action: "exclude",
    },
    {
      match: { all: [{ kind: "defaultPrivilege" }, { verb: "add" }] },
      action: "exclude",
    },
  ],
};

plan(source, desired, { policy, compact: false });
```

Observed error:

```text
missing requirement: action "REVOKE ALL ON TABLE "app"."t" FROM "g"" consumes role:g, which neither exists on the target nor is produced by this plan — a filter may be hiding its creation
```

### Suggested fix

Route default-privilege hygiene through the projected target:

- iterate created facts from the kept deltas, but resolve the current fact from
  `projectedDesired` before rendering;
- read owner edges from `projectedDesired`;
- iterate `projectedDesired.facts()` for `defaultPrivilege` facts;
- optionally skip hygiene for a created object whose fact is absent from
  `projectedDesired`.

The rule is the same as the child-inlining fix: emission should render only the
state the plan is actually targeting.

Suggested regression:

- source has `role owner` and `schema app`;
- desired adds `role g`, table `app.t`, and default privileges from `owner` to
  `g`;
- policy filters `add:role:g` and `add:defaultPrivilege`;
- planner should still produce a valid table-create plan and not emit any
  statement mentioning `"g"`.

## P2 — `pg-delta-next prove` hides rewrite-only proof failures

**Files**

- `packages/pg-delta-next/src/cli/commands/prove.ts:59`
- `packages/pg-delta-next/src/proof/prove.ts:45`
- `packages/pg-delta-next/tests/engine.test.ts:94`

### What happens

`ProofVerdict` includes structured rewrite violations:

```ts
rewriteViolations: Array<{ table: TableRef }>;
```

The corpus runner prints these violations:

```ts
const rewrites = verdict.rewriteViolations
  .map((v) =>
    `  ${rel(v.table.schema, v.table.name)}: relfilenode changed, no rewriteRisk declared`,
  )
  .join("\n");
```

The user-facing `pg-delta-next prove` command does not. It reports apply errors,
drift, and data violations, then exits:

```ts
if (verdict.dataViolations.length > 0) {
  ...
}
process.exit(1);
```

So a rewrite-only proof failure can print only:

```text
Proof FAILED.
```

with no actionable table name.

### Suggested fix

Add a rewrite-violations block to `cmdProve`, mirroring the corpus runner:

```ts
if (verdict.rewriteViolations.length > 0) {
  process.stderr.write(
    `  rewrite violations (${verdict.rewriteViolations.length}):\n`,
  );
  for (const v of verdict.rewriteViolations) {
    process.stderr.write(
      `    ${rel(v.table.schema, v.table.name)}: relfilenode changed, no rewriteRisk declared\n`,
    );
  }
}
```

This is not an engine correctness problem, but it matters for handoff and field
debugging because proof failures should be self-explanatory.

## Positive notes from this round

The implemented fixes from the previous review are directionally right:

- `emitCreate`, replace-recreate, and in-place alters now render against
  `projectedDesired`, which is the correct Module Interface for action emission.
- `buildActionGraph` intentionally remains on unprojected `desired` so missing
  dependencies still fail loudly rather than disappearing when `FactBase`
  construction prunes dangling edges.
- `loadSqlFiles` now maintains the all-or-error contract when `maxRounds` is
  exhausted.
- `extract/dependencies.ts` now includes foreign tables as relation endpoints,
  and the oracle test documents the PG14/PG15 publication-column difference.
- The documentation is much clearer for newcomers. The new onboarding map gives
  a good high-level path through extraction, facts, diff, planning, apply, and
  proof. The roadmap now explains the two-view planner distinction directly.

## Review commands run

Focused unit tests:

```text
cd packages/pg-delta-next && bun test src/plan/filtered-child-inlining.test.ts src/proof/prove.test.ts
```

Result:

```text
7 pass
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

No Docker corpus or integration suite was run during this review round.

## Suggested implementation order

1. Fix ownership modeling for accepted renames first. That should address both
   the early old-role drop and the role/table rename cycle if the rename action
   stops pretending it creates the final desired owner edge.
2. Add the accepted-rename ownership regressions before changing planner code:
   one for owner change + old role drop, one for table rename + owner role rename.
3. Move default-privilege hygiene onto `projectedDesired` and add a policy
   regression that filters both the grantee role and default ACL.
4. Add the CLI rewrite-violation output and a small command-level test if the CLI
   harness can inject a verdict or run a cheap fixture.

