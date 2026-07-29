import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { collectSqlFiles } from "../src/cli/commands/schema.ts";
import { extract } from "../src/extract/extract.ts";
import { readExportManifest } from "../src/frontends/export-manifest.ts";
import { sharedCluster } from "./containers.ts";

const PKG_DIR = new URL("..", import.meta.url).pathname.replace(/\/$/, "");
const CLI = join(PKG_DIR, "src/cli/main.ts");

interface SpawnResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

async function runCli(args: string[]): Promise<SpawnResult> {
  const proc = Bun.spawn(["bun", CLI, ...args], {
    cwd: PKG_DIR,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { stdout, stderr, exitCode: await proc.exited };
}

describe("schema export case-colliding paths", () => {
  test("case-twin objects survive CLI export and apply on a case-insensitive filesystem", async () => {
    const cluster = await sharedCluster();
    const source = await cluster.createDb("export_case_twins_source");
    const target = await cluster.createDb("export_case_twins_target");
    const outDir = mkdtempSync(join(tmpdir(), "pgdelta-case-twins-"));

    try {
      await source.pool.query(`
        CREATE TABLE public."Users" (
          id integer PRIMARY KEY,
          peer_id integer
        );
        CREATE TABLE public."users" (
          id integer PRIMARY KEY,
          peer_id integer
        );
        ALTER TABLE public."Users"
          ADD CONSTRAINT users_lower_fk
          FOREIGN KEY (peer_id) REFERENCES public."users" (id);
        ALTER TABLE public."users"
          ADD CONSTRAINT users_upper_fk
          FOREIGN KEY (peer_id) REFERENCES public."Users" (id);
        CREATE VIEW public.upper_users AS
          SELECT id FROM public."Users";
        CREATE VIEW public.lower_users AS
          SELECT id FROM public."users";
        CREATE SCHEMA "App";
        CREATE SCHEMA "app";
        CREATE TABLE "App".items (id integer PRIMARY KEY);
        CREATE TABLE "app".items (id integer PRIMARY KEY);
      `);

      const exportArgs = [
        "schema",
        "export",
        "--source",
        source.uri,
        "--out-dir",
        outDir,
      ];
      const exported = await runCli(exportArgs);
      expect(exported.exitCode).toBe(0);

      const reexported = await runCli(exportArgs);
      const manifestFiles = readExportManifest(outDir)?.files ?? [];
      const manifestFileCount = manifestFiles.length;
      const physicalFiles = collectSqlFiles(outDir);
      const physicalManifestFiles = physicalFiles
        .map((file) => file.name.split(sep).join("/"))
        .sort();

      const applied = await runCli([
        "schema",
        "apply",
        "--dir",
        outDir,
        "--target",
        target.uri,
        "--renames",
        "off",
      ]);

      const targetTables = await target.pool.query<{ relname: string }>(`
        SELECT c.relname
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relkind = 'r'
          AND c.relname IN ('Users', 'users')
        ORDER BY c.relname COLLATE "C"
      `);
      const [sourceState, targetState] = await Promise.all([
        extract(source.pool),
        extract(target.pool),
      ]);

      expect({
        manifestTableFiles: manifestFiles.filter((name) =>
          name.includes("/tables/"),
        ).length,
        manifestForeignKeyFiles: manifestFiles.filter((name) =>
          name.endsWith(".fk.sql"),
        ).length,
        caseInsensitiveManifestFiles: new Set(
          manifestFiles.map((name) => name.toLowerCase()),
        ).size,
        physicalFiles: physicalFiles.length,
        physicalManifestFiles,
        reexportExitCode: reexported.exitCode,
        applyExitCode: applied.exitCode,
        shadowLoadStuck: /shadow load stuck/i.test(applied.stderr),
        targetTables: targetTables.rows.map((row) => row.relname),
        targetRootHash: targetState.factBase.rootHash,
      }).toEqual({
        manifestTableFiles: 6,
        manifestForeignKeyFiles: 2,
        caseInsensitiveManifestFiles: manifestFileCount,
        physicalFiles: manifestFileCount,
        physicalManifestFiles: [...manifestFiles].sort(),
        reexportExitCode: 0,
        applyExitCode: 0,
        shadowLoadStuck: false,
        targetTables: ["Users", "users"],
        targetRootHash: sourceState.factBase.rootHash,
      });
    } finally {
      rmSync(outDir, { recursive: true, force: true });
      await Promise.all([source.drop(), target.drop()]);
    }
  }, 120_000);
});
