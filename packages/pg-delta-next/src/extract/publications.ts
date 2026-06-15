/** Publications (+ their table / schema member facts) and subscriptions. */
import type { StableId } from "../core/stable-id.ts";
import { type ExtractContext, notExtensionMember } from "./scope.ts";

export async function extractPublications(ctx: ExtractContext): Promise<void> {
  const { q, facts, pushWithMeta, pushOwnerEdge } = ctx;
  // ── publications ─────────────────────────────────────────────────────
  for (const row of await q(`
    SELECT p.pubname AS name, r.rolname AS owner,
           p.puballtables AS all_tables, p.pubviaroot AS via_root,
           p.pubinsert, p.pubupdate, p.pubdelete, p.pubtruncate,
           (SELECT json_agg(json_build_object(
              'schema', pn.nspname, 'name', pc.relname,
              'columns', (SELECT array_agg(att.attname::text ORDER BY att.attname)
                          FROM unnest(pr.prattrs) WITH ORDINALITY AS pa(attnum, ord)
                          JOIN pg_attribute att ON att.attrelid = pc.oid AND att.attnum = pa.attnum),
              'where', pg_get_expr(pr.prqual, pr.prrelid)
            ) ORDER BY pn.nspname, pc.relname)
            FROM pg_publication_rel pr
            JOIN pg_class pc ON pc.oid = pr.prrelid
            JOIN pg_namespace pn ON pn.oid = pc.relnamespace
            WHERE pr.prpubid = p.oid) AS tables,
           (SELECT array_agg(pn2.nspname::text ORDER BY 1)
            FROM pg_publication_namespace pns
            JOIN pg_namespace pn2 ON pn2.oid = pns.pnnspid
            WHERE pns.pnpubid = p.oid) AS schemas,
           obj_description(p.oid, 'pg_publication') AS comment
    FROM pg_publication p
    JOIN pg_roles r ON r.oid = p.pubowner
    WHERE ${notExtensionMember("pg_publication", "p.oid")}
    ORDER BY p.pubname`)) {
    const publish: string[] = [];
    if (row["pubinsert"]) publish.push("insert");
    if (row["pubupdate"]) publish.push("update");
    if (row["pubdelete"]) publish.push("delete");
    if (row["pubtruncate"]) publish.push("truncate");
    const pubName = String(row["name"]);
    const pubId: StableId = { kind: "publication", name: pubName };
    pushWithMeta(
      {
        id: pubId,
        payload: {
          allTables: Boolean(row["all_tables"]),
          viaRoot: Boolean(row["via_root"]),
          publish,
        },
      },
      row,
    );
    pushOwnerEdge(pubId, row["owner"]);
    // each published table / schema is its own fact (granularity is one):
    // members are managed with ALTER PUBLICATION ADD/DROP, and a column-list
    // or WHERE change diffs at table grain instead of churning the whole
    // publication payload.
    const tables =
      (row["tables"] as
        | {
            schema: string;
            name: string;
            columns: string[] | null;
            where: string | null;
          }[]
        | null) ?? [];
    for (const t of tables) {
      facts.push({
        id: {
          kind: "publicationRel",
          publication: pubName,
          schema: t.schema,
          table: t.name,
        },
        parent: pubId,
        payload: {
          columns: t.columns == null ? null : t.columns.map(String),
          where: t.where ?? null,
        },
      });
    }
    for (const s of ((row["schemas"] as string[] | null) ?? []).map(String)) {
      facts.push({
        id: { kind: "publicationSchema", publication: pubName, schema: s },
        parent: pubId,
        payload: {},
      });
    }
  }
}

export async function extractSubscriptions(ctx: ExtractContext): Promise<void> {
  const { q, pushWithMeta, pushOwnerEdge } = ctx;
  // ── subscriptions (database-local rows only) ─────────────────────────
  for (const row of await q(`
    SELECT s.subname AS name, r.rolname AS owner, s.subenabled AS enabled,
           s.subconninfo AS conninfo, s.subslotname AS slot_name,
           s.subpublications::text[] AS publications,
           obj_description(s.oid, 'pg_subscription') AS comment
    FROM pg_subscription s
    JOIN pg_roles r ON r.oid = s.subowner
    JOIN pg_database d ON d.oid = s.subdbid
    WHERE d.datname = current_database()
    ORDER BY s.subname`)) {
    const subId: StableId = { kind: "subscription", name: String(row["name"]) };
    pushWithMeta(
      {
        id: subId,
        payload: {
          enabled: Boolean(row["enabled"]),
          conninfo: String(row["conninfo"]),
          slotName:
            row["slot_name"] == null ? null : (row["slot_name"] as string),
          publications: (row["publications"] as string[]).map(String).sort(),
        },
      },
      row,
    );
    pushOwnerEdge(subId, row["owner"]);
  }
}
