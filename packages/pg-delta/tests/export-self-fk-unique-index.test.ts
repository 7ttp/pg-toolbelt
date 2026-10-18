/**
 * Export constraint-fold guard: a self-referencing FK whose referenced key is
 * backed by a standalone UNIQUE INDEX (not a constraint) must not fold inline
 * into CREATE TABLE — the index is created later in the same file, so the
 * inline FK fails with `there is no unique constraint matching given keys`
 * (supabase/pg-toolbelt#543). Stock alpine image; Docker required.
 */
import { describe, expect, test } from "bun:test";
import { extract } from "../src/extract/extract.ts";
import { exportSqlFiles } from "../src/frontends/export-sql-files.ts";
import { loadSqlFiles } from "../src/frontends/load-sql-files.ts";
import { createTestDb } from "./containers.ts";

const SCHEMA_SQL = `
  CREATE SCHEMA s;
  CREATE TABLE s.people (
    id bigint PRIMARY KEY,
    org_id integer NOT NULL,
    merge_target_id bigint
  );
  CREATE UNIQUE INDEX uq_people_org_id_id ON s.people (org_id, id);
  ALTER TABLE s.people ADD CONSTRAINT people_merge_target_fkey
    FOREIGN KEY (org_id, merge_target_id) REFERENCES s.people (org_id, id);
`;

function forLoad(files: { name: string; sql: string }[]) {
  return files.filter((f) => !/cluster[_/]roles/.test(f.name));
}

describe("export: self-referencing FK onto a unique index", () => {
  test("FK renders after the backing index and the export reloads", async () => {
    const src = await createTestDb("selffk_src");
    const shadow = await createTestDb("selffk_shadow");
    try {
      await src.pool.query(SCHEMA_SQL);
      const fb = (await extract(src.pool)).factBase;
      const files = forLoad(exportSqlFiles(fb, { layout: "by-object" }));
      const tableSql = files
        .filter((f) => /people/.test(f.sql))
        .map((f) => f.sql)
        .join("\n");
      expect(tableSql).toMatchInlineSnapshot(`
        "CREATE TABLE "s"."people" ("id" bigint NOT NULL, "org_id" integer NOT NULL, "merge_target_id" bigint, CONSTRAINT "people_pkey" PRIMARY KEY (id));

        ALTER TABLE "s"."people" OWNER TO "test";

        CREATE UNIQUE INDEX uq_people_org_id_id ON s.people USING btree (org_id, id);

        ALTER TABLE "s"."people" ADD CONSTRAINT "people_merge_target_fkey" FOREIGN KEY (org_id, merge_target_id) REFERENCES s.people(org_id, id);
        "
      `);
      const loaded = await loadSqlFiles(files, shadow.pool);
      expect(loaded.factBase.rootHash).toBe(fb.rootHash);
    } finally {
      await Promise.all([src.drop(), shadow.drop()]);
    }
  }, 120_000);
});
