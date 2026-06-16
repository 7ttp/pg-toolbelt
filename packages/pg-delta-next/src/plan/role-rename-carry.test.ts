/**
 * Unit tests for the role-rename carry Module (third follow-up review P2).
 * Pure functions — no Docker / database required.
 */
import { describe, expect, test } from "bun:test";
import type { Delta } from "../core/diff.ts";
import { encodeId, type StableId } from "../core/stable-id.ts";
import {
  buildRoleRenameMap,
  computeRoleRenameCarry,
  ownerEdgeKey,
  relabelRoleNames,
} from "./role-rename-carry.ts";

const rename = new Map([["r1", "r2"]]);

describe("relabelRoleNames", () => {
  test("remaps a bare role id", () => {
    expect(relabelRoleNames({ kind: "role", name: "r1" }, rename)).toEqual({
      kind: "role",
      name: "r2",
    });
  });

  test("remaps acl grantee, leaves the object target", () => {
    const id: StableId = {
      kind: "acl",
      target: { kind: "table", schema: "app", name: "t" },
      grantee: "r1",
    };
    expect(relabelRoleNames(id, rename)).toEqual({
      kind: "acl",
      target: { kind: "table", schema: "app", name: "t" },
      grantee: "r2",
    });
  });

  test("remaps both ends of a membership", () => {
    const id: StableId = { kind: "membership", role: "r1", member: "r1" };
    expect(relabelRoleNames(id, rename)).toEqual({
      kind: "membership",
      role: "r2",
      member: "r2",
    });
  });

  test("remaps defaultPrivilege role + grantee, keeps schema/objtype", () => {
    const id: StableId = {
      kind: "defaultPrivilege",
      role: "r1",
      schema: "app",
      objtype: "r",
      grantee: "r1",
    };
    expect(relabelRoleNames(id, rename)).toEqual({
      kind: "defaultPrivilege",
      role: "r2",
      schema: "app",
      objtype: "r",
      grantee: "r2",
    });
  });

  test("remaps userMapping role, keeps server", () => {
    const id: StableId = { kind: "userMapping", server: "srv", role: "r1" };
    expect(relabelRoleNames(id, rename)).toEqual({
      kind: "userMapping",
      server: "srv",
      role: "r2",
    });
  });

  test("recurses into a comment ON a role", () => {
    const id: StableId = {
      kind: "comment",
      target: { kind: "role", name: "r1" },
    };
    expect(relabelRoleNames(id, rename)).toEqual({
      kind: "comment",
      target: { kind: "role", name: "r2" },
    });
  });

  test("leaves an id that references no renamed role unchanged", () => {
    const id: StableId = { kind: "table", schema: "app", name: "t" };
    expect(encodeId(relabelRoleNames(id, rename))).toBe(encodeId(id));
    const dpOther: StableId = {
      kind: "defaultPrivilege",
      role: "other",
      schema: "app",
      objtype: "r",
      grantee: "PUBLIC",
    };
    expect(encodeId(relabelRoleNames(dpOther, rename))).toBe(encodeId(dpOther));
  });
});

describe("buildRoleRenameMap", () => {
  test("collects role↔role renames only", () => {
    const map = buildRoleRenameMap([
      {
        from: { id: { kind: "role", name: "r1" }, payload: {} },
        to: { id: { kind: "role", name: "r2" }, payload: {} },
      },
      {
        from: {
          id: { kind: "table", schema: "app", name: "old" },
          payload: {},
        },
        to: { id: { kind: "table", schema: "app", name: "new" }, payload: {} },
      },
    ]);
    expect([...map]).toEqual([["r1", "r2"]]);
  });
});

describe("computeRoleRenameCarry", () => {
  const dp = (role: string): StableId => ({
    kind: "defaultPrivilege",
    role,
    schema: "app",
    objtype: "r",
    grantee: "PUBLIC",
  });
  const table: StableId = { kind: "table", schema: "app", name: "t" };

  test("carries an identical default-privilege remove/add pair", () => {
    const deltas: Delta[] = [
      {
        verb: "remove",
        fact: {
          id: dp("r1"),
          payload: { privileges: ["SELECT"], grantable: [] },
        },
      },
      {
        verb: "add",
        fact: {
          id: dp("r2"),
          payload: { privileges: ["SELECT"], grantable: [] },
        },
      },
    ];
    const { carriedFactKeys } = computeRoleRenameCarry(deltas, rename);
    expect(carriedFactKeys.has(encodeId(dp("r1")))).toBe(true);
    expect(carriedFactKeys.has(encodeId(dp("r2")))).toBe(true);
  });

  test("does NOT carry a pair whose payload also changed", () => {
    const deltas: Delta[] = [
      {
        verb: "remove",
        fact: {
          id: dp("r1"),
          payload: { privileges: ["SELECT"], grantable: [] },
        },
      },
      {
        verb: "add",
        fact: {
          id: dp("r2"),
          payload: { privileges: ["INSERT"], grantable: [] },
        },
      },
    ];
    const { carriedFactKeys } = computeRoleRenameCarry(deltas, rename);
    expect(carriedFactKeys.size).toBe(0);
  });

  test("carries an owner unlink/link pair on a stable object", () => {
    const deltas: Delta[] = [
      {
        verb: "unlink",
        edge: { from: table, to: { kind: "role", name: "r1" }, kind: "owner" },
      },
      {
        verb: "link",
        edge: { from: table, to: { kind: "role", name: "r2" }, kind: "owner" },
      },
    ];
    const { carriedOwnerLinks } = computeRoleRenameCarry(deltas, rename);
    expect(
      carriedOwnerLinks.has(ownerEdgeKey(table, { kind: "role", name: "r2" })),
    ).toBe(true);
  });

  test("does NOT carry an owner change to a non-renamed role", () => {
    const deltas: Delta[] = [
      {
        verb: "unlink",
        edge: { from: table, to: { kind: "role", name: "r1" }, kind: "owner" },
      },
      {
        verb: "link",
        edge: { from: table, to: { kind: "role", name: "r3" }, kind: "owner" },
      },
    ];
    const { carriedOwnerLinks } = computeRoleRenameCarry(deltas, rename);
    expect(carriedOwnerLinks.size).toBe(0);
  });

  test("empty rename map carries nothing", () => {
    const deltas: Delta[] = [
      { verb: "remove", fact: { id: dp("r1"), payload: {} } },
      { verb: "add", fact: { id: dp("r2"), payload: {} } },
    ];
    const { carriedFactKeys, carriedOwnerLinks } = computeRoleRenameCarry(
      deltas,
      new Map(),
    );
    expect(carriedFactKeys.size).toBe(0);
    expect(carriedOwnerLinks.size).toBe(0);
  });
});
