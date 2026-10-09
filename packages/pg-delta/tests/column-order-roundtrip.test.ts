/**
 * Table column ORDER round-trip.
 *
 * A table declared `(wal jsonb, is_rls_enabled boolean, subscription_ids uuid[],
 * errors text[])` is row-layout state: its column ORDER matters for `SELECT *`,
 * positional INSERTs, and the relation's row type. The root hash is
 * order-BLIND by design (`_position` is `_`-prefixed), so convergence alone
 * cannot observe a reorder — the reloaded database's PHYSICAL column order
 * (pg_attribute.attnum) is what pins it.
 *
 * Before the fix a from-empty `CREATE TABLE` rendered its columns in encoded-id
 * (name) order, so the export reload materialized them alphabetically
 * (`errors, is_rls_enabled, subscription_ids, wal`). After the fix the export
 * preserves declared position, so the shadow reload keeps `wal` first.
 *
 * Stock alpine image; Docker required.
 */
import { describe, expect, test } from "bun:test";
import { apply } from "../src/apply/apply.ts";
import { diff } from "../src/core/diff.ts";
import { extract } from "../src/extract/extract.ts";
import { exportSqlFiles } from "../src/frontends/export-sql-files.ts";
import { loadSqlFiles } from "../src/frontends/load-sql-files.ts";
import { plan } from "../src/plan/plan.ts";
import { sharedCluster } from "./containers.ts";

// declared order is NOT alphabetical: wal < is_rls_enabled < subscription_ids <
// errors (alphabetical would put errors first).
const TABLE_SQL = `
  CREATE SCHEMA s;
  CREATE TABLE s.wal_rls (
    wal jsonb,
    is_rls_enabled boolean,
    subscription_ids uuid[],
    errors text[]
  );
`;

const DECLARED_ORDER = ["wal", "is_rls_enabled", "subscription_ids", "errors"];

function forLoad(files: { name: string; sql: string }[]) {
  // roles are cluster-global and already present in the shared cluster.
  return files.filter((f) => !/cluster[_/]roles/.test(f.name));
}

async function columnOrder(
  pool: import("pg").Pool,
  relation: string,
): Promise<string[]> {
  const res = await pool.query(
    `SELECT attname FROM pg_attribute
     WHERE attrelid = $1::regclass AND attnum > 0 AND NOT attisdropped
     ORDER BY attnum`,
    [relation],
  );
  return res.rows.map((r) => (r as { attname: string }).attname);
}

