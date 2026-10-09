/**
 * Planner phase 4 — ActionGraph (target-architecture §3.5–3.6).
 *
 * Turns the emitted action list into a deterministically ordered, compacted
 * final list plus the aggregated safety report. Pure over its inputs (the
 * emitted actions + producer/destroyer indexes + the two fact bases); the graph
 * construction, topo sort, segment-boundary marking, and compaction building
 * blocks live in ../internal.ts. Extracted so the ordering/compaction stage is a
 * named phase boundary rather than a tail of `plan()`.
 */
import type { FactBase } from "../../core/fact.ts";
import type { Action, SafetyReport } from "../plan.ts";
import { topoSort } from "../graph.ts";
import { encodeIdMemo, type StableId } from "../../core/stable-id.ts";
import type { ApplierCapability } from "../../policy/capability.ts";
import {
  isOverlayDefaultPrivilege,
  type AssumedDefaultGrant,
} from "../../policy/policy.ts";
import type { FoldHint, RulesForId } from "../rules.ts";
import {
  actionTieKey,
  buildActionGraph,
  compactColumnFolds,
  computeSafetyReport,
  elideCascadeSubsumedPolicyDrops,
  elideCoCreateRevokeBeforeGrant,
  elideDefaultAclCreates,
  elideRedundantDrops,
  foldCoCreateOwnership,
  mergeCoTargetGrants,
  mergeCoTargetRevokes,
} from "../internal.ts";

export interface FinalizeInput {
  actions: Action[];
  producerOf: ReadonlyMap<string, number>;
  destroyerOf: ReadonlyMap<string, number>;
  /** resolved source / desired views (NOT the projected target): graph build
   *  order reads desired edges, teardown reads source edges. */
  source: FactBase;
  desired: FactBase;
  renameActionIndices: ReadonlySet<number>;
  /** action index → encoded `destroys` ids that are side-effect wipes (see
   *  ActionEmitterOutput.implicitDestroys). */
  implicitDestroys: ReadonlyMap<number, ReadonlySet<string>>;
  /** per-action compaction metadata captured during emission (never persisted). */
  foldHints: ReadonlyArray<FoldHint | undefined>;
  acceptsFolds: readonly boolean[];
  /** policy-declared roles assumed to exist at apply time (e.g. Supabase
   *  anon/authenticated) — exempt from the missing-requirement guard just like
   *  the `pg_` prefix and PUBLIC. Empty under the raw/no-policy path. */
  assumedRoleNames: ReadonlySet<string>;
  /** policy-declared schemas assumed to exist at apply time (e.g. Supabase's
   *  `extensions`) — exempt from the missing-requirement guard like the assumed
   *  roles. Empty under the raw/no-policy path. */
  assumedSchemaNames: ReadonlySet<string>;
  /** encoded ids of platform-provisioned members of assumed schemas (system-
   *  role-owned, e.g. `supabase_functions.http_request()`) — exempt from the
   *  missing-requirement guard even when kept reference-only on the desired
   *  side and absent from the target. Computed by plan() from the RAW fact
   *  bases; empty under the raw/no-policy path. */
  assumedPresentIds: ReadonlySet<string>;
  /** Overlay tuples — keep a co-create REVOKE when the holder is a strict
   *  subset of `_ownerDefault` (dest injectee may be a superset). Empty →
   *  today's elision. */
  assumedDefaultGrants: readonly AssumedDefaultGrant[];
  /** Export-only overlay wipe tuples (`options.assumedDefaultGrants`). Distinct
   *  from `assumedDefaultGrants` (policy ∪ options): schema-stratum weight
   *  applies only to wipe creates the emitter actually prepended. */
  overlayAdpWipes: readonly AssumedDefaultGrant[];
  /** applier capability (move 6) — needed by the co-create compaction passes:
   *  the owner-ALTER no-op elision and the REVOKE-before-GRANT superset guard key
   *  off `capability.role`. Undefined under the unrestricted (superuser/CI/raw)
   *  path, where those capability-gated elisions stay conservative. */
  capability: ApplierCapability | undefined;
  /** §3.6 compaction; cosmetic-by-contract (proof unchanged). Default true. */
  compact: boolean;
  /** Export-only constraint folding: apply the constraint rules' inline-fold
   *  hints (CONSTRAINT name <def> into the table's CREATE parens), excluding
   *  the given encoded constraint ids (cycle-participating FKs). Undefined
   *  (the default, and every non-export path) leaves those hints inert. */
  foldConstraints: { exclude?: ReadonlySet<string> } | undefined;
  /** id-keyed rule resolver (schema kinds + `extensionIntent`), used by the
   *  tie-break so intent actions sort on their declared late weight. */
  rulesForId: RulesForId;
}

export interface FinalizeOutput {
  actions: Action[];
  safetyReport: SafetyReport;
}

/**
 * Order, segment-mark, and compact the emitted actions; compute the safety
 * report. Behavior-preserving extraction of `plan()`'s graph/order/compaction
 * tail.
 */
