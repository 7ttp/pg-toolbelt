/**
 * The planner (target-architecture §3.4–3.6): deltas × rule table → atomic
 * actions → one mixed dependency graph → one deterministic sort.
 */
import { diff, type Delta } from "../core/diff.ts";
import type { Fact, FactBase } from "../core/fact.ts";
import { canonicalize, type Payload } from "../core/hash.ts";
import { encodeId, type StableId } from "../core/stable-id.ts";
import {
  factMatches,
  filterDeltas,
  flattenPolicy,
  resolveView,
  validatePolicy,
  type Policy,
} from "../policy/policy.ts";
import { canSetOwner, type ApplierCapability } from "../policy/capability.ts";
import { topoSort } from "./graph.ts";
import {
  actionTieKey,
  buildActionGraph,
  compactColumnFolds,
  computeSafetyReport,
  elideRedundantDrops,
} from "./internal.ts";
import { projectTarget } from "./project.ts";
import { lockClassFor, type LockClass } from "./locks.ts";
import { grantTarget, qid } from "./render.ts";
import {
  matchRenameCandidates,
  subtreeIds,
  type RenameCandidate,
  type RenameMode,
} from "./renames.ts";
import {
  buildRoleRenameMap,
  computeRoleRenameCarry,
  ownerEdgeKey,
  roleNamesIn,
} from "./role-rename-carry.ts";
import {
  KNOWN_PARAMS,
  rulesFor,
  type ActionSpec,
  type KindRules,
  type PlanParams,
} from "./rules.ts";

/** Engine version stamped into plan artifacts; apply refuses artifacts
 *  from an engine it does not understand (stage 6 deliverable 1). */
export const ENGINE_VERSION = "0.1.0";

export interface Action {
  sql: string;
  verb: "create" | "alter" | "drop";
  produces: StableId[];
  consumes: StableId[];
  destroys: StableId[];
  /** ids this action stops referencing — must run before their destroyer */
  releases: StableId[];
  /** three-valued transactionality (§3.8) */
  transactionality:
    | "transactional"
    | "nonTransactional"
    | "commitBoundaryAfter";
  /** documented lock level of this DDL form — reported, never certified */
  lockClass: LockClass;
  /** forces a COMMIT before this action. Set on the first consumer of a
   *  commitBoundaryAfter action; consumed BOTH by apply (a segment boundary —
   *  now belt-and-suspenders, since apply also closes the segment
   *  unconditionally after a commitBoundaryAfter action, review #6) AND by
   *  compaction, which must not fold a clause across this boundary
   *  (internal.ts). The latter is its load-bearing role today. */
  newSegmentBefore: boolean;
  dataLoss: "none" | "destructive";
  rewriteRisk: boolean;
}

/** Aggregated per-action safety metadata (§3.7). Lock classes and
 *  rewrite/data-loss counts; the proof loop turns dataLoss into a
 *  verified claim, lock classes stay reported. */
export interface SafetyReport {
  destructiveActions: number;
  rewriteRiskActions: number;
  nonTransactionalActions: number;
  lockClasses: Partial<Record<LockClass, number>>;
}

export interface Plan {
  formatVersion: 1;
  engineVersion: string;
  source: { fingerprint: string };
  target: { fingerprint: string };
  /** session settings the executor applies per transaction segment —
   *  explicit plan metadata, not loose SQL in the action list */
  preamble: { name: string; value: string }[];
  deltas: Delta[];
  /** deltas the policy filtered out — reported, never silently absent
   *  (§3.9): drift the user chose not to manage is still drift they can
   *  ask about */
  filteredDeltas: Delta[];
  /** the policy that shaped this plan, inlined for reproducibility */
  policy?: Policy;
  /** the applier capability the plan was produced with (move 6 / follow-up 2),
   *  inlined so a later prove/apply recovers the SAME view. `memberOf` is an
   *  array → the artifact round-trips losslessly. */
  capability?: ApplierCapability;
  /** the integration profile that produced this plan, stamped by the CLI when a
   *  known profile is selected. `apply`/`prove` default to this profile when
   *  `--profile` is omitted and reject a contradicting `--profile`, so the
   *  plan == prove == apply invariant is enforced by the artifact, not just by a
   *  comment. Absent on library-produced (raw) artifacts. */
  profile?: { id: string };
  /** every rename candidate found, applied or not — "prompt" mode renders
   *  these as questions; near-misses explain why they degraded (§4.1) */
  renameCandidates: RenameCandidate[];
  actions: Action[];
  safetyReport: SafetyReport;
}

