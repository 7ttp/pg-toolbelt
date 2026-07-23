import { describe, expect, test } from "bun:test";
import { buildFactBase, type Fact } from "../core/fact.ts";
import type { StableId } from "../core/stable-id.ts";
import { plan } from "./plan.ts";

const schema: StableId = { kind: "schema", name: "app" };
const table: StableId = { kind: "table", schema: "app", name: "docs" };
const policy: StableId = {
  kind: "policy",
  schema: "app",
  table: "docs",
  name: "docs_read",
};

const rolePayload = () => ({
  superuser: false,
  inherit: true,
  createRole: false,
  createDb: false,
  login: false,
  replication: false,
  bypassRls: false,
  config: ["statement_timeout=42424ms"],
});

const policyFact = (role: string): Fact => ({
  id: policy,
  parent: table,
  payload: {
    cmd: "r",
    permissive: true,
    roles: [role],
    usingExpr: "true",
    checkExpr: null,
  },
});

const rolePolicyBase = (role: string, includeRole = true) =>
  buildFactBase(
    [
      ...(includeRole
        ? [
            {
              id: { kind: "role", name: role } as StableId,
              payload: rolePayload(),
            },
          ]
        : []),
      { id: schema, payload: {} },
      { id: table, parent: schema, payload: { persistence: "p" } },
      policyFact(role),
    ],
    [],
  );

describe("pre-diff role identity normalization", () => {
  test("removes policy-reference churn before planning", () => {
    const thePlan = plan(rolePolicyBase("role_a"), rolePolicyBase("role_b"), {
      renames: "auto",
      compact: false,
    });

    expect(thePlan.actions.map((action) => action.sql)).toMatchInlineSnapshot(`
      [
        "ALTER ROLE "role_a" RENAME TO "role_b"",
      ]
    `);
    expect(thePlan.deltas).toEqual([]);
  });

  test("still releases a genuinely dropped role before DROP ROLE", () => {
    const thePlan = plan(
      rolePolicyBase("role_a"),
      rolePolicyBase("PUBLIC", false),
      { renames: "auto", compact: false },
    );

    const alterPolicy = thePlan.actions.findIndex((action) =>
      action.sql.startsWith('ALTER POLICY "docs_read"'),
    );
    const dropRole = thePlan.actions.findIndex((action) =>
      action.sql.includes('DROP ROLE "role_a"'),
    );
    expect(alterPolicy).toBeGreaterThanOrEqual(0);
    expect(dropRole).toBeGreaterThanOrEqual(0);
    expect(alterPolicy).toBeLessThan(dropRole);
  });
});