describe("table column order round-trip", () => {
  test("wal_rls reloads with columns in declared (non-alphabetical) order", async () => {
    const cluster = await sharedCluster();
    const src = await cluster.createDb("column_order_src");
    const shadow = await cluster.createDb("column_order_shadow");
    try {
      await src.pool.query(TABLE_SQL);
      const fb = (await extract(src.pool)).factBase;

      const files = forLoad(exportSqlFiles(fb, { layout: "by-object" }));
      const loaded = await loadSqlFiles(files, shadow.pool);

      // convergence (order-blind) still holds …
      expect(loaded.factBase.rootHash).toBe(fb.rootHash);
      // … and the reloaded database preserves the declared column order.
      expect(await columnOrder(shadow.pool, "s.wal_rls")).toEqual(
        DECLARED_ORDER,
      );
    } finally {
      await Promise.all([src.drop(), shadow.drop()]);
    }
  }, 120_000);

  // #518: a column gated by a later dependency (a same-schema enum type, a
  // user-function default) or never folded (STORED generated) keeps its attnum
  // slot instead of landing in a trailing ADD COLUMN after its siblings.
  test("columns behind a type, a function default, or a generated expression keep their order", async () => {
    const cluster = await sharedCluster();
    const src = await cluster.createDb("column_order_dep_src");
    const shadow = await cluster.createDb("column_order_dep_shadow");
    try {
      await src.pool.query(`
        CREATE SCHEMA s;
        CREATE TYPE s.mood AS ENUM ('a', 'b');
        CREATE FUNCTION s.my_uuid() RETURNS uuid LANGUAGE sql AS 'SELECT gen_random_uuid()';
        CREATE TABLE s.o1 (id uuid DEFAULT s.my_uuid(), name text);
        CREATE TABLE s.o2 (x int, m s.mood, y int, m2 s.mood, z int);
        CREATE TABLE s.o3 (a int, g int GENERATED ALWAYS AS (a * 2) STORED, z int);
      `);
      const fb = (await extract(src.pool)).factBase;
      const files = forLoad(exportSqlFiles(fb, { layout: "by-object" }));
      const loaded = await loadSqlFiles(files, shadow.pool);
      expect(loaded.factBase.rootHash).toBe(fb.rootHash);
      expect(await columnOrder(shadow.pool, "s.o1")).toEqual(["id", "name"]);
      expect(await columnOrder(shadow.pool, "s.o2")).toEqual([
        "x",
        "m",
        "y",
        "m2",
        "z",
      ]);
      expect(await columnOrder(shadow.pool, "s.o3")).toEqual(["a", "g", "z"]);
    } finally {
      await Promise.all([src.drop(), shadow.drop()]);
    }
  }, 120_000);

  // The #518 attnum chain is scoped to tables CREATED in the plan (no rows, so
  // no default is evaluated). ADD COLUMNs on an EXISTING populated table keep
  // dependency order: `x`'s volatile default calls a function whose quoted body
  // (invisible to pg_depend) reads a view over the later column `y`, so `x`'s
  // backfill must run after `y` and the view exist.
  test("ADD COLUMNs on a populated existing table keep dependency order", async () => {
    const cluster = await sharedCluster();
    const src = await cluster.createDb("column_order_existing_src");
    const dst = await cluster.createDb("column_order_existing_dst");
    try {
      await src.pool.query(`
        CREATE SCHEMA app;
        CREATE TABLE app.t (a int);
        INSERT INTO app.t VALUES (1), (2);
      `);
      await dst.pool.query(`
        CREATE SCHEMA app;
        CREATE TABLE app.t (a int, x int, y int);
        CREATE VIEW app.v AS SELECT y FROM app.t;
        CREATE FUNCTION app.wrapper() RETURNS int LANGUAGE sql VOLATILE
          AS $$ SELECT count(*)::int FROM app.v $$;
        ALTER TABLE app.t ALTER COLUMN x SET DEFAULT app.wrapper();
      `);
      const [s, d] = [await extract(src.pool), await extract(dst.pool)];
      const report = await apply(plan(s.factBase, d.factBase), src.pool, {
        fingerprintGate: false,
      });
      expect(report.error?.message).toBeUndefined();
      expect(report.status).toBe("applied");
      const after = await extract(src.pool);
      expect(diff(after.factBase, d.factBase)).toEqual([]);
      const rows = await src.pool.query("SELECT a, x FROM app.t ORDER BY a");
      expect(rows.rows).toEqual([
        { a: 1, x: 2 },
        { a: 2, x: 2 },
      ]);
    } finally {
      await Promise.all([src.drop(), dst.drop()]);
    }
  }, 120_000);

  // The fold link (step 2 of the #518 chain) must not hoist a prerequisite whose
  // closure runs user code at creation: here `x`'s BEGIN ATOMIC default reads a
  // WITH DATA matview populated through a quoted helper that reads the very
  // table being created. pg_depend cannot see the helper's read, so hoisting
  // the matview before CREATE TABLE fails with `relation "app.t" does not exist`.
  test("a fold prerequisite that populates through the new table stays after it", async () => {
    const cluster = await sharedCluster();
    const src = await cluster.createDb("column_order_eval_src");
    const tgt = await cluster.createDb("column_order_eval_tgt");
    const shadow = await cluster.createDb("column_order_eval_shadow");
    try {
      await src.pool.query(`
        CREATE SCHEMA app;
        CREATE TABLE app.t (a int);
        CREATE FUNCTION app.table_count() RETURNS int LANGUAGE sql
          AS $$ SELECT count(*)::int FROM app.t $$;
        CREATE MATERIALIZED VIEW app.counts AS SELECT app.table_count() AS n;
        CREATE FUNCTION app.snapshot_count() RETURNS int LANGUAGE sql
          BEGIN ATOMIC SELECT n FROM app.counts; END;
        ALTER TABLE app.t ADD COLUMN x int DEFAULT app.snapshot_count();
      `);
      const fb = (await extract(src.pool)).factBase;
      const empty = (await extract(tgt.pool)).factBase;
      const report = await apply(plan(empty, fb), tgt.pool, {
        fingerprintGate: false,
      });
      expect(report.error?.message).toBeUndefined();
      expect(report.status).toBe("applied");
      expect(diff((await extract(tgt.pool)).factBase, fb)).toEqual([]);
      const files = forLoad(exportSqlFiles(fb, { layout: "by-object" }));
      const loaded = await loadSqlFiles(files, shadow.pool);
      expect(loaded.factBase.rootHash).toBe(fb.rootHash);
    } finally {
      await Promise.all([src.drop(), tgt.drop(), shadow.drop()]);
    }
  }, 120_000);
});
