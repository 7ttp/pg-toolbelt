/** Rule definitions for row-level security policies. */
import type { StableId } from "../../core/stable-id.ts";
import { qid, rel } from "../render.ts";
import type { KindRules } from "../rules.ts";
import { p, policySql, str } from "./helpers.ts";

export const policyRules: Record<string, KindRules> = {
  policy: {
    weight: 16,
    cascadesToChildren: true,
    rebuildable: true,
    rename: (fact, to) => {
      const id = fact.id as { schema: string; table: string; name: string };
      return {
        sql: `ALTER POLICY ${qid(id.name)} ON ${rel(id.schema, id.table)} RENAME TO ${qid((to as { name: string }).name)}`,
      };
    },
    create: (fact) => {
      const roles = (p(fact, "roles") as string[])
        .filter((r) => r !== "PUBLIC")
        .map((r): StableId => ({ kind: "role", name: r }));
      return [{ sql: policySql(fact), consumes: roles }];
    },
    drop: (fact) => {
      const id = fact.id as { schema: string; table: string; name: string };
      return {
        sql: `DROP POLICY ${qid(id.name)} ON ${rel(id.schema, id.table)}`,
      };
    },
    attributes: {
      usingExpr: {
        alter: (fact, _from, to) => {
          const id = fact.id as { schema: string; table: string; name: string };
          return {
            sql: `ALTER POLICY ${qid(id.name)} ON ${rel(id.schema, id.table)} USING (${str(to)})`,
          };
        },
      },
      checkExpr: {
        alter: (fact, _from, to) => {
          const id = fact.id as { schema: string; table: string; name: string };
          return {
            sql: `ALTER POLICY ${qid(id.name)} ON ${rel(id.schema, id.table)} WITH CHECK (${str(to)})`,
          };
        },
      },
      roles: {
        alter: (fact, _from, to) => {
          const id = fact.id as { schema: string; table: string; name: string };
          const roles = (to as string[]).map((r) =>
            r === "PUBLIC" ? "PUBLIC" : qid(r),
          );
          return {
            sql: `ALTER POLICY ${qid(id.name)} ON ${rel(id.schema, id.table)} TO ${roles.join(", ")}`,
          };
        },
      },
      cmd: "replace",
      permissive: "replace",
    },
  },
};
