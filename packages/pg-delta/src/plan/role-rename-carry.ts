/**
 * Role-rename carry (third follow-up review, P2 — the Depth Module).
 *
 * PostgreSQL stores role references by OID, so `ALTER ROLE r1 RENAME TO r2`
 * carries every role-name-bearing fact automatically — the planner must not
 * re-issue DDL for them. Several stable ids embed role NAMES rather than OIDs:
 *
 *   - `owner` edges        (edge.to is a role)
 *   - `acl`                (grantee; target may itself be a role for comments)
 *   - `membership`         (role + member)
 *   - `userMapping`        (role)
 *   - `defaultPrivilege`   (role + grantee)
 *
 * A diff taken across an accepted role rename surfaces each of these as a
 * remove/add (or owner unlink/link) pair differing only by the renamed name.
 * Left alone they CHURN: a REVOKE for the old name, the rename, a GRANT for the
 * new name. The final state still converges, but the DDL is unnecessary, may
 * demand privileges a pure rename would not, and — for owner edges — produces a
 * dependency cycle (the owner action consumes the produced role and releases
 * the destroyed one). See the third follow-up review P1/P2.
 *
 * This is the single seam that answers "does an accepted role rename carry this
 * delta?", so the planner cancels/skips carried deltas in ONE place instead of
 * spreading role-name knowledge across emission branches.
 */
import type { Delta } from "../core/diff.ts";
import type { Fact } from "../core/fact.ts";
import { canonicalize } from "../core/hash.ts";
import { encodeId, type StableId } from "../core/stable-id.ts";
import { relabelRoleNames } from "./identity-normalize.ts";

// Preserve the existing internal import surface until I1b retires carry.
export {
  buildRoleRenameMap,
  relabelRoleNames,
  ROLE_NAME_BEARING_KINDS,
} from "./identity-normalize.ts";

/** Every role NAME a stable id embeds (recursing into comment/acl/securityLabel
 *  targets). Used to order a post-rename mutation AFTER the role rename by
 *  consuming the renamed role(s) the id references. */
export function roleNamesIn(id: StableId): Set<string> {
  const names = new Set<string>();
  const walk = (x: StableId): void => {
    switch (x.kind) {
      case "role":
        names.add(x.name);
        break;
      case "membership":
        names.add(x.role);
        names.add(x.member);
        break;
      case "userMapping":
        names.add(x.role);
        break;
      case "defaultPrivilege":
        names.add(x.role);
        names.add(x.grantee);
        break;
      case "acl":
        names.add(x.grantee);
        walk(x.target);
        break;
      case "comment":
      case "securityLabel":
        walk(x.target);
        break;
      default:
        break;
    }
  };
  walk(id);
  return names;
}

/** Encoded key for an `owner` edge — the planner's owner-emission loop skips
 *  links whose key is carried. */
export function ownerEdgeKey(from: StableId, to: StableId): string {
  return `${encodeId(from)}|owner|${encodeId(to)}`;
}

export interface RoleRenameCarry {
  /** encoded ids of remove+add FACT deltas the rename carries UNCHANGED — cancel
   *  these from the planner's `removed`/`added` worklists so no drop/create emits */
  carriedFactKeys: Set<string>;
  /** owner LINK edge keys the rename carries — the owner-emission loop skips
   *  these (the role rename already relabels the owner by OID) */
  carriedOwnerLinks: Set<string>;
  /** role-name-bearing facts whose IDENTITY the rename carries but whose PAYLOAD
   *  also changed: `from` (old-name remove) → `to` (new-name add). The planner
   *  cancels both and emits a post-rename MUTATION on `to` (alter, or drop+create
   *  for replace-shaped attrs) instead of old-name teardown + new-name create
   *  (review P2, fourth follow-up). */
  changedFacts: Array<{ from: StableId; to: StableId }>;
}

/**
 * Determine which deltas an accepted set of role renames carries. A delta is
 * carried iff relabeling its role-name references yields the EXACT counterpart
 * on the other side:
 *
 *   - a `remove` fact whose relabeled id matches an `add` fact with an
 *     identical payload, or
 *   - an owner `unlink` whose relabeled target matches an owner `link` on the
 *     SAME object.
 *
 * A pair whose payload ALSO changed is returned as a `changedFacts` entry: the
 * rename carries the identity, and the planner mutates the post-rename id (it
 * does not tear down the old name and recreate the new one).
 */
export function computeRoleRenameCarry(
  deltas: readonly Delta[],
  rename: ReadonlyMap<string, string>,
): RoleRenameCarry {
  const carriedFactKeys = new Set<string>();
  const carriedOwnerLinks = new Set<string>();
  const changedFacts: Array<{ from: StableId; to: StableId }> = [];
  if (rename.size === 0)
    return { carriedFactKeys, carriedOwnerLinks, changedFacts };

  const addByKey = new Map<string, Fact>();
  const ownerLinkKeys = new Set<string>();
  for (const d of deltas) {
    if (d.verb === "add") addByKey.set(encodeId(d.fact.id), d.fact);
    else if (d.verb === "link" && d.edge.kind === "owner")
      ownerLinkKeys.add(ownerEdgeKey(d.edge.from, d.edge.to));
  }

  for (const d of deltas) {
    if (d.verb === "remove") {
      const sourceKey = encodeId(d.fact.id);
      const relabeled = relabelRoleNames(d.fact.id, rename);
      const relabeledKey = encodeId(relabeled);
      if (relabeledKey === sourceKey) continue; // references no renamed role
      const add = addByKey.get(relabeledKey);
      if (add === undefined) continue; // no counterpart → genuine drop, not carried
      if (canonicalize(add.payload) === canonicalize(d.fact.payload)) {
        // identical payload → the rename carries it wholesale; no DDL
        carriedFactKeys.add(sourceKey);
        carriedFactKeys.add(relabeledKey);
      } else {
        // identity carried, payload changed → mutate the post-rename id
        changedFacts.push({ from: d.fact.id, to: add.id });
      }
    } else if (d.verb === "unlink" && d.edge.kind === "owner") {
      const to = d.edge.to;
      if (to.kind !== "role") continue;
      const newName = rename.get((to as { name: string }).name);
      if (newName === undefined) continue;
      const linkKey = ownerEdgeKey(d.edge.from, {
        kind: "role",
        name: newName,
      });
      if (ownerLinkKeys.has(linkKey)) carriedOwnerLinks.add(linkKey);
    }
  }

  return { carriedFactKeys, carriedOwnerLinks, changedFacts };
}
