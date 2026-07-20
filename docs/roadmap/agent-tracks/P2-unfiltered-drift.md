# P2 — Prove unfiltered drift separately

**Priority:** Medium–High · **Wave:** 3 · **Ship:** alone · **Depends on:** V1 · **Serialize with:** P1 on `prove.ts`

## Goal

Report **managed-view drift** and **unfiltered drift** as distinct signals so
policy/baseline/scope bugs cannot hide behind a green managed proof.

## Why this track exists

Prove reconstructs the projected desired view (`resolveView` / scope / baseline /
capability). Wrong view wiring fails as drift — or greens a plan that never
managed what the user thought. The failure mode this track exists for:

> Policy (or scope) accidentally dropped a **user** object from the managed view
> while it still differs in the catalog.

## Out of scope

- Action budgets (P1)
- autoSeed default flip (P3)
- Identity normalization (I1)
- Changing what `resolveView` filters — only **observability** of both layers

## Owned files (write)

| Area | Paths |
|---|---|
| Core | `packages/pg-delta/src/proof/prove.ts`, `proof/prove.test.ts` |
| Types / result | Prove result type exporting both drift views |
| CLI (if applicable) | `cli/commands/prove.ts`, `cli/commands/drift.ts` — additive fields only |
| Docs | Short note in README prove section or `managed-view-architecture.md` |

## Drift definitions (pinned — challenge in PR if wrong)

| Signal | Definition |
|---|---|
| **Managed drift** | Diff after `reconstructManagedView` (today’s prove compare): policy + capability + baseline + scope + defaultOwner. |
| **Unfiltered drift** | Diff after **baseline subtraction only** — i.e. post-extract fact bases with the profile/policy baseline applied, **without** policy scope-filter / reference-only projection / capability restriction / management scope. |

**Why baseline-only for “unfiltered” (not raw extract):**

- Raw extract includes platform/extension noise the product intentionally ignores;
  comparing it always red-lights and trains operators to ignore the signal.
- Baseline-subtracted catalog is the “what should exist for this product image”
  universe; if a **user** object is missing from the managed view but still
  present (or differing) here, policy/scope ate it — exactly the bug class.
- Capability/scope projections stay on the managed side only.

If implementation discovers baseline-only is ambiguous (e.g. baseline requires
policy handlers), document the minimal extra projection required and keep the
spirit: **widest product-meaningful catalog, not the narrowed managed view.**

Use V1’s `reconstructManagedView` for the managed side.

## Design requirements

1. **Additive API:** existing `ok` / managed proof semantics unchanged unless
   documented as intentional. Unfiltered drift is informational by default.
2. Code comments restate the two definitions above at the compare site.
3. CLI: human-readable section + machine-readable field; don’t fail CI corpus
   on unfiltered drift unless opted in (`strictUnfiltered` or similar).
4. Unit tests: managed green / unfiltered red (synthetic fact bases where policy
   filters out a differing user fact).

## RED → GREEN

1. **RED:** Policy filters a fact out of the managed view while it still differs
   under baseline-only projection — managed proof ignores it; unfiltered report
   surfaces it.
2. **GREEN:** Dual compare; wire CLI optionally.
3. Focused:
   ```bash
   cd packages/pg-delta
   bun test src/proof/prove.test.ts
   bun test tests/cli.test.ts  # if CLI surfaced
   ```

## Acceptance criteria

- [ ] Prove result includes unfiltered drift summary (even if empty)
- [ ] Definitions match the table above (or PR documents a justified amendment)
- [ ] Managed path uses sealed reconstruct helper (V1)
- [ ] Tests cover managed-only vs both-layers mismatch
- [ ] Changeset `feat` or `fix` as appropriate
- [ ] No corpus mass-failure (opt-in strictness)

## Conflicts

- Sole owner of `prove.ts` while this track is open
- Do not parallel with V1 or heavy I1 prove rename edits

## Done when

Operators can see “managed ok, but baseline-subtracted catalog still differs.”
