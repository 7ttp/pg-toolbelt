/** Rule definitions for table triggers and event triggers. */
import type { StableId } from "../../core/stable-id.ts";
import { lit, qid, rel } from "../render.ts";
import type { ActionSpec, KindRules } from "../rules.ts";
import { enabledPhrase, p, str } from "./helpers.ts";

export const triggerRules: Record<string, KindRules> = {
  trigger: {
    weight: 15,
    cascadesToChildren: true,
    rebuildable: true,
    rename: (fact, to) => {
      const id = fact.id as { schema: string; table: string; name: string };
      return {
        sql: `ALTER TRIGGER ${qid(id.name)} ON ${rel(id.schema, id.table)} RENAME TO ${qid((to as { name: string }).name)}`,
      };
    },
    create: (fact) => {
      const id = fact.id as { schema: string; table: string; name: string };
      const specs: ActionSpec[] = [{ sql: str(p(fact, "def")) }];
      const enabled = p(fact, "enabled");
      if (enabled != null && enabled !== "O") {
        specs.push({
          sql: `ALTER TABLE ${rel(id.schema, id.table)} ${enabledPhrase(str(enabled))} TRIGGER ${qid(id.name)}`,
        });
      }
      return specs;
    },
    drop: (fact) => {
      const id = fact.id as { schema: string; table: string; name: string };
      return {
        sql: `DROP TRIGGER ${qid(id.name)} ON ${rel(id.schema, id.table)}`,
      };
    },
    attributes: {
      def: "replace",
      enabled: {
        alter: (fact, _from, to) => {
          const id = fact.id as { schema: string; table: string; name: string };
          return {
            sql: `ALTER TABLE ${rel(id.schema, id.table)} ${enabledPhrase(str(to))} TRIGGER ${qid(id.name)}`,
          };
        },
      },
    },
  },

  eventTrigger: {
    weight: 17,
    create: (fact) => {
      const name = qid((fact.id as { name: string }).name);
      const fnId: StableId = {
        kind: "procedure",
        schema: str(p(fact, "functionSchema")),
        name: str(p(fact, "functionName")),
        args: [],
      };
      let sql = `CREATE EVENT TRIGGER ${name} ON ${str(p(fact, "event"))}`;
      const tags = (p(fact, "tags") as string[]) ?? [];
      if (tags.length > 0) {
        sql += ` WHEN TAG IN (${tags.map((t) => lit(t)).join(", ")})`;
      }
      sql += ` EXECUTE FUNCTION ${rel(str(p(fact, "functionSchema")), str(p(fact, "functionName")))}()`;
      const specs: ActionSpec[] = [
        {
          sql,
          consumes: [fnId],
        },
      ];
      const enabled = p(fact, "enabled");
      if (enabled != null && enabled !== "O") {
        specs.push({
          sql: `ALTER EVENT TRIGGER ${name} ${enabledPhrase(str(enabled))}`,
        });
      }
      return specs;
    },
    drop: (fact) => ({
      sql: `DROP EVENT TRIGGER ${qid((fact.id as { name: string }).name)}`,
    }),
    ownerAlterPrefix: (fact) =>
      `ALTER EVENT TRIGGER ${qid((fact.id as { name: string }).name)}`,
    attributes: {
      enabled: {
        alter: (fact, _from, to) => ({
          sql: `ALTER EVENT TRIGGER ${qid((fact.id as { name: string }).name)} ${enabledPhrase(str(to))}`,
        }),
      },
      event: "replace",
      tags: "replace",
      functionSchema: "replace",
      functionName: "replace",
    },
  },
};
