/** Rule definitions for standalone indexes. */
import { rel } from "../render.ts";
import type { KindRules } from "../rules.ts";
import { p, renameRule, str } from "./helpers.ts";

export const indexRules: Record<string, KindRules> = {
  index: {
    weight: 14,
    cascadesToChildren: true,
    rebuildable: true,
    rename: renameRule((fact) => {
      const id = fact.id as { schema: string; name: string };
      return `ALTER INDEX ${rel(id.schema, id.name)}`;
    }),
    create: (fact, _view, params) => {
      const def = str(p(fact, "def"));
      if (params?.["concurrentIndexes"] === true) {
        // pg_get_indexdef never includes CONCURRENTLY (an execution choice,
        // not state); splice it into the canonical def
        return [
          {
            sql: def.replace(
              /^CREATE (UNIQUE )?INDEX /,
              "CREATE $1INDEX CONCURRENTLY ",
            ),
            lockClass: "shareUpdateExclusive",
            transactionality: "nonTransactional",
          },
        ];
      }
      return [{ sql: def }];
    },
    drop: (fact) => {
      const id = fact.id as { schema: string; name: string };
      return { sql: `DROP INDEX ${rel(id.schema, id.name)}` };
    },
    attributes: { def: "replace" },
  },
};