export function finalizeActions(input: FinalizeInput): FinalizeOutput {
  const {
    actions,
    producerOf,
    destroyerOf,
    source,
    desired,
    renameActionIndices,
    implicitDestroys,
    foldHints,
    acceptsFolds,
    assumedRoleNames,
    assumedSchemaNames,
    assumedPresentIds,
    assumedDefaultGrants,
    overlayAdpWipes,
    capability,
    compact,
    foldConstraints,
    rulesForId,
  } = input;

  // ── graph edges + deterministic order ─────────────────────────────────
  // Actions that RUN a user expression at apply time (a DEFAULT / generated
  // column backfill, a validated CHECK scan, an expression-index build).
  // Classified during the edge walk and fed to the tie-break ONLY — never as an
  // edge — so they sink below every simultaneously ready DEFINITION action
  // without making legitimate routine<->relation cycles unplannable.
  const evaluatorActions = new Set<number>();
  const overlayWipeActions = new Set<number>();
  if (overlayAdpWipes.length > 0) {
    actions.forEach((action, i) => {
      if (action.verb !== "create") return;
      const id = action.produces[0];
      if (id !== undefined && isOverlayDefaultPrivilege(overlayAdpWipes, id)) {
        overlayWipeActions.add(i);
      }
    });
  }
  const edges = buildActionGraph(
    actions,
    producerOf,
    destroyerOf,
    source,
    desired,
    renameActionIndices,
    assumedRoleNames,
    assumedSchemaNames,
    assumedPresentIds,
    evaluatorActions,
    implicitDestroys,
  );

  // Order a table's ADD COLUMN creates by declared column position
  // (pg_attribute.attnum, carried as the non-semantic `_position` field) instead
  // of column NAME, so a from-empty CREATE renders columns in declared order —
  // and the compaction pass, which folds them into the CREATE parens in this
  // order, inherits it. Only column CREATES are affected; drops/alters and every
  // other kind keep their encoded-id tie-break.
  const columnSubjectKey = (
    subject: StableId,
    action: Action,
  ): string | undefined => {
    if (action.verb !== "create" || subject.kind !== "column") return undefined;
    const pos = desired.get(subject)?.payload["_position"];
    if (typeof pos !== "number") return undefined;
    const c = subject as { schema: string; table: string; name: string };
    // Group each table's columns together (schema+table prefix), then order
    // within by zero-padded attnum. Every column create uses this same shape, so
    // the total order stays deterministic.
    return `column\x00${c.schema}\x00${c.table}\x00${String(pos).padStart(6, "0")}`;
  };
  // That tie-break only orders column creates that are READY together; a column
  // gated by a dependency its siblings lack (an enum type, a user-function
  // default) or never folded (a generated column) would otherwise run its ADD
  // COLUMN after higher-attnum siblings and land physically last (#518).
  chainColumnCreates(
    actions,
    edges,
    desired,
    foldHints,
    acceptsFolds,
    producerOf,
    columnSubjectKey,
    evaluatorActions,
  );
  const order = topoSort(
    actions.length,
    edges,
    (i) =>
      actionTieKey(
        actions,
        i,
        rulesForId,
        columnSubjectKey,
        evaluatorActions,
        overlayWipeActions,
      ),
    (i) => (actions[i] as Action).sql,
  );

  // ── commitBoundaryAfter segment boundary (§3.8) ───────────────────────
  // Mark the FIRST graph successor of each commitBoundaryAfter action with
  // newSegmentBefore. apply.ts already closes the segment unconditionally after
  // a commitBoundaryAfter action, so this flag's load-bearing role now is
  // COMPACTION PROTECTION — compaction refuses to fold a clause across a
  // newSegmentBefore boundary. `splitPlan` is a second producer: it runs
  // on an already-planned artifact so it cannot fight CREATE TABLE folding.
  const positionOf = Array.from({ length: actions.length }, () => 0);
  order.forEach((actionIndex, position) => {
    positionOf[actionIndex] = position;
  });
  const orderedActions = order.map((i) => actions[i] as Action);
  for (let u = 0; u < actions.length; u++) {
    if ((actions[u] as Action).transactionality !== "commitBoundaryAfter")
      continue;
    let firstConsumerPos = Number.POSITIVE_INFINITY;
    for (const [a, b] of edges) {
      if (a !== u) continue;
      const pos = positionOf[b] as number;
      if (pos < firstConsumerPos) firstConsumerPos = pos;
    }
    if (Number.isFinite(firstConsumerPos)) {
      (orderedActions[firstConsumerPos] as Action).newSegmentBefore = true;
    }
  }

  // ── compaction (§3.6) ─────────────────────────────────────────────────
  // fold ADD COLUMN clauses into their bare CREATE TABLE (no edge may cross the
  // merge), drop a replace's redundant drop when the create reproduces the
  // identical statement, elide REVOKE/GRANT pairs that only re-materialize a
  // freshly-created object's built-in default ACL, trim the cosmetic leading
  // REVOKE off remaining third-party co-create grants, fold a co-created
  // object's owner ALTER into its CREATE (CREATE SCHEMA … AUTHORIZATION, or drop
  // an applier-redundant ALTER), merge same-object REVOKE ALL leaders, then
  // merge consecutive same-privilege co-create GRANTs into one grantee-list
  // statement (last, so it sees final adjacency).
  // Purely cosmetic — the proof is unchanged.
  const finalActions = compact
    ? mergeCoTargetGrants(
        mergeCoTargetRevokes(
          foldCoCreateOwnership(
            elideCoCreateRevokeBeforeGrant(
              elideDefaultAclCreates(
                elideCascadeSubsumedPolicyDrops(
                  elideRedundantDrops(
                    compactColumnFolds(
                      orderedActions,
                      order,
                      edges,
                      foldHints,
                      acceptsFolds,
                      positionOf,
                      foldConstraints,
                    ),
                    source,
                  ),
                  source,
                ),
                desired,
                capability,
              ),
              desired,
              capability,
              assumedDefaultGrants,
            ),
            desired,
            capability,
          ),
        ),
        desired,
      )
    : orderedActions;

  return {
    actions: finalActions,
    safetyReport: computeSafetyReport(finalActions),
  };
}

