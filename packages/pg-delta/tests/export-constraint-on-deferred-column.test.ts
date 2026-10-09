/**
 * Export constraint-fold guard: a table UNIQUE/PK/CHECK constraint must NOT be
 * folded inline into `CREATE TABLE` when its own same-table column was deferred
 * out of the CREATE into a later `ALTER TABLE … ADD COLUMN` statement.
 *
 * `slug_key … GENERATED ALWAYS AS (lower(slug))` is a generated column, which
 * never gets a fold hint (see src/plan/rules/tables.ts), so it is deferred.
 * `slug s.slug_text` (domain-typed) used to be deferred too; since #518 the
 * CREATE TABLE is ordered after the domain, so it now folds inline along with
 * its UNIQUE constraint.
 *
 * Before the fix `compactColumnFolds` folded the two UNIQUE constraints inline
 * (`!isConstraintFold` bypassed the crossing guard), so the exported CREATE TABLE
 * referenced `slug` / `slug_key` that were not yet columns, and the reload failed
 * with `column "slug" named in key does not exist`.
 *
 * After the fix `UNIQUE (slug)` folds inline with its (now inline) column,
 * while `UNIQUE (slug_key)` stays a standalone `ALTER TABLE … ADD CONSTRAINT`
 * after the deferred `ADD COLUMN "slug_key"`; the export reloads, and the shadow
 * re-extract hash-matches the source.
 *
 * Stock alpine image; Docker required.
 */
import { describe, expect, test } from "bun:test";
import { extract } from "../src/extract/extract.ts";
import { exportSqlFiles } from "../src/frontends/export-sql-files.ts";
import { loadSqlFiles } from "../src/frontends/load-sql-files.ts";
import { createTestDb } from "./containers.ts";

const SCHEMA_SQL = `
  CREATE SCHEMA s;
  CREATE DOMAIN s.slug_text AS text CHECK (length(VALUE) > 0);
  CREATE TABLE s.organizations (
    id uuid PRIMARY KEY,
    slug s.slug_text NOT NULL,
    slug_key text GENERATED ALWAYS AS (lower(slug::text)) STORED,
    CONSTRAINT organizations_slug_key UNIQUE (slug),
    CONSTRAINT organizations_slug_key_key UNIQUE (slug_key)
  );
`;

function forLoad(files: { name: string; sql: string }[]) {
  // roles are cluster-global and already present in the shared cluster.
  return files.filter((f) => !/cluster[_/]roles/.test(f.name));
}

describe("export: key constraint on a deferred column", () => {
  test("UNIQUE constraints on domain/generated columns reload", async () => {
    const src = await createTestDb("keycon_src");
    const shadow = await createTestDb("keycon_shadow");
    try {
      await src.pool.query(SCHEMA_SQL);
      const fb = (await extract(src.pool)).factBase;

      const files = forLoad(exportSqlFiles(fb, { layout: "by-object" }));

      // `slug` and its UNIQUE constraint inline in the CREATE; the deferred
      // generated `slug_key` column keeps its UNIQUE as a standalone
      // ALTER TABLE … ADD CONSTRAINT after the ADD COLUMN — not inline.
      const tableSql = files
        .filter((f) => /organizations/.test(f.sql))
        .map((f) => f.sql)
        .join("\n");
      expect(tableSql).toMatchInlineSnapshot(`
        "CREATE TABLE "s"."organizations" ("id" uuid NOT NULL, "slug" s.slug_text NOT NULL, CONSTRAINT "organizations_pkey" PRIMARY KEY (id), CONSTRAINT "organizations_slug_key" UNIQUE (slug));

        ALTER TABLE "s"."organizations" OWNER TO "test";

        ALTER TABLE "s"."organizations" ADD COLUMN "slug_key" text GENERATED ALWAYS AS (lower((slug)::text)) STORED;

        ALTER TABLE "s"."organizations" ADD CONSTRAINT "organizations_slug_key_key" UNIQUE (slug_key);
        "
      `);

      const loaded = await loadSqlFiles(files, shadow.pool);
      expect(loaded.factBase.rootHash).toBe(fb.rootHash);
    } finally {
      await Promise.all([src.drop(), shadow.drop()]);
    }
  }, 120_000);
});
