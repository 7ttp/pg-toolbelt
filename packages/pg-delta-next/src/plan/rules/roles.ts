/** Rule definitions for cluster-level role objects: roles, role memberships,
 *  and default privileges. */
import type { Fact } from "../../core/fact.ts";
import type { PayloadValue } from "../../core/hash.ts";
import { lit, qid, splitOption } from "../render.ts";
import type { ActionSpec, KindRules } from "../rules.ts";
import {
  DEFACL_OBJTYPE,
  defaultPrivConsumes,
  defaultPrivilegeActions,
  defaultPrivPrefix,
  p,
  renameRule,
  ROLE_FLAGS,
  roleFlagSql,
} from "./helpers.ts";

export const roleRules: Record<string, KindRules> = {
  role: {
    weight: 0,
    rename: renameRule(
      (fact) => `ALTER ROLE ${qid((fact.id as { name: string }).name)}`,
    ),
    create: (fact) => [
      {
        sql: `CREATE ROLE ${qid((fact.id as { name: string }).name)} WITH ${roleFlagSql(fact.payload)}`,
      },
    ],
    drop: (fact) => {
      const name = qid((fact.id as { name: string }).name);
      // DROP OWNED clears residual default privileges / grants in this
      // database; every wanted reassignment has already run (releases edges)
      return { sql: `DROP OWNED BY ${name}; DROP ROLE ${name}` };
    },
    attributes: {
      ...Object.fromEntries(
        Object.entries(ROLE_FLAGS).map(([key, [on, off]]) => [
          key,
          {
            alter: (fact: Fact, _from: PayloadValue, to: PayloadValue) => ({
              sql: `ALTER ROLE ${qid((fact.id as { name: string }).name)} WITH ${to ? on : off}`,
            }),
          },
        ]),
      ),
      config: {
        alter: (fact, from, to) => {
          const role = qid((fact.id as { name: string }).name);
          const oldCfg = new Map(
            ((from as string[] | null) ?? []).map(splitOption),
          );
          const newCfg = new Map(
            ((to as string[] | null) ?? []).map(splitOption),
          );
          const specs: ActionSpec[] = [];
          for (const [key] of oldCfg) {
            if (!newCfg.has(key)) {
              specs.push({ sql: `ALTER ROLE ${role} RESET ${qid(key)}` });
            }
          }
          for (const [key, value] of newCfg) {
            if (oldCfg.get(key) !== value) {
              specs.push({
                sql: `ALTER ROLE ${role} SET ${qid(key)} TO ${lit(value)}`,
              });
            }
          }
          return specs;
        },
      },
    },
  },

  membership: {
    weight: 1,
    create: (fact) => {
      const id = fact.id as { role: string; member: string };
      return [
        {
          sql: `GRANT ${qid(id.role)} TO ${qid(id.member)}${p(fact, "admin") ? " WITH ADMIN OPTION" : ""}`,
          consumes: [
            { kind: "role", name: id.role },
            { kind: "role", name: id.member },
          ],
        },
      ];
    },
    drop: (fact) => {
      const id = fact.id as { role: string; member: string };
      return {
        sql: `REVOKE ${qid(id.role)} FROM ${qid(id.member)} CASCADE`,
        consumes: [
          { kind: "role", name: id.role },
          { kind: "role", name: id.member },
        ],
      };
    },
    attributes: {
      admin: {
        alter: (fact, _from, to) => {
          const id = fact.id as { role: string; member: string };
          return {
            sql: to
              ? `GRANT ${qid(id.role)} TO ${qid(id.member)} WITH ADMIN OPTION`
              : `REVOKE ADMIN OPTION FOR ${qid(id.role)} FROM ${qid(id.member)}`,
          };
        },
      },
    },
  },

  defaultPrivilege: {
    weight: 22,
    create: (fact) => defaultPrivilegeActions(fact, "GRANT"),
    drop: (fact) => {
      const id = fact.id as {
        role: string;
        schema: string | null;
        objtype: string;
        grantee: string;
      };
      const grantee = id.grantee === "PUBLIC" ? "PUBLIC" : qid(id.grantee);
      return {
        sql: `${defaultPrivPrefix(id)} REVOKE ALL ON ${DEFACL_OBJTYPE[id.objtype] ?? "TABLES"} FROM ${grantee}`,
        consumes: defaultPrivConsumes(id),
      };
    },
    attributes: { privileges: "replace", grantable: "replace" },
  },
};
