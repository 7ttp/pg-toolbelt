/** Rule definitions for publications, their member facts, and subscriptions. */
import { lit, qid, rel } from "../render.ts";
import type { ActionSpec, KindRules } from "../rules.ts";
import { p, publicationObjects, publicationRelClause, str } from "./helpers.ts";

export const publicationRules: Record<string, KindRules> = {
  publication: {
    weight: 18,
    cascadesToChildren: true,
    create: (fact, view) => {
      const name = qid((fact.id as { name: string }).name);
      const objects = publicationObjects(fact, view);
      let sql = `CREATE PUBLICATION ${name}`;
      // FOR ALL TABLES has no member facts; otherwise inline the member
      // facts (delta-set) so their standalone ADD actions are skipped
      if (p(fact, "allTables")) sql += ` FOR ALL TABLES`;
      else if (objects.clauses.length > 0)
        sql += ` FOR ${objects.clauses.join(", ")}`;
      const withParts = [
        `publish = ${lit(((p(fact, "publish") as string[]) ?? []).join(", "))}`,
      ];
      if (p(fact, "viaRoot"))
        withParts.push(`publish_via_partition_root = true`);
      sql += ` WITH (${withParts.join(", ")})`;
      return [
        {
          sql,
          ...(objects.consumes.length > 0
            ? { consumes: objects.consumes }
            : {}),
          ...(objects.produced.length > 0
            ? { alsoProduces: objects.produced }
            : {}),
        },
      ];
    },
    drop: (fact) => ({
      sql: `DROP PUBLICATION ${qid((fact.id as { name: string }).name)}`,
    }),
    ownerAlterPrefix: (fact) =>
      `ALTER PUBLICATION ${qid((fact.id as { name: string }).name)}`,
    attributes: {
      publish: {
        alter: (fact, _from, to) => ({
          sql: `ALTER PUBLICATION ${qid((fact.id as { name: string }).name)} SET (publish = ${lit(((to as string[] | null) ?? []).join(", "))})`,
        }),
      },
      viaRoot: {
        alter: (fact, _from, to) => ({
          sql: `ALTER PUBLICATION ${qid((fact.id as { name: string }).name)} SET (publish_via_partition_root = ${to ? "true" : "false"})`,
        }),
      },
      allTables: "replace",
    },
  },

  // a published table is its own fact: ADD/DROP TABLE incrementally. A
  // column-list or WHERE change has no in-place form, so those attributes
  // replace (DROP TABLE + re-ADD with the new shape). On a fresh
  // publication the member is inlined into CREATE PUBLICATION (see above).
  publicationRel: {
    weight: 18,
    create: (fact) => {
      const id = fact.id as {
        publication: string;
        schema: string;
        table: string;
      };
      return [
        {
          sql: `ALTER PUBLICATION ${qid(id.publication)} ADD ${publicationRelClause(fact)}`,
          consumes: [{ kind: "table", schema: id.schema, name: id.table }],
        },
      ];
    },
    drop: (fact) => {
      const id = fact.id as {
        publication: string;
        schema: string;
        table: string;
      };
      return {
        sql: `ALTER PUBLICATION ${qid(id.publication)} DROP TABLE ${rel(id.schema, id.table)}`,
      };
    },
    attributes: {
      columns: "replace",
      where: "replace",
    },
  },

  // a published schema (FOR TABLES IN SCHEMA, PG15+) as its own fact
  publicationSchema: {
    weight: 18,
    create: (fact) => {
      const id = fact.id as { publication: string; schema: string };
      return [
        {
          sql: `ALTER PUBLICATION ${qid(id.publication)} ADD TABLES IN SCHEMA ${qid(id.schema)}`,
          consumes: [{ kind: "schema", name: id.schema }],
        },
      ];
    },
    drop: (fact) => {
      const id = fact.id as { publication: string; schema: string };
      return {
        sql: `ALTER PUBLICATION ${qid(id.publication)} DROP TABLES IN SCHEMA ${qid(id.schema)}`,
      };
    },
    attributes: {},
  },

  subscription: {
    weight: 23,
    create: (fact) => {
      const name = qid((fact.id as { name: string }).name);
      const publications = ((p(fact, "publications") as string[]) ?? [])
        .map((pub) => qid(pub))
        .join(", ");
      const slot = p(fact, "slotName");
      const withParts = [
        "connect = false",
        "enabled = false",
        `slot_name = ${slot == null ? "NONE" : lit(str(slot))}`,
      ];
      const specs: ActionSpec[] = [
        {
          sql: `CREATE SUBSCRIPTION ${name} CONNECTION ${lit(str(p(fact, "conninfo")))} PUBLICATION ${publications} WITH (${withParts.join(", ")})`,
        },
      ];
      if (p(fact, "enabled")) {
        specs.push({ sql: `ALTER SUBSCRIPTION ${name} ENABLE` });
      }
      return specs;
    },
    drop: (fact) => ({
      sql: `DROP SUBSCRIPTION ${qid((fact.id as { name: string }).name)}`,
      // with an associated replication slot the drop cannot run inside a
      // transaction block; slotless subscriptions drop transactionally
      ...(p(fact, "slotName") == null
        ? {}
        : { transactionality: "nonTransactional" as const }),
    }),
    ownerAlterPrefix: (fact) =>
      `ALTER SUBSCRIPTION ${qid((fact.id as { name: string }).name)}`,
    attributes: {
      enabled: {
        alter: (fact, _from, to) => ({
          sql: `ALTER SUBSCRIPTION ${qid((fact.id as { name: string }).name)} ${to ? "ENABLE" : "DISABLE"}`,
        }),
      },
      publications: {
        alter: (fact, _from, to) => ({
          sql: `ALTER SUBSCRIPTION ${qid((fact.id as { name: string }).name)} SET PUBLICATION ${((to as string[] | null) ?? []).map((pub) => qid(pub)).join(", ")} WITH (refresh = false)`,
        }),
      },
      conninfo: {
        alter: (fact, _from, to) => ({
          sql: `ALTER SUBSCRIPTION ${qid((fact.id as { name: string }).name)} CONNECTION ${lit(str(to))}`,
        }),
      },
      slotName: {
        alter: (fact, _from, to) => ({
          sql: `ALTER SUBSCRIPTION ${qid((fact.id as { name: string }).name)} SET (slot_name = ${to == null ? "NONE" : lit(str(to))})`,
        }),
      },
    },
  },
};
