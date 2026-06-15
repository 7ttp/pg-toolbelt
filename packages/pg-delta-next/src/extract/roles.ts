/** Cluster-level role state: roles, role memberships, and default privileges. */
import type { ExtractContext } from "./scope.ts";

export async function extractRolesAndGrants(
  ctx: ExtractContext,
): Promise<void> {
  const { q, facts } = ctx;

  // ── roles (cluster-level) ────────────────────────────────────────────
  for (const row of await q(`
    SELECT r.rolname AS name, r.rolsuper, r.rolinherit, r.rolcreaterole,
           r.rolcreatedb, r.rolcanlogin, r.rolreplication, r.rolbypassrls,
           COALESCE((SELECT array_agg(cfg ORDER BY cfg)
                     FROM pg_db_role_setting s, unnest(s.setconfig) cfg
                     WHERE s.setrole = r.oid AND s.setdatabase = 0),
                    '{}')::text[] AS config
    FROM pg_roles r
    WHERE r.rolname NOT LIKE 'pg\\_%'
    ORDER BY r.rolname`)) {
    facts.push({
      id: { kind: "role", name: String(row["name"]) },
      payload: {
        superuser: Boolean(row["rolsuper"]),
        inherit: Boolean(row["rolinherit"]),
        createRole: Boolean(row["rolcreaterole"]),
        createDb: Boolean(row["rolcreatedb"]),
        login: Boolean(row["rolcanlogin"]),
        replication: Boolean(row["rolreplication"]),
        bypassRls: Boolean(row["rolbypassrls"]),
        config: (row["config"] as string[]).map(String),
      },
    });
  }

  // ── role memberships (cluster-level; multi-grantor rows deduped) ─────
  for (const row of await q(`
    SELECT r1.rolname AS role, r2.rolname AS member,
           bool_or(m.admin_option) AS admin
    FROM pg_auth_members m
    JOIN pg_roles r1 ON r1.oid = m.roleid
    JOIN pg_roles r2 ON r2.oid = m.member
    WHERE r1.rolname NOT LIKE 'pg\\_%' AND r2.rolname NOT LIKE 'pg\\_%'
    GROUP BY 1, 2
    ORDER BY 1, 2`)) {
    facts.push({
      id: {
        kind: "membership",
        role: String(row["role"]),
        member: String(row["member"]),
      },
      payload: { admin: Boolean(row["admin"]) },
    });
  }

  // ── default privileges ───────────────────────────────────────────────
  for (const row of await q(`
    SELECT dr.rolname AS role, n.nspname AS schema, d.defaclobjtype AS objtype,
           acl.grantee_name AS grantee, acl.privileges, acl.grantable
    FROM pg_default_acl d
    JOIN pg_roles dr ON dr.oid = d.defaclrole
    LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace,
    LATERAL (
      SELECT COALESCE(g.rolname, 'PUBLIC') AS grantee_name,
             array_agg(e.privilege_type ORDER BY e.privilege_type) AS privileges,
             array_agg(e.privilege_type ORDER BY e.privilege_type)
               FILTER (WHERE e.is_grantable) AS grantable
      FROM aclexplode(d.defaclacl) e
      LEFT JOIN pg_roles g ON g.oid = e.grantee
      GROUP BY 1
    ) acl
    ORDER BY 1, 2, 3, 4`)) {
    facts.push({
      id: {
        kind: "defaultPrivilege",
        role: String(row["role"]),
        schema: row["schema"] == null ? null : (row["schema"] as string),
        objtype: String(row["objtype"]),
        grantee: String(row["grantee"]),
      },
      payload: {
        privileges: (row["privileges"] as string[]).map(String),
        grantable: ((row["grantable"] as string[] | null) ?? []).map(String),
      },
    });
  }
}
