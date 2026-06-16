/** Security labels (satellite facts, like comments). */
import type { StableId } from "../core/stable-id.ts";
import {
  type ExtractContext,
  SYSTEM_SCHEMAS,
  USER_SCHEMA_FILTER,
} from "./scope.ts";

export async function extractSecurityLabels(
  ctx: ExtractContext,
): Promise<void> {
  const { q, pushSeclabel } = ctx;
  // ── security labels (satellite facts, like comments) ────────────────
  // pg_seclabel / pg_shseclabel are EMPTY unless a label provider module
  // labeled something. One cheap existence probe gates the five resolver
  // queries so a label-free database (the overwhelming common case) pays
  // a single round trip, not six. The target's identity parts come back as
  // a resolved StableId built inline.
  const hasSeclabels = Boolean(
    (
      await q(
        `SELECT EXISTS (SELECT 1 FROM pg_seclabel)
              OR EXISTS (SELECT 1 FROM pg_shseclabel) AS present`,
      )
    )[0]?.["present"],
  );
  if (hasSeclabels) {
    // relations (tables/views/matviews/sequences/foreign tables) + columns
    for (const row of await q(`
      SELECT sl.provider, sl.label, sl.objsubid,
             n.nspname AS schema, c.relname AS name, c.relkind AS relkind,
             a.attname AS column
      FROM pg_seclabel sl
      JOIN pg_class c ON c.oid = sl.objoid AND sl.classoid = 'pg_class'::regclass
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = sl.objsubid
      WHERE ${USER_SCHEMA_FILTER}
      ORDER BY 1, 4, 5`)) {
      const schema = String(row["schema"]);
      const relkind = String(row["relkind"]);
      if (Number(row["objsubid"]) > 0) {
        pushSeclabel(
          {
            kind: "column",
            schema,
            table: String(row["name"]),
            name: String(row["column"]),
          },
          String(row["provider"]),
          String(row["label"]),
        );
        continue;
      }
      const relKindMap: Record<string, StableId["kind"]> = {
        r: "table",
        p: "table",
        v: "view",
        m: "materializedView",
        S: "sequence",
        f: "foreignTable",
      };
      const kind = relKindMap[relkind];
      if (kind === undefined) continue;
      pushSeclabel(
        { kind, schema, name: String(row["name"]) } as StableId,
        String(row["provider"]),
        String(row["label"]),
      );
    }
    // routines
    for (const row of await q(`
      SELECT sl.provider, sl.label, n.nspname AS schema, p.proname AS name,
             p.prokind AS prokind,
             ARRAY(SELECT format_type(t.t, NULL)
                   FROM unnest(p.proargtypes) WITH ORDINALITY AS t(t, ord)
                   ORDER BY t.ord)::text[] AS args
      FROM pg_seclabel sl
      JOIN pg_proc p ON p.oid = sl.objoid AND sl.classoid = 'pg_proc'::regclass
      JOIN pg_namespace n ON n.oid = p.pronamespace
      WHERE ${USER_SCHEMA_FILTER}
      ORDER BY 1, 3, 4`)) {
      const prokind = String(row["prokind"]);
      pushSeclabel(
        {
          kind:
            prokind === "a"
              ? "aggregate"
              : prokind === "p"
                ? "procedure"
                : "function",
          schema: String(row["schema"]),
          name: String(row["name"]),
          args: (row["args"] as string[]).map(String),
        },
        String(row["provider"]),
        String(row["label"]),
      );
    }
    // schemas, types/domains
    for (const row of await q(`
      SELECT sl.provider, sl.label, n.nspname AS name
      FROM pg_seclabel sl
      JOIN pg_namespace n ON n.oid = sl.objoid AND sl.classoid = 'pg_namespace'::regclass
      WHERE n.nspname NOT IN ${SYSTEM_SCHEMAS} AND n.nspname NOT LIKE 'pg\\_%'
      ORDER BY 1, 3`)) {
      pushSeclabel(
        { kind: "schema", name: String(row["name"]) },
        String(row["provider"]),
        String(row["label"]),
      );
    }
    for (const row of await q(`
      SELECT sl.provider, sl.label, n.nspname AS schema, t.typname AS name,
             t.typtype AS typtype
      FROM pg_seclabel sl
      JOIN pg_type t ON t.oid = sl.objoid AND sl.classoid = 'pg_type'::regclass
      JOIN pg_namespace n ON n.oid = t.typnamespace
      WHERE ${USER_SCHEMA_FILTER}
      ORDER BY 1, 3, 4`)) {
      pushSeclabel(
        {
          kind: String(row["typtype"]) === "d" ? "domain" : "type",
          schema: String(row["schema"]),
          name: String(row["name"]),
        },
        String(row["provider"]),
        String(row["label"]),
      );
    }
    // roles (shared catalog)
    for (const row of await q(`
      SELECT sl.provider, sl.label, r.rolname AS name
      FROM pg_shseclabel sl
      JOIN pg_authid r ON r.oid = sl.objoid AND sl.classoid = 'pg_authid'::regclass
      WHERE r.rolname NOT LIKE 'pg\\_%'
      ORDER BY 1, 3`)) {
      pushSeclabel(
        { kind: "role", name: String(row["name"]) },
        String(row["provider"]),
        String(row["label"]),
      );
    }
  }
}
