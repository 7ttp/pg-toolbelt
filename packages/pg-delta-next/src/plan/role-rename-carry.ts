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

/** Build the source-role-name → dest-role-name map from accepted renames.
 *  Only role↔role renames contribute; object renames are carried elsewhere. */
export function buildRoleRenameMap(
  acceptedRenames: ReadonlyArray<{ from: Fact; to: Fact }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const { from, to } of acceptedRenames) {
    if (from.id.kind === "role" && to.id.kind === "role") {
      map.set(
        (from.id as { name: string }).name,
        (to.id as { name: string }).name,
      );
    }
  }
  return map;
}

/** Remap every role NAME embedded in a stable id through an accepted role
 *  rename (source name → dest name); recurses into `target` for comment / acl /
 *  securityLabel (a comment or security label may be ON a role). Ids that embed
 *  no renamed role come back referentially unchanged in content. */
export function relabelRoleNames(
  id: StableId,
  rename: ReadonlyMap<string, string>,
): StableId {
  const remap = (name: string): string => rename.get(name) ?? name;
  switch (id.kind) {
    case "role":
      return { kind: "role", name: remap(id.name) };
    case "membership":
      return {
        kind: "membership",
        role: remap(id.role),
        member: remap(id.member),
      };
    case "userMapping":
      return { kind: "userMapping", server: id.server, role: remap(id.role) };
    case "defaultPrivilege":
      return {
        kind: "defaultPrivilege",
        role: remap(id.role),
        schema: id.schema,
        objtype: id.objtype,
        grantee: remap(id.grantee),
      };
    case "acl":
      return {
        kind: "acl",
        target: relabelRoleNames(id.target, rename),
        grantee: remap(id.grantee),
      };
    case "comment":
      return { kind: "comment", target: relabelRoleNames(id.target, rename) };
    case "securityLabel":
      return {
        kind: "securityLabel",
        target: relabelRoleNames(id.target, rename),
        provider: id.provider,
      };
    default:
      // object kinds (table, schema, function, …) embed no role name in their id
      return id;
  }
}

/** Encoded key for an `owner` edge — the planner's owner-emission loop skips
 *  links whose key is carried. */
export function ownerEdgeKey(from: StableId, to: StableId): string {
  return `${encodeId(from)}|owner|${encodeId(to)}`;
}

export interface RoleRenameCarry {
  /** encoded ids of remove+add FACT deltas the rename carries — cancel these
   *  from the planner's `removed`/`added` worklists so no drop/create emits */
  carriedFactKeys: Set<string>;
  /** owner LINK edge keys the rename carries — the owner-emission loop skips
   *  these (the role rename already relabels the owner by OID) */
  carriedOwnerLinks: Set<string>;
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
 * A pair whose payload ALSO changed is NOT carried — the role reference moves
 * by OID, but the content change still needs its own DDL, so the churn is left
 * intact (and still converges).
 */
export function computeRoleRenameCarry(
  deltas: readonly Delta[],
  rename: ReadonlyMap<string, string>,
): RoleRenameCarry {
  const carriedFactKeys = new Set<string>();
  const carriedOwnerLinks = new Set<string>();
  if (rename.size === 0) return { carriedFactKeys, carriedOwnerLinks };

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
      const relabeledKey = encodeId(relabelRoleNames(d.fact.id, rename));
      if (relabeledKey === sourceKey) continue; // references no renamed role
      const add = addByKey.get(relabeledKey);
      if (
        add !== undefined &&
        canonicalize(add.payload) === canonicalize(d.fact.payload)
      ) {
        carriedFactKeys.add(sourceKey);
        carriedFactKeys.add(relabeledKey);
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

  return { carriedFactKeys, carriedOwnerLinks };
}
