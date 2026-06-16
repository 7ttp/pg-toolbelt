/** Routines: functions / procedures and aggregates. */
import type { StableId } from "../core/stable-id.ts";
import {
  aclJson,
  type ExtractContext,
  memberExtensionExpr,
  parseAcl,
  schemaId,
  USER_SCHEMA_FILTER,
} from "./scope.ts";

export async function extractRoutines(ctx: ExtractContext): Promise<void> {
  const { q, pushWithMeta, pushMemberEdge, pushOwnerEdge } = ctx;
  // ── routines (functions + procedures; pg_get_functiondef canonical) ──
  for (const row of await q(`
    SELECT n.nspname AS schema, p.proname AS name, r.rolname AS owner,
           p.prokind AS prokind,
           ARRAY(SELECT format_type(t.t, NULL)
                 FROM unnest(p.proargtypes) WITH ORDINALITY AS t(t, ord)
                 ORDER BY t.ord)::text[] AS identity_args,
           pg_get_functiondef(p.oid) AS def,
           obj_description(p.oid, 'pg_proc') AS comment,
           ${aclJson("p.proacl", "f", "p.proowner")} AS acl,
           ${memberExtensionExpr("pg_proc", "p.oid")} AS ext_member_of
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.prokind IN ('f', 'p') AND ${USER_SCHEMA_FILTER}
      AND NOT EXISTS (
        SELECT 1 FROM pg_depend idep
        WHERE idep.classid = 'pg_proc'::regclass AND idep.objid = p.oid
          AND idep.deptype = 'i')
    ORDER BY n.nspname, p.proname`)) {
    const args = (row["identity_args"] as string[]).map(String);
    // prokind distinguishes functions ('f') from procedures ('p'); the kind
    // lives in the id (not the payload) so satellite renderers address the
    // routine with the correct DDL keyword (FUNCTION vs PROCEDURE).
    const id: StableId = {
      kind: String(row["prokind"]) === "p" ? "procedure" : "function",
      schema: String(row["schema"]),
      name: String(row["name"]),
      args,
    };
    pushWithMeta(
      {
        id,
        parent: schemaId(row["schema"]),
        payload: {
          def: String(row["def"]),
        },
      },
      row,
      parseAcl(row["acl"]),
    );
    pushMemberEdge(id, row);
    pushOwnerEdge(id, row["owner"]);
  }
}

export async function extractAggregates(ctx: ExtractContext): Promise<void> {
  const { q, pushWithMeta, pushMemberEdge, pushOwnerEdge } = ctx;
  // ── aggregates (CREATE AGGREGATE is reconstructed from pg_aggregate) ─
  for (const row of await q(`
    SELECT n.nspname AS schema, p.proname AS name, r.rolname AS owner,
           ARRAY(SELECT format_type(t.t, NULL)
                 FROM unnest(p.proargtypes) WITH ORDINALITY AS t(t, ord)
                 ORDER BY t.ord)::text[] AS identity_args,
           a.aggkind AS agg_kind, a.aggnumdirectargs AS num_direct_args,
           a.aggtransfn::regproc::text AS sfunc,
           format_type(a.aggtranstype, NULL) AS stype,
           CASE WHEN a.aggfinalfn <> 0 THEN a.aggfinalfn::regproc::text END AS finalfunc,
           a.agginitval AS initcond,
           obj_description(p.oid, 'pg_proc') AS comment,
           ${aclJson("p.proacl", "f", "p.proowner")} AS acl,
           ${memberExtensionExpr("pg_proc", "p.oid")} AS ext_member_of
    FROM pg_proc p
    JOIN pg_aggregate a ON a.aggfnoid = p.oid
    JOIN pg_namespace n ON n.oid = p.pronamespace
    JOIN pg_roles r ON r.oid = p.proowner
    WHERE p.prokind = 'a' AND ${USER_SCHEMA_FILTER}
    ORDER BY n.nspname, p.proname`)) {
    const id: StableId = {
      kind: "aggregate",
      schema: String(row["schema"]),
      name: String(row["name"]),
      args: (row["identity_args"] as string[]).map(String),
    };
    pushWithMeta(
      {
        id,
        parent: schemaId(row["schema"]),
        payload: {
          aggKind: String(row["agg_kind"]),
          numDirectArgs: Number(row["num_direct_args"]),
          sfunc: String(row["sfunc"]),
          stype: String(row["stype"]),
          finalfunc:
            row["finalfunc"] == null ? null : (row["finalfunc"] as string),
          initcond:
            row["initcond"] == null ? null : (row["initcond"] as string),
        },
      },
      row,
      parseAcl(row["acl"]),
    );
    pushMemberEdge(id, row);
    pushOwnerEdge(id, row["owner"]);
  }
}
