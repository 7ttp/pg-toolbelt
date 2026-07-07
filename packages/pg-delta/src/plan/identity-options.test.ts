/**
 * Identity columns must reproduce their backing sequence's options (PR #299
 * review, supabase/pg-toolbelt). The identity payload only carried
 * {generation, sequence}, so a column declared
 * `GENERATED … AS IDENTITY (START WITH 10 INCREMENT BY 5 …)` was recreated as a
 * bare identity (default sequence parameters), and an options-only change
 * planned nothing. Pure rule/diff level — no DB.
 *
 * Default sequence parameters still render as a bare `GENERATED … AS IDENTITY`
 * so an ordinary identity column does not churn.
 */
import { describe, expect, test } from "bun:test";
import { buildFactBase, type Fact } from "../core/fact.ts";
import type { StableId } from "../core/stable-id.ts";
import { plan } from "./plan.ts";

const schemaFact: Fact = {
  id: { kind: "schema", name: "app" },
  payload: { owner: "test" },
};
const tableId: StableId = { kind: "table", schema: "app", name: "t" };
const tableFact: Fact = {
  id: tableId,
  parent: { kind: "schema", name: "app" },
  payload: { owner: "test", persistence: "p" },
};
const colId: StableId = {
  kind: "column",
  schema: "app",
  table: "t",
  name: "id",
};
const colFact = (options: Record<string, unknown>): Fact => ({
  id: colId,
  parent: tableId,
  payload: {
    type: "integer",
    notNull: false,
    collation: null,
    generatedExpr: null,
    identity: {
      generation: "a",
      sequence: { schema: "app", name: "t_id_seq" },
      options: {
        increment: "1",
        start: "1",
        minValue: "1",
        maxValue: "2147483647",
        cache: "1",
        cycle: false,
        ...options,
      },
    },
  },
});
const base = (extra: Fact[]) =>
  buildFactBase([schemaFact, tableFact, ...extra], []);

describe("identity column sequence options", () => {
  test("non-default options render in the GENERATED … AS IDENTITY clause", () => {
    const sql = plan(base([]), base([colFact({ increment: "5", start: "10" })]))
      .actions.map((a) => a.sql)
      .join("\n");
    expect(sql).toContain("GENERATED ALWAYS AS IDENTITY (");
    expect(sql).toContain("INCREMENT BY 5");
    expect(sql).toContain("START WITH 10");
  });

  test("all-default options render a bare GENERATED … AS IDENTITY", () => {
    const sql = plan(base([]), base([colFact({})]))
      .actions.map((a) => a.sql)
      .join("\n");
    expect(sql).toContain("GENERATED ALWAYS AS IDENTITY");
    expect(sql).not.toContain("INCREMENT BY");
    expect(sql).not.toContain("(");
  });

  test("an options-only change is an in-place ALTER COLUMN SET", () => {
    const sql = plan(
      base([colFact({})]),
      base([colFact({ increment: "5", cache: "20" })]),
    ).actions.map((a) => a.sql);
    expect(sql).toContain(
      `ALTER TABLE "app"."t" ALTER COLUMN "id" SET INCREMENT BY 5`,
    );
    expect(sql).toContain(
      `ALTER TABLE "app"."t" ALTER COLUMN "id" SET CACHE 20`,
    );
  });

  test("a cycle flip alters in place", () => {
    const sql = plan(
      base([colFact({})]),
      base([colFact({ cycle: true })]),
    ).actions.map((a) => a.sql);
    expect(sql).toContain(`ALTER TABLE "app"."t" ALTER COLUMN "id" SET CYCLE`);
  });
});