export interface PlanOptions {
  /** named serialize parameters consumed by rule templates; unknown
   *  names are a plan-time error (stage 8 wires policies here) */
  params?: PlanParams;
  /** policy (§3.9): filters which deltas this plan manages and supplies
   *  serialize parameters. If the policy DECLARES a baseline, the resolved
   *  baseline FactBase must be passed as `baseline` below — plan() refuses an
   *  unresolved declared baseline rather than silently ignoring it. */
  policy?: Policy;
  /** resolved platform baseline (§3.9): facts present-and-identical here are
   *  subtracted from both sides before diffing, so platform-managed objects are
   *  invisible. Resolve a policy's declared baseline NAME into this FactBase
   *  with `resolveBaseline(policy, { pgMajor })`. plan() stays pure — it
   *  subtracts a provided FactBase, never reads a file. */
  baseline?: FactBase;
  /** rename detection (§4.1, stage 9). "auto" applies unambiguous
   *  candidates; "prompt" reports candidates and applies only those in
   *  acceptRenames; "off" (default) preserves drop+create. */
  renames?: RenameMode;
  /** in "prompt" mode: the candidates the caller confirmed */
  acceptRenames?: Array<{ from: StableId; to: StableId }>;
  /** compaction (§3.6): fold column clauses into their CREATE TABLE when
   *  no graph edge crosses the merge. Cosmetic by contract — proof results
   *  never change (asserted by the compaction suite). Default: true. */
  compact?: boolean;
  /** applier capability (move 6): operations the applier cannot execute (e.g.
   *  FDW ACLs for a non-superuser) are projected out of the view. Supplied by
   *  the resolved profile (`resolveProfile(pool, profile, { restrictToApplier:
   *  true })`), or probe directly with `probeApplierCapability` from
   *  `@supabase/pg-delta-next/integrations`. Default unrestricted. */
  capability?: ApplierCapability;
  /** the integration profile id to stamp on the plan artifact (set by the
   *  resolved profile's `planOptions`), so `apply`/`prove` can reconstruct the
   *  same managed view without the operator re-specifying `--profile`. */
  profile?: { id: string };
}

// Per-kind graph/suppression policy is DECLARED IN THE RULE TABLE
// (guardrail 3). These accessors read those flags; the planner body holds
// no kind-name lists. `rulesFor` throws for unknown kinds, so guard it.
function ruleFlag<K extends keyof KindRules>(
  kind: string,
  flag: K,
): KindRules[K] | undefined {
  try {
    return rulesFor(kind)[flag];
  } catch {
    return undefined;
  }
}
const cascadesToChildren = (kind: string): boolean =>
  ruleFlag(kind, "cascadesToChildren") === true;
const isRebuildable = (kind: string): boolean =>
  ruleFlag(kind, "rebuildable") === true;

