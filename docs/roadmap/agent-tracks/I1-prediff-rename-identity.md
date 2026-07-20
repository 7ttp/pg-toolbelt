# I1 — Pre-diff rename identity normalization

**Priority:** Highest strategic · **Wave:** 2 · **Ship:** **two PRs** — I1a (pure normalizer, no pipeline change) then I1b (pipeline integration + carry deletion) · **Depends on:** V1 merged; **B1 merged** (cycle fix + scenario become I1's pin); C1 dual-prove preferred first (corpus gate then covers both compact modes) · **Conflicts with:** B1, C1, H1, anyone on carry/emitter

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
| Rename emission | **Existing seam** in `plan/phases/action-emitter.ts` (~lines 180–194) — keep it; see **Design decisions §2** |
| Integration point | After managed view reconstruction, **before** `diff()` — `plan/phases/change-set.ts` |
| Shrink/remove | `plan/role-rename-carry.ts`, call sites in `change-set.ts` / `plan/phases/action-emitter.ts` |
| Proof | **No changes expected** — `prove.ts` `renamedTables` is table/matview rename machinery (role renames are filtered out, ~prove.ts:411–414); out of scope, P2 owns `prove.ts` |
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

### 2. Rename emission already exists — keep the seam, do not rebuild it

Rename actions are **already synthesized outside generic diff**: the action
emitter iterates `acceptedRenames` and invokes each kind’s `rename` rule
(`plan/phases/action-emitter.ts` ~lines 180–194), emitting the action with
`produces` = new subtree / `destroys` = old subtree. Diff never emits renames
today, and `role-rename-carry.ts` only cancels churn — it never emits the
rename itself. **Do not build a second emission path.**

What normalization changes *around* that existing seam:

- **Capture `acceptedRenames` before the id rewrite.** The rename rule renders
  from the original `from` fact (`ALTER ROLE old RENAME TO new`); the emitter
  must keep receiving pre-rewrite from-facts, not normalized ones.
- **Ordering pin:** post-normalization, dependent facts reference **new**-name
  ids, so the existing `produces` = new-subtree edge is what sorts the rename
  before its dependents. Add a regression test for that ordering — today it
  also leans on old ids existing on the source side.

```text
discovery diff(source, desired)                    # EXISTING: proposals need its
  → propose + accept renames                       # remove/add pairs — renames.ts:48
    (original from-facts captured)                 # takes diff deltas, not raw FBs
  → record physical fingerprint (see §6) BEFORE any rewrite
  → rewrite both FBs to desired names (ids + edges + payload role refs, §3)
  → canonical diff(source′, desired′)              # sees continuity; no churn
  → action emitter synthesizes rename actions from acceptedRenames (existing code)
  → emit remaining actions (no carry canceler)
```

**Two diffs, by design.** `matchRenameCandidates` consumes the remove/add maps
of an initial diff (`change-set.ts:140` → `:171-177`) — it cannot propose from
raw fact bases. Diff is an in-memory Merkle compare; running it twice is cheap.
Do not try to collapse this into one pass, and do **not** reintroduce post-diff
remove/add cancellation to “find” renames.

### 3. What the rewrite must touch

Symmetric rewrite on source and desired for every kind in
`ROLE_NAME_BEARING_KINDS`, plus:

- **Dependency / owner edges** whose endpoints embed role names
- Any hash-adjacent structures derived from those ids (recompute rollups after
  rewrite; do not leave stale Merkle nodes)
- Column-qualified ACL keys (`acl:(…).grantee.column`) — full codec round-trip
- **Structured role-bearing payloads** — role names that live in fact
  *payloads*, not ids. Known inventory today: `policy.roles`
  (`extract/policies.ts:39`). This is **in scope**, not residual: unhandled, it
  produced the B1 dependency cycle (policy `consumes`/`releases` vs the rename
  action — see [B1](B1-role-rename-policy-cycle.md)), and “zero carry folklore”
  is false if payload refs still need a special-case carve-out. After
  normalization the policy delta vanishes entirely (correct: `polroles` is
  OID-carried, Postgres renames it for free) and B1's carve-out is deleted
  along with carry. Inventory payload role-ref fields explicitly in the PR;
  `policy.roles` is the only known case.

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

### 6. Physical vs canonical source — the fingerprint gate

`plan.source.fingerprint` is recorded from the managed view (`plan.ts:516`) and
`apply()` re-extracts the **physical** target — which still has pre-rename
names — and compares (`apply/apply.ts:158-186`). Today no mismatch exists
because nothing rewrites `source`. Under I1, a naive “normalize, then plan”
would fingerprint post-rename ids and the gate would **always fail** against
the real database.

Therefore keep both:

- **`physicalSource`** — the un-rewritten managed view; sole input for
  `source.fingerprint` and the apply gate.
- **`canonicalSource` / `canonicalDesired`** — the rewritten pair; used only
  for the canonical diff and planning.

Add a regression test: plan with an accepted role rename, assert the recorded
fingerprint equals the physical managed view's root hash (not the canonical
one), and that apply's gate passes against a pre-rename extraction.

## Two-PR split

- **I1a — pure normalizer.** `plan/identity-normalize.ts` (+ unit tests): given
  a fact base and an accepted-rename map, return the rewritten copy (ids,
  edges, payload role refs, recomputed rollups). No pipeline changes; carry
  untouched; ships dark.
- **I1b — pipeline integration.** Wire the normalizer into `change-set.ts`
  (discovery diff → normalize → canonical diff), record physical fingerprint
  per §6, delete carry (and B1's carve-out), migrate tests, full corpus gate.

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

**GREEN:** Implement normalizer (rename emission stays in the existing
action-emitter seam — decision §2); remove carry; re-run:

```bash
cd packages/pg-delta
bun test src/plan/identity-*.test.ts src/plan/renames*.test.ts
bun test tests/role-rename-column-grant-carry.test.ts tests/renames.test.ts
PGDELTA_TEST_IMAGE=postgres:17-alpine bun test tests/engine.test.ts  # required
```

## Acceptance criteria

- [ ] Canonical direction = desired names (documented in code)
- [ ] Rename emission stays in the existing action-emitter seam, fed
      pre-rewrite from-facts; not recovered via carry; ordering pinned by test
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

Carry is gone or trivially thin (including B1's carve-out); I2 can document the
invariant. C1's dual-prove is expected to be in place already (see scheduling) —
I1's corpus gate then covers both compact modes.
