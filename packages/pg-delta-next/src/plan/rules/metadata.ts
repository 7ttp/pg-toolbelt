/** Rule definitions for metadata satellites: comments, security labels, and
 *  ACL grants. */
import type { StableId } from "../../core/stable-id.ts";
import { commentTarget, grantTarget, lit, qid } from "../render.ts";
import type { KindRules } from "../rules.ts";
import { grantActions, p, str } from "./helpers.ts";

export const metadataRules: Record<string, KindRules> = {
  comment: {
    weight: 20,
    metadata: true,
    create: (fact) => {
      const target = (fact.id as { target: StableId }).target;
      const opts = { domainConstraint: p(fact, "onDomain") === true };
      return [
        {
          sql: `COMMENT ON ${commentTarget(target, opts)} IS ${lit(str(p(fact, "text")))}`,
        },
      ];
    },
    drop: (fact) => {
      const target = (fact.id as { target: StableId }).target;
      const opts = { domainConstraint: p(fact, "onDomain") === true };
      return { sql: `COMMENT ON ${commentTarget(target, opts)} IS NULL` };
    },
    attributes: {
      text: {
        alter: (fact, _from, to) => {
          const target = (fact.id as { target: StableId }).target;
          const opts = { domainConstraint: p(fact, "onDomain") === true };
          return {
            sql: `COMMENT ON ${commentTarget(target, opts)} IS ${lit(str(to))}`,
          };
        },
      },
    },
  },

  // a global satellite rule (like comment): SECURITY LABEL shares COMMENT's
  // ON-target grammar, so it reuses commentTarget. The provider lives in
  // the fact id; the label text is the payload.
  securityLabel: {
    weight: 20,
    metadata: true,
    create: (fact) => {
      const id = fact.id as { target: StableId; provider: string };
      return [
        {
          sql: `SECURITY LABEL FOR ${lit(id.provider)} ON ${commentTarget(id.target)} IS ${lit(str(p(fact, "label")))}`,
        },
      ];
    },
    drop: (fact) => {
      const id = fact.id as { target: StableId; provider: string };
      return {
        sql: `SECURITY LABEL FOR ${lit(id.provider)} ON ${commentTarget(id.target)} IS NULL`,
      };
    },
    attributes: {
      label: {
        alter: (fact, _from, to) => {
          const id = fact.id as { target: StableId; provider: string };
          return {
            sql: `SECURITY LABEL FOR ${lit(id.provider)} ON ${commentTarget(id.target)} IS ${lit(str(to))}`,
          };
        },
      },
    },
  },

  acl: {
    weight: 21,
    metadata: true,
    create: (fact) => grantActions(fact, "grant"),
    drop: (fact) => {
      const id = fact.id as { kind: "acl"; target: StableId; grantee: string };
      const grantee = id.grantee === "PUBLIC" ? "PUBLIC" : qid(id.grantee);
      return {
        sql: `REVOKE ALL ON ${grantTarget(id.target)} FROM ${grantee}`,
        ...(id.grantee === "PUBLIC"
          ? {}
          : { consumes: [{ kind: "role", name: id.grantee } as StableId] }),
      };
    },
    attributes: {
      privileges: "replace",
      grantable: "replace",
    },
  },
};
