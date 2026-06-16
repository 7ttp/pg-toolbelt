/** Rule definitions for routines: functions / procedures and aggregates. */
import type { Fact } from "../../core/fact.ts";
import { lit, qid, rel, routineSig } from "../render.ts";
import type { KindRules } from "../rules.ts";
import { aggSig, p, str } from "./helpers.ts";

/** FUNCTION / PROCEDURE keyword from the routine's own id kind — never a
 *  payload field (the kind is part of the address, P0). */
const routineKeyword = (fact: Fact): "FUNCTION" | "PROCEDURE" =>
  fact.id.kind === "procedure" ? "PROCEDURE" : "FUNCTION";

// Functions and procedures share one rule implementation: identical
// create/drop/rename/owner shapes, differing only by the keyword derived from
// the id kind. Registered under both `function` and `procedure` keys below.
const routineRule: KindRules = {
  weight: 8,
  cascadesToChildren: true,
  rebuildable: true,
  defaclObjtype: "f",
  rename: (fact, to) => ({
    sql: `ALTER ROUTINE ${routineSig(fact.id as { schema: string; name: string; args: string[] })} RENAME TO ${qid((to as { name: string }).name)}`,
  }),
  create: (fact) => [
    {
      sql: str(p(fact, "def")),
    },
  ],
  drop: (fact) => {
    const id = fact.id as { schema: string; name: string; args: string[] };
    return { sql: `DROP ${routineKeyword(fact)} ${routineSig(id)}` };
  },
  ownerAlterPrefix: (fact) => {
    const id = fact.id as { schema: string; name: string; args: string[] };
    return `ALTER ${routineKeyword(fact)} ${routineSig(id)}`;
  },
  attributes: {
    // return-type/strictness changes refuse CREATE OR REPLACE; replace +
    // forced dependent rebuild is always safe
    def: "replace",
  },
};

export const routineRules: Record<string, KindRules> = {
  function: routineRule,
  procedure: routineRule,

  aggregate: {
    weight: 9,
    cascadesToChildren: true,
    defaclObjtype: "f",
    create: (fact) => {
      const id = fact.id as { schema: string; name: string; args: string[] };
      const parts = [
        `SFUNC = ${str(p(fact, "sfunc"))}`,
        `STYPE = ${str(p(fact, "stype"))}`,
      ];
      const finalfunc = p(fact, "finalfunc");
      if (finalfunc != null) parts.push(`FINALFUNC = ${str(finalfunc)}`);
      const initcond = p(fact, "initcond");
      if (initcond != null) parts.push(`INITCOND = ${lit(str(initcond))}`);
      if (str(p(fact, "aggKind")) === "h") parts.push("HYPOTHETICAL");
      return [
        {
          sql: `CREATE AGGREGATE ${rel(id.schema, id.name)}(${aggSig(fact)}) (${parts.join(", ")})`,
        },
      ];
    },
    drop: (fact) => {
      const id = fact.id as { schema: string; name: string; args: string[] };
      return {
        sql: `DROP AGGREGATE ${rel(id.schema, id.name)}(${aggSig(fact)})`,
      };
    },
    ownerAlterPrefix: (fact) => {
      const id = fact.id as { schema: string; name: string; args: string[] };
      return `ALTER AGGREGATE ${rel(id.schema, id.name)}(${aggSig(fact)})`;
    },
    attributes: {
      aggKind: "replace",
      numDirectArgs: "replace",
      sfunc: "replace",
      stype: "replace",
      finalfunc: "replace",
      initcond: "replace",
    },
  },
};