export function plan(
  source: FactBase,
  desired: FactBase,
  options?: PlanOptions,
): Plan {
  if (options?.policy) validatePolicy(options.policy);
  // a declared baseline must NEVER be silently ignored (review finding 3): if
  // the policy names a baseline, the caller must resolve it (resolveBaseline)
  // and pass it as options.baseline. Refuse otherwise — at every entry point.
  if (
    options?.policy?.baseline !== undefined &&
    options.baseline === undefined
  ) {
    throw new Error(
      `plan: policy "${options.policy.id}" declares baseline "${options.policy.baseline}" ` +
        `but no resolved baseline was provided. Resolve it with ` +
        `resolveBaseline(policy, { pgMajor }) and pass it as options.baseline, so ` +
        `platform facts are actually subtracted — a declared baseline is never silently ignored.`,
    );
  }
  // the managed VIEW the engine diffs (docs/architecture/managed-view-architecture.md): the
  // platform baseline is subtracted, then the policy's scope (non-`verb`) rules
  // + extension-member provenance are projected out at the FACT level on BOTH
  // sides, so the proof stays honest by construction. `verb` rules remain for
  // the delta-level filter below. With no policy/baseline this is exactly
  // `excludeExtensionMembers`, so the corpus is unchanged.
  source = resolveView(
    source,
    options?.policy,
    options?.capability,
    options?.baseline,
  );
  desired = resolveView(
    desired,
    options?.policy,
    options?.capability,
    options?.baseline,
  );
  const params: PlanParams = options?.params ?? {};
  for (const name of Object.keys(params)) {
    if (!KNOWN_PARAMS.has(name)) {
      throw new Error(
        `plan: unknown serialize parameter '${name}' — the rule table declares ${[...KNOWN_PARAMS].join(", ")}`,
      );
    }
  }
  // policy serialize rules apply PER FACT (first matching rule's params,
  // §3.9) — explicit options.params override rule-supplied values
  const serializeRules = options?.policy
    ? flattenPolicy(options.policy).serialize
    : [];
  const allDeltas = diff(source, desired);
  const { kept: deltas, filtered: filteredDeltas } = options?.policy
    ? filterDeltas(allDeltas, options.policy, source, desired)
    : { kept: allDeltas, filtered: [] };
  // the honest plan target: `desired` with every FILTERED delta reverted to
  // its source value, since the plan only applies KEPT deltas (review #2). The
  // fingerprint and the proof both target THIS, not full `desired`.
  const projectedDesired = projectTarget(desired, filteredDeltas);

  const removed = new Map<string, Fact>();
  const added = new Map<string, Fact>();
  const setsByFact = new Map<string, Extract<Delta, { verb: "set" }>[]>();
  for (const delta of deltas) {
    if (delta.verb === "remove")
      removed.set(encodeId(delta.fact.id), delta.fact);
    if (delta.verb === "add") added.set(encodeId(delta.fact.id), delta.fact);
    if (delta.verb === "set") {
      const key = encodeId(delta.id);
      const list = setsByFact.get(key) ?? [];
      list.push(delta);
      setsByFact.set(key, list);
    }
  }

  // ── rename detection (§4.1, stage 9) ──────────────────────────────────
  // accepted renames cancel their remove/add subtrees BEFORE replace,
  // rebuild, and suppression see them; the rename action is emitted later
  const renameMode: RenameMode = options?.renames ?? "off";
  const renameCandidates: RenameCandidate[] = [];
  const acceptedRenames: Array<{ from: Fact; to: Fact }> = [];
  if (renameMode !== "off") {
    const candidates = matchRenameCandidates(removed, added, source, desired);
    renameCandidates.push(...candidates);
    const confirmed = new Set(
      (options?.acceptRenames ?? []).map(
        (r) => `${encodeId(r.from)}>${encodeId(r.to)}`,
      ),
    );
    for (const candidate of candidates) {
      if (candidate.status !== "unambiguous") continue;
      const key = `${encodeId(candidate.from)}>${encodeId(candidate.to)}`;
      if (renameMode === "prompt" && !confirmed.has(key)) continue;
      const fromFact = removed.get(encodeId(candidate.from)) as Fact;
      const toFact = added.get(encodeId(candidate.to)) as Fact;
      // structural equality covers the whole subtree: cancel every
      // descendant's remove/add — the rename carries them implicitly
      for (const id of subtreeIds(source, candidate.from))
        removed.delete(encodeId(id));
      for (const id of subtreeIds(desired, candidate.to))
        added.delete(encodeId(id));
      acceptedRenames.push({ from: fromFact, to: toFact });
    }
  }

  // ── role-rename carry (role-rename-carry.ts) ──────────────────────────
  // PostgreSQL carries every role-name-bearing fact through `ALTER ROLE …
  // RENAME` by OID. The diff still surfaces those as remove/add (or owner
  // unlink/link) pairs differing only by the renamed name; this Module decides,
  // in ONE place, which the rename carries so emission re-issues no DDL for
  // them. carriedFactKeys (acl/membership/userMapping/defaultPrivilege) are
  // cancelled from the worklists here; carriedOwnerLinks are skipped in the
  // owner-edge loop below (where the role-only-rename owner cycle lived).
  const roleRenameMap = buildRoleRenameMap(acceptedRenames);
  const { carriedFactKeys, carriedOwnerLinks, changedFacts } =
    computeRoleRenameCarry(deltas, roleRenameMap);
  for (const key of carriedFactKeys) {
    removed.delete(key);
    added.delete(key);
  }
  // A changed pair carries the IDENTITY (old name → new name by OID) but the
  // payload also changed. Cancel the old-name teardown AND the new-name create,
  // and capture the facts so the emit phase can mutate the post-rename id
  // instead (review P2, fourth follow-up). The renamed roles the new id
  // references order that mutation AFTER the role rename.
  const targetRoleNames = new Set(roleRenameMap.values());
  const changedRoleFacts: Array<{
    toFact: Fact;
    fromPayload: Payload;
    orderingConsumes: StableId[];
  }> = [];
  for (const { from, to } of changedFacts) {
    const fromFact = removed.get(encodeId(from));
    const toFact = added.get(encodeId(to));
    removed.delete(encodeId(from));
    added.delete(encodeId(to));
    if (fromFact === undefined || toFact === undefined) continue;
    changedRoleFacts.push({
      toFact,
      fromPayload: fromFact.payload,
      orderingConsumes: [...roleNamesIn(to)]
        .filter((name) => targetRoleNames.has(name))
        .map((name) => ({ kind: "role", name }) as StableId),
    });
  }

  // ── classify set-deltas: in-place alter vs replace ────────────────────
  const replaceIds = new Set<string>();
  // alters that invalidate dependents (e.g. an enum value-set replacement,
  // or an ALTER COLUMN TYPE that views/policies reference) seed the forced-
  // rebuild pass without replacing the fact itself. The value is the set of
  // dependent kinds to rebuild (null = all rebuildable kinds).
  const rebuildSeeds = new Map<string, ReadonlySet<string> | null>();
  for (const [key, sets] of setsByFact) {
    const kind = (desired.get(sets[0]!.id) as Fact).id.kind;
    const rules = rulesFor(kind);
    for (const s of sets) {
      const attrRule = rules.attributes[s.attr];
      if (attrRule === undefined) {
        throw new Error(
          `rule table: kind '${kind}' has no rule for attribute '${s.attr}' (${key}) — extend the rule vocabulary (guardrail 3)`,
        );
      }
      if (attrRule === "replace") {
        replaceIds.add(key);
        continue;
      }
      const rebuild = attrRule.rebuildsDependents?.(s.from, s.to);
      if (rebuild === true) rebuildSeeds.set(key, null);
      else if (Array.isArray(rebuild)) rebuildSeeds.set(key, new Set(rebuild));
    }
  }

  // ── forced dependent rebuild (the clean expand-replace, §3.4) ─────────
  // A surviving dependent of something this plan destroys must be dropped
  // and recreated from the desired state — recursively. Which kinds are
  // rebuildable is declared per-kind in the rule table (`rebuildable`).
  {
    // `fullDestroy` ids rebuild EVERY rebuildable dependent; `rebuildSeeds`
    // (an in-place alter that invalidates only some dependent kinds) rebuild
    // only their declared kinds. Once a dependent is rebuilt it joins
    // `fullDestroy`, so its own subtree rebuilds completely.
    const fullDestroy = new Set([...removed.keys(), ...replaceIds]);
    const targets = new Set([...fullDestroy, ...rebuildSeeds.keys()]);
    // Reverse-dependency reachability from the initial targets, instead of
    // rescanning every source edge each fixpoint round (O(reachable) vs
    // O(edges × rounds), #2). Same checks/precedence as the fixpoint: a
    // dependent of a destroyed/replaced fact (or a kind-restricted seed) that is
    // rebuildable and survives in `desired` is replaced, and itself becomes a
    // full-destroy target so its own subtree rebuilds.
    const worklist = [...targets];
    while (worklist.length > 0) {
      const toKey = worklist.pop() as string;
      for (const edge of source.incomingEdgesByEncoded(toKey)) {
        const fromKey = encodeId(edge.from);
        if (targets.has(fromKey)) continue;
        const dependent = source.get(edge.from);
        if (!dependent || !desired.has(edge.from)) continue;
        if (!isRebuildable(dependent.id.kind)) continue;
        // reached only via a kind-restricted seed: honor the allowed kinds
        if (!fullDestroy.has(toKey)) {
          const allowed = rebuildSeeds.get(toKey);
          if (allowed && !allowed.has(dependent.id.kind)) continue;
        }
        replaceIds.add(fromKey);
        fullDestroy.add(fromKey);
        targets.add(fromKey);
        worklist.push(fromKey);
      }
    }
    // descendants of replaced facts are handled by the ancestor's subtree
    // recreate — keep only the topmost replaced facts
    // deleting the entry under iteration is safe for a JS Set
    for (const key of replaceIds) {
      const fact = source.getByEncoded(key);
      let ancestor = fact?.parent;
      while (ancestor !== undefined) {
        if (replaceIds.has(encodeId(ancestor))) {
          replaceIds.delete(key);
          break;
        }
        ancestor = source.get(ancestor)?.parent;
      }
    }
  }

  // ── suppression: child removals that cascade with an ancestor's drop ──
  // dropRootOf(id) = nearest removed ancestor whose drop action will exist.
  // FK constraint drops are NEVER suppressed: explicit DROP CONSTRAINT
  // before the table drops makes mutual-FK teardown cycles unconstructible
  // (decomposition over repair, §3.5).
  const isRemovedId = (id: StableId): boolean => {
    const key = encodeId(id);
    return removed.has(key) || replaceIds.has(key);
  };
  const dropRootOf = new Map<string, string>();
  const findDropRoot = (fact: Fact): string => {
    const key = encodeId(fact.id);
    const cached = dropRootOf.get(key);
    if (cached) return cached;
    let root = key;
    const rules = rulesFor(fact.id.kind);
    const suppressible = rules.suppressible?.(fact) ?? true;
    const parent = fact.parent;
    if (parent !== undefined && suppressible) {
      const parentRemoved = isRemovedId(parent);
      // a metadata satellite folds into ANY removed parent; otherwise the
      // parent kind must be one whose DROP cascades to children
      const cascades =
        rules.metadata === true || cascadesToChildren(parent.kind);
      if (parentRemoved && cascades) {
        root = findDropRoot(
          removed.get(encodeId(parent)) ?? (source.get(parent) as Fact),
        );
      }
    }
    dropRootOf.set(key, root);
    return root;
  };
  for (const fact of removed.values()) findDropRoot(fact);

  // a fact whose drop folds into a NON-parent ancestor (an OWNED BY
  // sequence into its owning column/table) — declared per-kind via
  // dropRootRedirect, resolved here
  for (const fact of removed.values()) {
    const redirect = rulesFor(fact.id.kind).dropRootRedirect?.(
      fact,
      isRemovedId,
    );
    if (redirect === undefined) continue;
    const redirectKey = encodeId(redirect);
    dropRootOf.set(
      encodeId(fact.id),
      dropRootOf.get(redirectKey) ?? redirectKey,
    );
  }

  // ── emit actions ──────────────────────────────────────────────────────
  const actions: Action[] = [];
  const producerOf = new Map<string, number>();
  const destroyerOf = new Map<string, number>();
  // transient per-action compaction metadata (never enters the artifact)
  const foldHints: Array<{ foldInto: StableId; clause: string } | undefined> =
    [];
  const acceptsFolds: boolean[] = [];

  const pushAction = (
    verb: Action["verb"],
    spec: ActionSpec,
    opts: {
      produces?: StableId[];
      consumes?: StableId[];
      destroys?: StableId[];
    },
  ): number => {
    const index = actions.length;
    const produces = [...(opts.produces ?? []), ...(spec.alsoProduces ?? [])];
    const destroys = [...(opts.destroys ?? []), ...(spec.alsoDestroys ?? [])];
    const consumes = [...(opts.consumes ?? []), ...(spec.consumes ?? [])];
    const subjectKind = (produces[0] ?? destroys[0] ?? consumes[0])?.kind;
    actions.push({
      sql: spec.sql,
      verb,
      produces,
      consumes,
      destroys,
      releases: spec.releases ?? [],
      transactionality: spec.transactionality ?? "transactional",
      lockClass:
        spec.lockClass ??
        (subjectKind === undefined ? "none" : lockClassFor(subjectKind, verb)),
      newSegmentBefore: false,
      dataLoss: spec.dataLoss ?? "none",
      rewriteRisk: spec.rewriteRisk ?? false,
    });
    foldHints[index] = spec.compaction;
    acceptsFolds[index] = spec.acceptsColumnFolds ?? false;
    for (const id of produces) {
      const key = encodeId(id);
      if (!producerOf.has(key)) producerOf.set(key, index);
    }
    for (const id of destroys) destroyerOf.set(encodeId(id), index);
    return index;
  };

  const paramsCache = new Map<string, PlanParams>();
  const paramsFor = (fact: Fact): PlanParams => {
    if (serializeRules.length === 0) return params;
    const key = encodeId(fact.id);
    const cached = paramsCache.get(key);
    if (cached !== undefined) return cached;
    let merged = params;
    for (const rule of serializeRules) {
      if (factMatches(rule.match, fact, desired)) {
        merged = { ...rule.params, ...params };
        break;
      }
    }
    paramsCache.set(key, merged);
    return merged;
  };

  const emitCreate = (fact: Fact, base: FactBase): void => {
    const specs = rulesFor(fact.id.kind).create(fact, base, paramsFor(fact));
    specs.forEach((spec, i) => {
      pushAction("create", spec, {
        produces: i === 0 ? [fact.id] : [],
        consumes: [
          ...(i === 0 ? [] : [fact.id]),
          ...(fact.parent !== undefined ? [fact.parent] : []),
        ],
      });
    });
  };

  // renames: one action renames the whole subtree — produces every new
  // id, destroys every old id; dependents order against those sets.
  // Tracked so buildActionGraph can treat them as identity-only: a rename
  // does NOT establish or tear down the owner edge (PostgreSQL preserves the
  // owner across RENAME), so owner edges on the renamed subtree must not drive
  // graph ordering through the rename (review P1 #2: rename/rename cycle).
  const renameActionIndices = new Set<number>();
  for (const { from, to } of acceptedRenames) {
    const rename = rulesFor(from.id.kind).rename;
    if (rename === undefined) {
      throw new Error(
        `rename: kind '${from.id.kind}' matched as candidate but has no rename rule`,
      );
    }
    renameActionIndices.add(
      pushAction("alter", rename(from, to.id), {
        produces: subtreeIds(desired, to.id),
        destroys: subtreeIds(source, from.id),
        consumes: to.parent !== undefined ? [to.parent] : [],
      }),
    );
  }

  // creates — parents first, so a parent's delta-set inlining (e.g. a
  // partitioned table's columns rendered inside its CREATE, registered via
  // alsoProduces) is visible before its children are considered
  const depthOf = (fact: Fact): number => {
    let depth = 0;
    let parent = fact.parent;
    while (parent !== undefined) {
      depth++;
      parent = desired.get(parent)?.parent;
    }
    return depth;
  };
  for (const fact of [...added.values()].sort(
    (a, b) => depthOf(a) - depthOf(b),
  )) {
    if (producerOf.has(encodeId(fact.id))) continue;
    // EMISSION sees the PROJECTED plan target, not full `desired`: a child fact
    // whose own add delta was policy-filtered (a column's DEFAULT, a partitioned
    // table's column, a composite type's attribute, a publication's relation)
    // is absent here, so create rules cannot inline it via `alsoProduces`
    // (review P1 #1). buildActionGraph below still reads un-projected `desired`
    // for the missing-requirement invariant — the two views are deliberately
    // distinct (docs/roadmap/tier-3-engine-refactors.md §1).
    emitCreate(fact, projectedDesired);
  }

  // default-privilege hygiene: objects created under active default ACLs
  // receive implicit grants; revoke them when the desired state has no
  // corresponding acl fact (pg_dump-style clean slate).
  // EMISSION reads the PROJECTED plan target, not full `desired` (review P1 #3):
  // a policy can filter the default-privilege add AND its grantee role, and the
  // hygiene REVOKE must not surface a filtered-away role (which would then fail
  // the planner's own missing-requirement check). Mirrors the create/alter seam.
  for (const fact of added.values()) {
    // which pg_default_acl objtype this kind maps to is declared per-kind
    // in the rule table (`defaclObjtype`); absent → no default ACLs
    const objtype = ruleFlag(fact.id.kind, "defaclObjtype");
    if (objtype === undefined) continue;
    // a created object whose fact is absent from the projected target (its add
    // was effectively reverted) has no hygiene to do
    if (!projectedDesired.has(fact.id)) continue;
    // owner is now an edge, not a payload field (move 2)
    const ownerEdge = projectedDesired
      .outgoingEdges(fact.id)
      .find((e) => e.kind === "owner");
    const owner =
      ownerEdge?.to.kind === "role"
        ? (ownerEdge.to as { kind: "role"; name: string }).name
        : undefined;
    if (typeof owner !== "string") continue;
    const schema = (fact.id as { schema?: string }).schema ?? null;
    for (const dp of projectedDesired.facts()) {
      if (dp.id.kind !== "defaultPrivilege") continue;
      const dpid = dp.id as {
        role: string;
        schema: string | null;
        objtype: string;
        grantee: string;
      };
      if (dpid.role !== owner || dpid.objtype !== objtype) continue;
      if (dpid.schema != null && dpid.schema !== schema) continue;
      if (dpid.grantee === owner) continue; // the owner's implicit entry IS the default
      const aclId: StableId = {
        kind: "acl",
        target: fact.id,
        grantee: dpid.grantee,
      };
      // an explicit acl in the PROJECTED target recreates the grant with a
      // REVOKE-first, so hygiene would be redundant (and a filtered acl is
      // correctly absent here → hygiene still fires)
      if (projectedDesired.has(aclId)) continue;
      pushAction(
        "alter",
        {
          sql: `REVOKE ALL ON ${grantTarget(fact.id)} FROM ${dpid.grantee === "PUBLIC" ? "PUBLIC" : qid(dpid.grantee)}`,
          consumes:
            dpid.grantee === "PUBLIC"
              ? []
              : [{ kind: "role", name: dpid.grantee } as StableId],
        },
        { consumes: [fact.id] },
      );
    }
  }

  // drops (suppressed children fold into their root's destroys)
  const destroysByRoot = new Map<string, StableId[]>();
  for (const [key, fact] of removed) {
    const root = dropRootOf.get(key) as string;
    const list = destroysByRoot.get(root) ?? [];
    list.push(fact.id);
    destroysByRoot.set(root, list);
  }
  for (const [key, fact] of removed) {
    if (dropRootOf.get(key) !== key) continue; // suppressed
    if (replaceIds.has(key)) continue; // replace handles its own drop
    const spec = rulesFor(fact.id.kind).drop(fact);
    const destroyList = destroysByRoot.get(key) ?? [fact.id];
    pushAction("drop", spec, {
      consumes: fact.parent !== undefined ? [fact.parent] : [],
      // the root fact leads: it is the action's subject (tie-break, locks)
      destroys: [fact.id, ...destroyList.filter((id) => encodeId(id) !== key)],
    });
  }

  // replaces: drop old + create new (+ recreate unchanged descendants)
  const recreatedByReplace = new Set<string>();
  for (const key of replaceIds) {
    const oldFact = source.getByEncoded(key) as Fact;
    // the replacement is rendered from the PROJECTED plan target, so a filtered
    // attribute change or child fact is not baked into the recreated SQL (P1 #1)
    const newFact = projectedDesired.getByEncoded(key) as Fact;
    // old descendants die with the drop
    const oldDescendants: StableId[] = [oldFact.id];
    const walkOld = (id: StableId): void => {
      for (const child of source.childrenOf(id)) {
        oldDescendants.push(child.id);
        walkOld(child.id);
      }
    };
    walkOld(oldFact.id);
    const dropSpec = rulesFor(oldFact.id.kind).drop(oldFact);
    pushAction("drop", dropSpec, {
      consumes: oldFact.parent !== undefined ? [oldFact.parent] : [],
      destroys: oldDescendants,
    });
    emitCreate(newFact, projectedDesired);
    // recreate surviving descendants from the PROJECTED plan target (satellites,
    // sub-facts). Descendants with their own attribute deltas are covered: the
    // create renders the projected payload, so their alters are skipped; a
    // descendant whose add was policy-filtered is absent and so not recreated.
    const recreate = (id: StableId): void => {
      for (const child of projectedDesired.childrenOf(id)) {
        const childKey = encodeId(child.id);
        if (added.has(childKey)) continue; // already created via add delta
        recreatedByReplace.add(childKey);
        emitCreate(child, projectedDesired);
        recreate(child.id);
      }
    };
    recreate(newFact.id);
  }

  // in-place alters (skipped for facts a replace already recreated)
  for (const [key, sets] of setsByFact) {
    if (replaceIds.has(key) || recreatedByReplace.has(key)) continue;
    // alters also render against the PROJECTED plan target: an alter that inlines
    // a child reference (ALTER COLUMN … TYPE … re-applying the desired DEFAULT,
    // REPLICA IDENTITY USING a desired index) must not surface a filtered-out
    // child (review P1 #1). `source` stays as the from-state for the rule.
    const fact = projectedDesired.get(sets[0]!.id) as Fact;
    const rules = rulesFor(fact.id.kind);
    for (const s of sets) {
      const attrRule = rules.attributes[s.attr];
      if (attrRule === undefined || attrRule === "replace") continue;
      const specs = attrRule.alter(
        fact,
        s.from,
        s.to,
        projectedDesired,
        source,
      );
      for (const spec of Array.isArray(specs) ? specs : [specs]) {
        pushAction("alter", spec, { consumes: [fact.id] });
      }
    }
  }

  // role-rename changed-pair mutations (review P2, fourth follow-up): the role
  // rename carries the fact's IDENTITY by OID, so emit only the PAYLOAD change
  // against the post-rename id — never old-name teardown + new-name create.
  // The renamed roles the new id references (`orderingConsumes`) order every
  // emitted action AFTER the `ALTER ROLE … RENAME` that produces them. We must
  // NOT consume the carried fact id itself: it is neither in `source` nor
  // produced by any action, so buildActionGraph would flag it missing.
  for (const { toFact, fromPayload, orderingConsumes } of changedRoleFacts) {
    const rules = rulesFor(toFact.id.kind);
    const alterSpecs: ActionSpec[] = [];
    let needsReplace = false;
    const attrs = new Set([
      ...Object.keys(fromPayload),
      ...Object.keys(toFact.payload),
    ]);
    for (const attr of attrs) {
      const from = fromPayload[attr];
      const to = toFact.payload[attr];
      const canon = (v: typeof from): string =>
        v === undefined ? " absent" : canonicalize(v);
      if (canon(from) === canon(to)) continue;
      const attrRule = rules.attributes[attr];
      if (attrRule === undefined || attrRule === "replace") {
        // replace-shaped attr (acl/defaultPrivilege): the whole fact is replaced
        needsReplace = true;
        continue;
      }
      const specs = attrRule.alter(toFact, from, to, projectedDesired, source);
      alterSpecs.push(...(Array.isArray(specs) ? specs : [specs]));
    }
    if (needsReplace) {
      // drop+create against the carried (post-rename) id. The drop rule reads
      // only fact.id (no `source` lookup), so it works although `to` is absent
      // from source; "destroy before re-produce" orders the drop before create.
      pushAction("drop", rules.drop(toFact), {
        destroys: [toFact.id],
        consumes: orderingConsumes,
      });
      const createSpecs = rules.create(
        toFact,
        projectedDesired,
        paramsFor(toFact),
      );
      createSpecs.forEach((spec, i) => {
        pushAction("create", spec, {
          produces: i === 0 ? [toFact.id] : [],
          consumes: [...(i === 0 ? [] : [toFact.id]), ...orderingConsumes],
        });
      });
    } else {
      for (const spec of alterSpecs) {
        pushAction("alter", spec, { consumes: orderingConsumes });
      }
    }
  }

  // owner-edge changes: emit ALTER … OWNER TO from link/unlink deltas
  // (move 2: owner is now an edge, not a payload attribute)
  {
    // collect old owner roles per fact so the link action can release them
    const oldOwnerByFact = new Map<string, StableId>();
    for (const delta of deltas) {
      if (delta.verb !== "unlink" || delta.edge.kind !== "owner") continue;
      oldOwnerByFact.set(encodeId(delta.edge.from), delta.edge.to);
    }
    // `roleRenameMap` (source role name → dest) is built once above and reused:
    // a table owned by `old` and renamed alongside keeps the SAME owner OID,
    // surfacing in `desired` as `new` — so the owner is CARRIED by the two
    // renames, not changed.
    // Accepted renames carry ownership: `ALTER … RENAME` never changes the
    // owner, so the renamed subtree's owner edge resurfaces as a fresh link in
    // the desired base even when nothing changed. Map each renamed-to id to the
    // owner its rename-from counterpart held in source — projected THROUGH any
    // accepted role rename, so a table+owner-role pair both renamed reads as an
    // unchanged owner (the renames carry it; no `ALTER … OWNER TO`, and no
    // rename/rename cycle — review P1 #2). A genuinely changed owner still emits.
    // Subtree ids zip by index — the rename matched on a structural rollup.
    const renamedOwner = new Map<string, string | null>();
    // and the OLD owner's StableId, so a genuinely-changed owner's link action
    // can `releases` it (the source-side unlink is keyed by the OLD id, which the
    // destination link never looks up — review P1 #1: drop old role too early).
    const renamedOwnerId = new Map<string, StableId>();
    for (const { from, to } of acceptedRenames) {
      const srcIds = subtreeIds(source, from.id);
      const dstIds = subtreeIds(desired, to.id);
      for (let i = 0; i < dstIds.length; i++) {
        const srcId = srcIds[i];
        const dstId = dstIds[i];
        if (srcId === undefined || dstId === undefined) continue;
        const ownerEdge = source
          .outgoingEdges(srcId)
          .find((e) => e.kind === "owner");
        if (ownerEdge?.to.kind !== "role") {
          renamedOwner.set(encodeId(dstId), null);
          continue;
        }
        const srcOwnerName = (ownerEdge.to as { name: string }).name;
        renamedOwner.set(
          encodeId(dstId),
          roleRenameMap.get(srcOwnerName) ?? srcOwnerName,
        );
        renamedOwnerId.set(encodeId(dstId), ownerEdge.to);
      }
    }
    for (const delta of deltas) {
      if (delta.verb !== "link" || delta.edge.kind !== "owner") continue;
      const objId = delta.edge.from;
      const objKey = encodeId(objId);
      // Created objects need this too: create no longer sets the owner (move 2),
      // so a fresh object owned by a non-applier role needs an explicit
      // ALTER … OWNER TO, ordered after its create (consumes: [objId]) and after
      // the role. An owner role projected out of the view has no edge here (it
      // was pruned), so the object is left applier-owned — skipAuthorization
      // elimination falls out for free.
      const fact = desired.get(objId);
      if (!fact) continue;
      const ownerAlterPrefix = ruleFlag(fact.id.kind, "ownerAlterPrefix");
      if (!ownerAlterPrefix) continue;
      const prefix = ownerAlterPrefix(fact);
      const newRoleId = delta.edge.to;
      if (newRoleId.kind !== "role") continue;
      const roleName = (newRoleId as { kind: "role"; name: string }).name;
      // ownership carried unchanged by an accepted OBJECT rename (the object id
      // changed; renamedOwner maps it through any role rename) — no action
      if (renamedOwner.get(objKey) === roleName) continue;
      // ownership carried by an accepted ROLE rename on a STABLE object: the
      // owner edge relinks r1→r2 on the same id, but PostgreSQL carries it by
      // OID. Skip BEFORE the capability check — there is no owner action to
      // authorize (third follow-up review P1: role-only rename cycle / false
      // capability failure). The general role-rename carry seam decided this.
      if (carriedOwnerLinks.has(ownerEdgeKey(objId, newRoleId))) continue;
      // Owner residue (move 6): `ALTER … OWNER TO R` requires the applier to be
      // a superuser or a member of R. If a capability is supplied and the
      // applier cannot, fail fast at plan time with an actionable message —
      // surfaced before any statement runs, and avoiding a non-converging
      // "leave it applier-owned" (the owner is acldefault-relative). Unset only
      // for owner CHANGES/creates (this is an owner link delta), not pre-existing
      // unchanged ownership.
      if (
        options?.capability !== undefined &&
        !canSetOwner(options.capability, roleName)
      ) {
        throw new Error(
          `capability: cannot set owner of ${encodeId(objId)} to role "${roleName}" — applier "${options.capability.role}" is not a superuser or a member of that role; grant membership or apply as a member/superuser`,
        );
      }
      // for an accepted rename the source-side owner unlink is keyed by the OLD
      // id, so `oldOwnerByFact` (keyed by the link's `from`, i.e. the NEW id) has
      // no entry — fall back to the owner the renamed subtree carried in source
      // (review P1 #1), so the release edge orders this before the old role drop.
      const oldRoleId =
        oldOwnerByFact.get(objKey) ?? renamedOwnerId.get(objKey);
      pushAction(
        "alter",
        {
          sql: `${prefix} OWNER TO ${qid(roleName)}`,
          consumes: [newRoleId],
          ...(oldRoleId !== undefined ? { releases: [oldRoleId] } : {}),
        },
        { consumes: [objId] },
      );
    }
  }

  // ── graph edges + deterministic order ─────────────────────────────────
  // edge build + requirement checks and the tie-break key are extracted to
  // ./internal.ts (Item 7); they read only the emitted actions + the
  // producer/destroyer indexes + the two fact bases.
  const edges = buildActionGraph(
    actions,
    producerOf,
    destroyerOf,
    source,
    desired,
    renameActionIndices,
  );

  const order = topoSort(
    actions.length,
    edges,
    (i) => actionTieKey(actions, i),
    (i) => (actions[i] as Action).sql,
  );

  // ── compaction/segment boundary for commitBoundaryAfter actions (§3.8) ──
  // Mark the FIRST graph successor of each commitBoundaryAfter action with
  // newSegmentBefore. apply.ts ALREADY closes the transactional segment
  // unconditionally after a commitBoundaryAfter action (review #6), so this
  // flag is redundant for APPLY correctness; its load-bearing role now is
  // COMPACTION PROTECTION — internal.ts refuses to fold a clause into a CREATE
  // across a newSegmentBefore boundary, so the consumer cannot be merged back
  // before the commit. Do NOT remove: this loop is the sole producer of
  // newSegmentBefore.
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

  // ── compaction (§3.6, stage 5 deliverable 4) ──────────────────────────
  // fold ADD COLUMN clauses into their bare CREATE TABLE. Safe iff every
  // graph predecessor of the folded action sits at or before the target —
  // i.e. no edge crosses the merge. Purely cosmetic: produces/consumes
  // merge, so ordering semantics and the proof are unchanged.
  // second cosmetic pass (§3.6): drop a replace's redundant drop when the
  // create reproduces the identical statement (e.g. ACL's self-resetting
  // grantActions). Runs on the already-folded list — disjoint from column folds.
  const finalActions =
    options?.compact !== false
      ? elideRedundantDrops(
          compactColumnFolds(
            orderedActions,
            order,
            edges,
            foldHints,
            acceptsFolds,
            positionOf,
          ),
          source,
        )
      : orderedActions;

  const safetyReport = computeSafetyReport(finalActions);

  return {
    formatVersion: 1,
    engineVersion: ENGINE_VERSION,
    source: { fingerprint: source.rootHash },
    target: { fingerprint: projectedDesired.rootHash },
    preamble: [{ name: "check_function_bodies", value: "off" }],
    deltas,
    filteredDeltas,
    ...(options?.policy ? { policy: options.policy } : {}),
    ...(options?.capability ? { capability: options.capability } : {}),
    ...(options?.profile ? { profile: options.profile } : {}),
    renameCandidates,
    actions: finalActions,
    safetyReport,
  };
}
