/**
 * Unit regressions for accepted-rename ownership modeling (second follow-up
 * review 2026-06-15, P1 #1 + #2). No Docker / database required.
 *
 * `ALTER … RENAME` changes IDENTITY, not OWNER: PostgreSQL preserves the owner
 * OID across a rename, and any genuine owner change is a separate owner action.
 * Two consequences the planner must honor:
 *
 *  1. owner CHANGE under a rename — the owner-link action must `releases` the
 *     OLD owner so the old role's drop sorts AFTER the reassignment, not before
 *     (else `DROP OWNED BY old; DROP ROLE old` drops the still-old-owned table).
 *  2. owner CARRIED through a role rename — when a table and its owner role are
 *     BOTH renamed, the owner is already correct after the two renames, so NO
 *     `ALTER … OWNER TO` is emitted and the rename actions must not form a cycle.
 */
import { describe, expect, test } from "bun:test";
import { buildFactBase } from "../core/fact.ts";
import { encodeId, type StableId } from "../core/stable-id.ts";
import { plan } from "./plan.ts";

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

const role1: StableId = { kind: "role", name: "r1" };
const role2: StableId = { kind: "role", name: "r2" };
const schema: StableId = { kind: "schema", name: "app" };
const oldTable: StableId = { kind: "table", schema: "app", name: "old_t" };
const newTable: StableId = { kind: "table", schema: "app", name: "new_t" };

describe("accepted rename + owner change (review P1 #1)", () => {
  test("ALTER … OWNER TO releases the old owner and sorts before its DROP", () => {
    // source: r1 owns app.old_t
    const source = buildFactBase(
      [
        { id: role1, payload: rolePayload(false) },
        { id: schema, payload: {} },
        { id: oldTable, parent: schema, payload: tablePayload() },
      ],
      [{ from: oldTable, to: role1, kind: "owner" }],
    );
    // desired: app.new_t (accepted rename of old_t) owned by a NEW role r2; r1 gone
    const desired = buildFactBase(
      [
        { id: role2, payload: rolePayload(true) },
        { id: schema, payload: {} },
        { id: newTable, parent: schema, payload: tablePayload() },
      ],
      [{ from: newTable, to: role2, kind: "owner" }],
    );

    const p = plan(source, desired, { renames: "auto", compact: false });

    const ownerActionIdx = p.actions.findIndex((a) =>
      a.sql.includes('OWNER TO "r2"'),
    );
    expect(ownerActionIdx).toBeGreaterThanOrEqual(0);
    const ownerAction = p.actions[ownerActionIdx]!;
    // the owner alter must release the old role so the drop is ordered after it
    expect(ownerAction.releases.map(encodeId)).toContain(encodeId(role1));

    const dropRoleIdx = p.actions.findIndex(
      (a) => a.verb === "drop" && a.sql.includes('DROP ROLE "r1"'),
    );
    expect(dropRoleIdx).toBeGreaterThanOrEqual(0);
    // ALTER … OWNER TO r2 must come BEFORE DROP ROLE r1 in the final order
    expect(ownerActionIdx).toBeLessThan(dropRoleIdx);
  });
});

describe("accepted table rename + accepted owner-role rename (review P1 #2)", () => {
  test("owner carried through both renames → no cycle, no spurious OWNER TO", () => {
    // r1 and r2 are structurally identical → the role rename is accepted too
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
        { id: role2, payload: rolePayload(false) },
        { id: schema, payload: {} },
        { id: newTable, parent: schema, payload: tablePayload() },
      ],
      [{ from: newTable, to: role2, kind: "owner" }],
    );

    let p!: ReturnType<typeof plan>;
    expect(() => {
      p = plan(source, desired, { renames: "auto", compact: false });
    }).not.toThrow();

    // both renames are emitted
    expect(p.actions.filter((a) => a.sql.includes("RENAME TO"))).toHaveLength(
      2,
    );
    // ownership is carried by the renames — no ALTER … OWNER TO is needed
    expect(p.actions.filter((a) => a.sql.includes("OWNER TO"))).toHaveLength(0);
  });
});