/**
 * Pin each table's column CREATEs to declared position (#518), mutating `edges`:
 *  1. chain consecutive (by `_position` / attnum) column creates of the same
 *     table, so their ADD COLUMNs run in declared order even when one of them
 *     waits on a dependency its siblings do not have;
 *  2. order a fold-hinted column's own dependencies (its type, its default's
 *     function) before the CREATE TABLE it folds into, so the fold is not
 *     vetoed by an edge crossing the merge and the column stays inline.
 * Only for tables CREATED in the plan; an existing table's ADD COLUMNs keep
 * dependency order. A link that would close a cycle (e.g. a generated column
 * referencing a later column, or a dependency that itself needs the table) is
 * skipped, and so is a hoist of a dependency whose closure runs user code at
 * creation (an `evaluatorActions` member, e.g. a WITH DATA matview): that code
 * can read the new table through a quoted body pg_depend cannot see.
 */
function chainColumnCreates(
  actions: readonly Action[],
  edges: Array<[number, number]>,
  desired: FactBase,
  foldHints: ReadonlyArray<FoldHint | undefined>,
  acceptsFolds: readonly boolean[],
  producerOf: ReadonlyMap<string, number>,
  columnSubjectKey: (subject: StableId, action: Action) => string | undefined,
  evaluatorActions: ReadonlySet<number>,
): void {
  const byTable = new Map<string, Array<[position: number, action: number]>>();
  actions.forEach((action, i) => {
    const id = action.produces[0];
    // a positioned column create (the tie-break above uses this predicate).
    if (id === undefined || columnSubjectKey(id, action) === undefined) return;
    const fact = desired.get(id);
    const pos = fact?.payload["_position"];
    if (typeof pos !== "number" || fact?.parent === undefined) return;
    const key = encodeIdMemo(fact.parent);
    const list = byTable.get(key) ?? [];
    list.push([pos, i]);
    byTable.set(key, list);
  });
  if (byTable.size === 0) return;
  const preds: number[][] = Array.from({ length: actions.length }, () => []);
  for (const [a, b] of edges) preds[b]?.push(a);
  // does any strict ancestor of `to` satisfy `hit`?
  const anyAncestor = (to: number, hit: (p: number) => boolean): boolean => {
    const seen = new Set<number>([to]);
    const stack = [to];
    for (let top = stack.pop(); top !== undefined; top = stack.pop()) {
      for (const p of preds[top] ?? []) {
        if (hit(p)) return true;
        if (!seen.has(p)) {
          seen.add(p);
          stack.push(p);
        }
      }
    }
    return false;
  };
  const reaches = (from: number, to: number): boolean =>
    anyAncestor(to, (p) => p === from);
  const runsUserCode = (i: number): boolean =>
    evaluatorActions.has(i) || anyAncestor(i, (p) => evaluatorActions.has(p));
  const link = (before: number, after: number): void => {
    if (before === after || reaches(after, before)) return;
    edges.push([before, after]);
    preds[after]?.push(before);
  };
  for (const [tableKey, list] of byTable) {
    // only a table CREATED in this plan: it has no rows, so no column default is
    // evaluated. An existing table keeps dependency order, since an ADD COLUMN
    // default backfill can read objects pg_depend cannot see (a quoted body).
    const table = producerOf.get(tableKey);
    if (table === undefined || actions[table]?.verb !== "create") continue;
    list.sort((x, y) => x[0] - y[0]);
    // descending, so an ancestor walk never re-traverses the chain built so far.
    for (let k = list.length - 2; k >= 0; k--) {
      const cur = list[k];
      const next = list[k + 1];
      if (cur !== undefined && next !== undefined) link(cur[1], next[1]);
    }
    if (!acceptsFolds[table]) continue;
    for (const [, i] of list) {
      if (foldHints[i] === undefined) continue;
      // `link` only appends to the table's preds, never to column `i`'s. A
      // dependency that runs user code at creation stays after the table: the
      // column then becomes an ADD COLUMN, still in its chained slot.
      for (const p of preds[i] ?? []) {
        if (!runsUserCode(p)) link(p, table);
      }
    }
  }
}
