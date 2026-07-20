# I1 — Pre-diff rename identity normalization

**Priority:** Highest strategic · **Wave:** 2 · **Ship:** one PR · **Depends on:** V1 merged · **Conflicts with:** C1, H1, anyone on carry/emitter

## Goal

Treat accepted renames (especially **role renames**) as a **rewriting of both
fact bases into a canonical StableId space**, then run ordinary diff/plan with
**zero cancel/carry folklore**. Shrink or delete `role-rename-carry` as a
planner feature.

## Why this track exists

Stable ids embed role **names** (`acl.grantee`, `membership`, `userMapping`,
`defaultPrivilege`, owner edges). Postgres carries refs by OID, so
`ALTER ROLE … RENAME` produces remove/add churn that
`plan/role-rename-carry.ts` (225 LOC) cancels after the fact. Column ACL was
already a regression in that seam (`relabel` dropping fields). Carry will keep
growing with every new role-bearing field.

Target end state:

> Structural matching **proposes** renames; identity normalization **applies**
> them to both sides; diff sees continuity; carry modules become a bug.

## Out of scope

- Compaction policy (C1/C2)
- Action budgets (P1)
- sql-format / frontends packaging (K1)
- Changing which renames are *accepted* (keep `plan/renames.ts` matching policy
  unless required for correctness)

## Owned files (write)

| Area | Paths |
|---|---|
| New normalizer | Prefer `plan/identity-normalize.ts` (or `core/` if pure + reusable) |
| Rename emission | Same module or `plan/phases/change-set.ts` — see **Design decisions** |
| Integration point | After managed view reconstruction, **before** `diff()` — `plan/phases/change-set.ts` |
| Shrink/remove | `plan/role-rename-carry.ts`, call sites in `change-set.ts` / `plan/phases/action-emitter.ts` |
| Proof simplify | `proof/prove.ts` rename-aware table mapping — should get simpler once ids align |
| Tests | normalize unit tests; `tests/role-rename-column-grant-carry.test.ts`; `tests/renames.test.ts`; corpus rename scenarios |

## Read-only references

- `plan/role-rename-carry.ts` (current Depth Module — inventory of kinds)
- `core/stable-id.ts` — codec, column-qualified ACL ids
- `plan/renames.ts` — accepted rename proposal
- `docs/architecture/target-architecture.md`
- V1 helper: call `reconstructManagedView` then normalize — do not open-code view
- Live backlog cross-refs: [#332](https://github.com/supabase/pg-toolbelt/issues/332),
  [#333](https://github.com/supabase/pg-toolbelt/issues/333) — pin rename scenarios
  that match real fidelity gaps when available

## Design decisions (do not rediscover mid-PR)

These are load-bearing. Challenge them in the PR description if wrong; do not
leave them implicit.

### 1. Canonical direction = **desired (new) names**

Rewrite **both** fact bases so every role-name-bearing StableId uses the
**post-rename** name (the desired / `to` side of each accepted role rename).

Rationale: rename actions must sort **before** dependent DDL so subsequent
statements render against post-rename names. Canonicalizing to old names would
force the rest of the plan to speak pre-rename identifiers.

### 2. Rename actions are injected outside generic diff

After normalization, diff sees **continuity** for carried refs — it will **not**
emit `ALTER … RENAME`. That is correct for ACL/membership/owner churn; it is
incorrect for the rename itself.

Therefore the planner must **inject one rename action per accepted rename**
from the rename proposal map, independent of diff. This is an intentional,
narrow “second planner” seam — far smaller than carry cancellation — and it
must live in **one** place (normalize module or change-set), documented as:

```text
acceptedRenames → inject rename Actions
                → rewrite both FBs to desired names
                → diff(normalizedSource, normalizedDesired)
                → emit remaining actions (no carry canceler)
```

Do **not** reintroduce post-diff remove/add cancellation to “find” renames.

### 3. What the rewrite must touch

Symmetric rewrite on source and desired for every kind in
`ROLE_NAME_BEARING_KINDS`, plus:

- **Dependency / owner edges** whose endpoints embed role names
- Any hash-adjacent structures derived from those ids (recompute rollups after
  rewrite; do not leave stale Merkle nodes)
- Column-qualified ACL keys (`acl:(…).grantee.column`) — full codec round-trip

Prefer **copy-on-write** fact bases; do not mutate extract outputs shared with
other commands unless proven safe.

### 4. Owner edges + dual renames

Today’s emitter zip/projection must either fall out of normalization or be
re-proven with an explicit regression test. Dual object+role renames are in
scope for that pin.

### 5. Carry retirement

Default goal: **delete** `role-rename-carry` cancel logic. If a residual remains,
document the exact kinds and why; do not keep the full Depth Module “just in
case.”

## Design requirements (checklist)

1. Pipeline order as in decision §2.
2. Guard against new role-name-bearing kinds moves with the normalizer (same
   spirit as today’s `ROLE_NAME_BEARING_KINDS` ↔ `ALL_FACT_KINDS` partition test).
3. Column-qualified ACL + role rename integration test stays green **without**
   hand-maintained field spreads in a carry relabeler.

## RED → GREEN

**Mandate this RED (behavior, not implementation absence):**

1. Unit test: after normalization, `diff(source′, desired′)` has **no**
   remove/add (or unlink/link) pairs that are pure role-name relabels for
   ACL / membership / owner / defaultPrivilege / userMapping.
2. Plan-level test: accepted role rename + column ACL → plan contains the
   rename action(s) and does **not** contain REVOKE/GRANT churn for the rename.
3. Do **not** use “assert carry module is unimported” as the primary pin.

**GREEN:** Implement normalizer + rename injection; remove carry; re-run:

```bash
cd packages/pg-delta
bun test src/plan/identity-*.test.ts src/plan/renames*.test.ts
bun test tests/role-rename-column-grant-carry.test.ts tests/renames.test.ts
PGDELTA_TEST_IMAGE=postgres:17-alpine bun test tests/engine.test.ts  # required
```

## Acceptance criteria

- [ ] Canonical direction = desired names (documented in code)
- [ ] Rename actions injected from accepted renames; not recovered via carry
- [ ] Role-name relabel churn absent from post-normalize diff
- [ ] Column ACL + role rename regression green
- [ ] Corpus green on at least PG 17 full run
- [ ] Changeset: `fix` or `feat` describing identity normalization
- [ ] Tombstone/doc for the new seam (and deleted carry)

## Conflicts / do not touch

- `plan/internal.ts` compaction (C1)
- Policy/Supabase rule bodies
- Extract SQL except if a bug blocks normalization (escalate; don’t expand)

## Done when

Carry is gone or trivially thin; I2 can document the invariant; C1 can proceed
without fighting rename cancellation order.
