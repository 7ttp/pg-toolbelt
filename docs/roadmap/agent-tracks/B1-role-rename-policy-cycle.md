# B1 — Fix role-rename + policy dependency cycle (bug)

**Priority:** Urgent (crash-class planner bug on main) · **Wave:** 1 (parallel with V1) ·
**Ship:** one PR, one agent · **Blocks:** I1 (normalization later subsumes this fix) ·
**Conflicts with:** I1, anyone on `internal.ts` ordering or `rules/policies.ts`

## Bug

An accepted role rename plus an RLS policy whose `roles` payload references the
renamed role **fails to plan**. Reproduced 2026-07-20 on `feat/pg-delta-next`
with an in-memory FactBase (source: role `role_a` + policy `roles: ["role_a"]`;
desired: renamed to `role_b`), `plan({ renames: "auto", compact: false })`:

```text
dependency cycle among 2 actions — this is a rule/emission bug, fix the rule (guardrail 4):
  ALTER ROLE "role_a" RENAME TO "role_b"
  ALTER POLICY "docs_read" ON "app"."t" TO "role_b"
```

## Mechanism (verified)

- `rules/policies.ts` `roles.alter` (~48–72) sets `consumes = [newRole]`,
  `releases = [oldRole]` — plain string-set diff, no rename awareness.
- `internal.ts`: `consumes` → produce-before-consume edge `[rename, policy]`
  (~133–147); `releases` → **unconditional** release-before-destroy edge
  `[policy, rename]` (~126–132). The rename action `produces` the new role
  subtree and `destroys` the old, so both edges target the same action → 2-cycle.
- The existing rename carve-out (`internal.ts` ~191, ~246) covers only
  `owner`-kind edges during subtree traversal — not an action's own
  `consumes`/`releases`.
- `policy` is deliberately absent from `ROLE_NAME_BEARING_KINDS` (role name is
  **payload**-carried, `extract/policies.ts:39`), so carry never sees it.

## Coverage gap

No corpus scenario or integration test combines a role rename with a policy
referencing the renamed role (`rls-operations--policy-roles-swap` is
drop+create, not rename). That is why nothing caught this.

## RED first (TDD, mandatory)

1. Corpus scenario `corpus/role-rename--policy-roles/{a,b}.sql`: role + table +
   policy `TO` that role; role renamed in `b` (structurally identical role so
   rename matching proposes it). Confirm it fails with the cycle error today.
   If the corpus harness's rename-acceptance setting cannot express this,
   fall back to a focused integration test **plus** the in-memory unit repro
   (model on `src/plan/role-rename-carry.test.ts`).
2. Capture the failure output for the fix commit message.

## Fix options (pick one, justify in PR)

1. **Preferred:** rename-aware carve-out in `internal.ts` — when a
   releases-target's destroyer is a rename action that also **produces** the
   corresponding renamed id, skip the release-before-destroy edge (mirrors the
   owner-edge carve-out).
2. Make `rules/policies.ts` `roles.alter` rename-aware (consult accepted
   renames; don't consume/release ids carried by a rename).
3. Extend carry/relabel to payload role refs — **least preferred**: it grows
   the folklore I1 exists to delete.

Option 1 is smallest and local to ordering; I1's payload normalization later
makes the whole policy delta vanish, at which point the carve-out becomes
dead-but-harmless and is removed with carry.

## Acceptance criteria

- [ ] RED repro captured, then green after fix
- [ ] Corpus (or integration) scenario committed so this class stays covered
- [ ] Full corpus green on `postgres:17-alpine`
- [ ] Changeset `fix`
- [ ] Note added to I1 that normalization subsumes this carve-out

## Done when

Role rename + dependent policy plans and proves; I1 inherits the scenario as a
pin for payload-role normalization.
