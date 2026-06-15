/** Rule definitions for views, materialized views, and rewrite rules. */
import { qid, rel } from "../render.ts";
import type { KindRules } from "../rules.ts";
import { enabledPhrase, p, renameRule, str } from "./helpers.ts";

export const viewRules: Record<string, KindRules> = {
  view: {
    weight: 12,
    cascadesToChildren: true,
    rebuildable: true,
    defaclObjtype: "r",
    rename: renameRule((fact) => {
      const id = fact.id as { schema: string; name: string };
      return `ALTER VIEW ${rel(id.schema, id.name)}`;
    }),
    create: (fact) => {
      const id = fact.id as { schema: string; name: string };
      return [
        {
          sql: `CREATE VIEW ${rel(id.schema, id.name)} AS ${str(p(fact, "def"))}`,
        },
      ];
    },
    drop: (fact) => {
      const id = fact.id as { schema: string; name: string };
      return { sql: `DROP VIEW ${rel(id.schema, id.name)}` };
    },
    ownerAlterPrefix: (fact) => {
      const id = fact.id as { schema: string; name: string };
      return `ALTER VIEW ${rel(id.schema, id.name)}`;
    },
    attributes: {
      def: "replace",
    },
  },

  materializedView: {
    weight: 13,
    cascadesToChildren: true,
    rebuildable: true,
    defaclObjtype: "r",
    rename: renameRule((fact) => {
      const id = fact.id as { schema: string; name: string };
      return `ALTER MATERIALIZED VIEW ${rel(id.schema, id.name)}`;
    }),
    create: (fact) => {
      const id = fact.id as { schema: string; name: string };
      return [
        {
          sql: `CREATE MATERIALIZED VIEW ${rel(id.schema, id.name)} AS ${str(p(fact, "def"))}`,
        },
      ];
    },
    drop: (fact) => {
      const id = fact.id as { schema: string; name: string };
      return {
        sql: `DROP MATERIALIZED VIEW ${rel(id.schema, id.name)}`,
        dataLoss: "destructive",
      };
    },
    ownerAlterPrefix: (fact) => {
      const id = fact.id as { schema: string; name: string };
      return `ALTER MATERIALIZED VIEW ${rel(id.schema, id.name)}`;
    },
    attributes: {
      def: "replace",
    },
  },

  rule: {
    weight: 15,
    cascadesToChildren: true,
    rebuildable: true,
    create: (fact) => [{ sql: str(p(fact, "def")) }],
    drop: (fact) => {
      const id = fact.id as { schema: string; table: string; name: string };
      return {
        sql: `DROP RULE ${qid(id.name)} ON ${rel(id.schema, id.table)}`,
      };
    },
    attributes: {
      def: "replace",
      enabled: {
        alter: (fact, _from, to) => {
          const id = fact.id as { schema: string; table: string; name: string };
          return {
            sql: `ALTER TABLE ${rel(id.schema, id.table)} ${enabledPhrase(str(to))} RULE ${qid(id.name)}`,
          };
        },
      },
    },
  },
};
