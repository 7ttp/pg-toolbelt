# P2 — Attributed projection audit

**Priority:** Medium–High · **Wave:** 3 · **Ship:** alone · **Depends on:** V1 · **Serialize with:** P1 on `prove.ts`

## Goal

Report, alongside the managed proof, an **attributed projection audit**: every
fact the projection excluded from the managed view, tagged with **which stage
and rule excluded it** and whether it **still differs** between source and
desired — classified **acknowledged** (expected for this profile) vs
**suspicious** (user-namespace object eaten by a generic rule). So
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

## Audit model (pinned — challenge in PR if wrong)

Two earlier designs were rejected for the same reason — **an unattributed
second drift diff is perpetually noisy**:

- *Raw-extract drift*: platform/extension noise always red-lights.
- *Baseline-subtracted drift* (and its “projection residue” refinement):
  intentionally excluded objects that legitimately differ (e.g. Supabase
  platform schemas excluded by policy scope rules, cluster objects under
  database scope) are also “excluded from the view and still different.”
  Operators learn to ignore the signal, which defeats it.

The signal must carry **attribution**:

| Piece | Definition |
|---|---|
| **Managed drift** | Today’s prove compare, after `reconstructManagedView` — unchanged. |
| **Exclusion record** | For each fact dropped between the post-extract catalog and the final managed view: `{ factId, stage, rule/reason }`, where stage ∈ baseline · policy scope rule · capability · management scope · reference-only projection. |
| **Audit entry** | Exclusion record joined with “does this fact differ between source and desired?” — only differing excluded facts are reported. |
| **Classification** | **acknowledged** — excluded by a rule that names it (profile baseline, explicit platform-schema rule); **suspicious** — a user-namespace fact swept out by a generic/wildcard rule or scope projection. The classification rubric must be data (per-rule flag), not a hardcoded schema list. |

This requires `resolveView` / `projectManagementScope` (via V1’s helper) to
**emit exclusion attribution** — an additive optional output, off the hot path
when not requested. That is the core engineering of this track; the prove/CLI
surfacing is thin on top.

## Design requirements

1. **Additive API:** existing `ok` / managed proof semantics unchanged unless
   documented as intentional. The audit is informational by default.
2. Code comments restate the audit model above at the attribution site.
3. CLI: human-readable section + machine-readable field; don’t fail CI corpus
   on audit findings unless opted in (`strictAudit` or similar — and then only
   on **suspicious** entries, never acknowledged ones).
4. Unit tests: managed green / audit red (synthetic fact bases where a generic
   policy rule filters out a differing user fact → one **suspicious** entry
   with the correct stage + rule attribution).

## RED → GREEN

1. **RED:** A policy rule filters a user fact out of the managed view while it
   still differs — managed proof ignores it; the audit must surface it as
   **suspicious** with stage/rule attribution. Companion case: a
   platform-schema fact excluded by a named rule differs → **acknowledged**,
   not suspicious.
2. **GREEN:** Attribution plumbing + audit join; wire CLI optionally.
3. Focused:
   ```bash
   cd packages/pg-delta
   bun test src/proof/prove.test.ts
   bun test tests/cli.test.ts  # if CLI surfaced
   ```

## Acceptance criteria

- [ ] Prove result includes the projection-audit summary (even if empty)
- [ ] Every audit entry carries stage + rule attribution and a
      suspicious/acknowledged classification
- [ ] Audit model matches the table above (or PR documents a justified amendment)
- [ ] Managed path uses sealed reconstruct helper (V1); attribution flows
      through it, not around it
- [ ] Tests cover suspicious vs acknowledged vs clean
- [ ] Changeset `feat`
- [ ] No corpus mass-failure (opt-in strictness, suspicious-only)

## Conflicts

- Sole owner of `prove.ts` while this track is open
- Do not parallel with V1 or heavy I1 prove rename edits

## Done when

Operators can see “managed ok, but the projection excluded N differing facts —
M suspicious (rule X ate schema Y), rest acknowledged.”
