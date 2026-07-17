/**
 * schema export --source <pg-url> --out-dir <dir> [--layout by-object|ordered|grouped]
 *   Export the source database as SQL files written to disk.
 *   Maps to old `declarative-export`.
 *
 *   Layouts:
 *     by-object (default) — the familiar tree (schemas/<s>/tables/<t>.sql, …),
 *       files in dependency/plan order.
 *     ordered — numbered files in plan order; the loader converges in one pass.
 *     grouped — the old engine's "nice" export: files ordered by semantic
 *       category (cluster → schema → types → tables → views → …), statements
 *       sorted within a file for readability, plus opt-in grouping:
 *         --grouping-mode single-file|subdirectory  (default subdirectory)
 *         --group-patterns '[{"pattern":"^auth_","name":"auth"}]'  (first match wins)
 *         --flat-schemas partman,audit   (collapse a schema to one file/category)
 *         --no-group-partitions          (keep partition children in their own files)
 *
 *   --format-options '<json>'  (any layout) — pretty-print each file's SQL with
 *     the formatter (frontends/sql-format), e.g. '{"keywordCase":"upper","maxWidth":180}'.
 *     Off by default (raw renderer output). Cosmetic — load(export) ≡ db still holds.
 *
 * schema apply --dir <dir> --shadow <pg-url> --target <pg-url>
 *              [--renames auto|prompt|off] [--force]
 *              [--accept-rename <from>=<to>] (repeatable) [--no-reorder]
 *   Read .sql files recursively (lexicographic), load into shadow, extract
 *   target, plan, apply.  Maps to old `declarative-apply` / `sync`.
 *
 *   By default the SQL files are passed through the statement-reordering assist
 *   (target-architecture §4.4.1): each file is split into one-statement units
 *   and topologically pre-sorted before loading, so authoring order within a
 *   file no longer matters and the shadow loader converges in fewer rounds. The
 *   assist is advisory — Postgres still elaborates the shadow — so it can only
 *   fail to BUILD the shadow (a visible error), never corrupt the desired state.
 *
 *   --no-reorder
 *     Skip the reordering assist and load the raw files at file granularity
 *     (the original behavior). Useful for debugging a stuck load.
 *
 *   --accept-rename <from>=<to>
 *     Confirm one rename candidate by the encoded stable-ids shown in a prior
 *     --renames prompt run.  Repeatable; each flag names one confirmed rename.
 */
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, dirname, relative, resolve, sep } from "node:path";
import type {
  ExportGrouping,
  ExportGroupingPattern,
} from "../../frontends/export-sql-files.ts";
import type { SqlFormatOptions } from "../../frontends/sql-format/index.ts";
import { pruneStaleSqlFiles } from "../../frontends/prune-sql-files.ts";
import {
  readExportManifest,
  writeExportManifest,
} from "../../frontends/export-manifest.ts";
import { type SqlFile } from "../../frontends/load-sql-files.ts";
import { analyzeForShadow } from "../../frontends/sql-order.ts";
import { buildSchemaExport } from "../../frontends/schema-export.ts";
import {
  planSchemaFiles,
  prepareSchemaFiles,
  SchemaFrontendError,
} from "../../frontends/schema-plan.ts";
import {
  appendShadowCycleHint,
  formatLintReport,
  rewriteReorderedShadowError,
} from "../reorder-display.ts";
import type { ManagementScope } from "../../policy/view.ts";
import { apply } from "../../apply/apply.ts";
import { encodeId, parseId, type StableId } from "../../core/stable-id.ts";
import { exitIfBlocking, printDiagnostics } from "../diagnostics.ts";
import { makePool } from "../pool.ts";
import {
  type CoLocatedShadow,
  isShadowProvisionError,
  provisionCoLocatedShadow,
} from "../shadow.ts";
import { parseFlags, UsageError } from "../flags.ts";
import { effectiveProfileId, PROFILE_IDS, profileById } from "../profile.ts";
import type { RenameMode } from "../../plan/renames.ts";

/** Recursively collect *.sql files in lexicographic order. Exported for tests. */
export function collectSqlFiles(dir: string): SqlFile[] {
  // Derive names from the NORMALIZED root, not by slicing the raw `--dir` string:
  // a trailing slash or non-normalized segment would make `dir.length + 1` drop
  // the first character of every relative path (`01_schema.sql` → `1_schema.sql`),
  // corrupting the lexicographic order the raw loader relies on (review P2).
  const root = resolve(dir);
  const result: SqlFile[] = [];
  const recurse = (current: string): void => {
    const entries = readdirSync(current).sort();
    for (const entry of entries) {
      const full = join(current, entry);
      const st = statSync(full);
      if (st.isDirectory()) {
        recurse(full);
      } else if (entry.endsWith(".sql")) {
        result.push({
          name: relative(root, full), // relative path from the normalized dir
          sql: readFileSync(full, "utf8"),
        });
      }
    }
  };
  recurse(root);
  return result;
}

/**
 * Write the exported SQL files and the `.pgdelta-export.json` manifest under
 * `outRoot`, returning the stale files pruned. Exported for tests.
 *
 * Creates `outRoot` up front: a database with no managed objects legitimately
 * yields zero files, and the per-file loop (which only mkdirs each file's parent)
 * would then never create the root, so the manifest write would ENOENT (review
 * P2). Stale `.sql` files from a previous export are pruned first so a dropped
 * object's file can't linger and be reloaded (only `.sql` not in the new set;
 * non-SQL untouched).
 */
export function writeExportFiles(
  outRoot: string,
  files: SqlFile[],
  manifest: {
    redactSecrets: boolean;
    profile?: string;
    scope?: "database" | "cluster";
    baselineDigest?: string;
    defaultOwner?: string | null;
  },
): string[] {
  mkdirSync(outRoot, { recursive: true });
  const keep = new Set(files.map((file) => join(outRoot, file.name)));
  const removed = pruneStaleSqlFiles(outRoot, keep);
  for (const file of files) {
    const full = join(outRoot, file.name);
    // defense-in-depth (review P2): even with per-segment encoding in
    // exportSqlFiles, never let a database identifier escape the output dir.
    if (full !== outRoot && !full.startsWith(outRoot + sep)) {
      throw new Error(
        `export: refusing to write outside ${outRoot}: ${file.name}`,
      );
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, file.sql, "utf8");
  }
  writeExportManifest(outRoot, manifest);
  return removed;
}

export async function cmdSchemaExport(args: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseFlags(args, {
      source: { type: "value", required: true },
      "out-dir": { type: "value", required: true },
      layout: { type: "value" },
      profile: { type: "value" },
      "strict-coverage": { type: "boolean" },
      "unsafe-show-secrets": { type: "boolean" },
      "grouping-mode": { type: "value" },
      "group-patterns": { type: "value" },
      "flat-schemas": { type: "value" },
      "no-group-partitions": { type: "boolean" },
      "format-options": { type: "value" },
      "no-format": { type: "boolean" },
      scope: { type: "value" },
      "default-owner": { type: "value" },
    });
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(
        `${err.message}\nUsage: pgdelta schema export --source <pg-url> --out-dir <dir> ` +
          `[--layout by-object|ordered|grouped] [--profile ${PROFILE_IDS}] [--strict-coverage] [--unsafe-show-secrets] [--scope database|cluster]\n` +
          `  [--default-owner <role|none>] (which owner stays implicit; default: profile default or the database owner; "none" emits every OWNER TO)\n` +
          `  [--format-options '{"keywordCase":"upper","maxWidth":180}'] [--no-format]\n` +
          `    (SQL is pretty-printed by default: lowercase keywords, width 180; any layout)\n` +
          `  Grouped-layout options (only with --layout grouped):\n` +
          `    [--grouping-mode single-file|subdirectory] [--group-patterns <json>] [--flat-schemas <csv>] [--no-group-partitions]\n`,
      );
      process.exit(2);
    }
    throw err;
  }

  const { flags } = parsed;
  const sourceUrl = flags["source"];
  const outDir = flags["out-dir"];
  // Management scope of the export (default database-local). `database` omits
  // cluster-global roles/memberships so the directory reloads on any cluster;
  // `cluster` includes them. Stamped in the manifest so `schema apply` matches.
  let exportScope: ManagementScope = "database";
  const exportScopeFlag = flags["scope"];
  if (exportScopeFlag === "database" || exportScopeFlag === "cluster") {
    exportScope = exportScopeFlag;
  } else if (exportScopeFlag !== undefined) {
    process.stderr.write(
      `--scope must be database or cluster (got: ${exportScopeFlag})\n`,
    );
    process.exit(2);
  }
  let layout: "by-object" | "ordered" | "grouped" = "by-object";
  if (flags["layout"] !== undefined) {
    const v = flags["layout"];
    if (v !== "by-object" && v !== "ordered" && v !== "grouped") {
      process.stderr.write(
        `--layout must be by-object, ordered, or grouped (got: ${v})\n`,
      );
      process.exit(2);
    }
    layout = v;
  }

  // Grouping options apply only to the grouped layout. Parse them up front so
  // a malformed value fails before connecting to the database.
  let grouping: ExportGrouping | undefined;
  if (layout === "grouped") {
    const mode = flags["grouping-mode"];
    if (
      mode !== undefined &&
      mode !== "single-file" &&
      mode !== "subdirectory"
    ) {
      process.stderr.write(
        `--grouping-mode must be single-file or subdirectory (got: ${mode})\n`,
      );
      process.exit(2);
    }
    let groupPatterns: ExportGroupingPattern[] | undefined;
    if (flags["group-patterns"] !== undefined) {
      try {
        const raw = JSON.parse(flags["group-patterns"]) as unknown;
        if (
          !Array.isArray(raw) ||
          !raw.every(
            (p): p is ExportGroupingPattern =>
              typeof p === "object" &&
              p !== null &&
              typeof (p as { pattern?: unknown }).pattern === "string" &&
              typeof (p as { name?: unknown }).name === "string",
          )
        ) {
          throw new Error("expected an array of { pattern, name } objects");
        }
        groupPatterns = raw;
      } catch (e) {
        process.stderr.write(
          `--group-patterns must be JSON array of { pattern, name }: ${e instanceof Error ? e.message : String(e)}\n`,
        );
        process.exit(2);
      }
    }
    const flatSchemas = flags["flat-schemas"]
      ?.split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "");
    grouping = {
      ...(mode !== undefined ? { mode } : {}),
      ...(groupPatterns !== undefined ? { groupPatterns } : {}),
      ...(flatSchemas !== undefined && flatSchemas.length > 0
        ? { flatSchemas }
        : {}),
      ...(flags["no-group-partitions"] ? { autoGroupPartitions: false } : {}),
    };
  }

  // SQL formatting is ON by default — the export is a human-facing artifact, so
  // it pretty-prints with lowercase keywords and a 180-char width (formatter
  // defaults otherwise: aligned columns). --format-options overrides every
  // knob; --no-format restores the raw renderer output. Layout-agnostic, and
  // purely cosmetic by contract: the fidelity gate (load(export) ≡ fb) covers
  // the formatter. Parsed up front so a malformed value fails before connecting.
  let format: SqlFormatOptions | undefined = flags["no-format"]
    ? undefined
    : { keywordCase: "lower", maxWidth: 180 };
  if (flags["format-options"] !== undefined) {
    if (flags["no-format"]) {
      process.stderr.write(
        "--format-options and --no-format are mutually exclusive\n",
      );
      process.exit(2);
    }
    try {
      const raw = JSON.parse(flags["format-options"]) as unknown;
      if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
        throw new Error("expected a JSON object");
      }
      format = raw as SqlFormatOptions;
    } catch (e) {
      process.stderr.write(
        `--format-options must be a JSON object (e.g. '{"keywordCase":"upper","maxWidth":180}'): ${e instanceof Error ? e.message : String(e)}\n`,
      );
      process.exit(2);
    }
  }

  const src = makePool(sourceUrl);
  try {
    const redactSecrets = !flags["unsafe-show-secrets"];
    const profile = profileById(flags["profile"]);
    process.stderr.write("Extracting...\n");
    const result = await buildSchemaExport(src.pool, {
      profile,
      scope: exportScope,
      redactSecrets,
      layout,
      ...(grouping !== undefined ? { grouping } : {}),
      ...(format !== undefined ? { format } : {}),
      ...(flags["default-owner"] === "none"
        ? { defaultOwner: null }
        : flags["default-owner"] !== undefined && flags["default-owner"] !== ""
          ? { defaultOwner: flags["default-owner"] }
          : {}),
      onWarning: (message) => process.stderr.write(`  WARNING: ${message}\n`),
    });
    printDiagnostics(result.diagnostics);
    exitIfBlocking(result.diagnostics, {
      strictCoverage: flags["strict-coverage"],
      action: "export",
    });

    const outRoot = resolve(outDir);
    const removed = writeExportFiles(outRoot, result.files, {
      redactSecrets: result.manifest.redactSecrets,
      scope: result.manifest.scope,
      ...(result.manifest.profile !== undefined
        ? { profile: result.manifest.profile }
        : {}),
      ...(result.manifest.baselineDigest !== undefined
        ? { baselineDigest: result.manifest.baselineDigest }
        : {}),
      ...(result.manifest.scope === "database" &&
      "defaultOwner" in result.manifest
        ? { defaultOwner: result.manifest.defaultOwner }
        : {}),
    });
    if (removed.length > 0) {
      process.stderr.write(
        `Removed ${removed.length} stale .sql file(s) from ${outDir}\n`,
      );
    }
    process.stderr.write(
      `Exported ${result.files.length} file(s) to ${outDir} (layout: ${layout})\n`,
    );
  } finally {
    await src.end();
  }
}

/** Discriminated result of {@link prepareApplyFiles}. */
type PreparedApplyFiles =
  | { ok: true; files: SqlFile[]; skipped: { file: string; stmt: string }[] }
  | { ok: false; message: string };

/**
 * Collect and validate the declarative SQL files for `schema apply`, applying the
 * database-scope cluster-DDL policy. Delegates to {@link prepareSchemaFiles}.
 */
export function prepareApplyFiles(
  dir: string,
  scope: "database" | "cluster",
  skipClusterDdl: boolean,
): PreparedApplyFiles {
  const files = collectSqlFiles(dir);
  const prepared = prepareSchemaFiles(files, {
    scope,
    skipClusterDdl,
    label: dir,
  });
  if (!prepared.ok) {
    let message = prepared.message
      .replace(
        /^scope database does not manage/,
        "--scope database does not manage",
      )
      .replace(
        /Use scope cluster \(with an isolated shadow\) to manage roles, or skipClusterDdl to skip these statements\./,
        "Use --scope cluster (with --isolated-shadow) to manage roles, or --skip-cluster-ddl to skip these statements.",
      )
      .replace(/after skipClusterDdl,/, "after --skip-cluster-ddl,");
    if (
      message.includes("no executable SQL found") &&
      !message.includes("Check the --dir path")
    ) {
      message = `${message} Check the --dir path.`;
    }
    return { ok: false, message };
  }
  return prepared;
}

export async function cmdSchemaApply(args: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseFlags(args, {
      dir: { type: "value", required: true },
      shadow: { type: "value" },
      target: { type: "value", required: true },
      renames: { type: "value" },
      force: { type: "boolean" },
      "accept-rename": { type: "multi" },
      profile: { type: "value" },
      "restrict-to-applier": { type: "boolean" },
      "strict-coverage": { type: "boolean" },
      "strict-function-bodies": { type: "boolean" },
      "no-reorder": { type: "boolean" },
      "unsafe-show-secrets": { type: "boolean" },
      "isolated-shadow": { type: "boolean" },
      scope: { type: "value" },
      "skip-cluster-ddl": { type: "boolean" },
      "keep-shadow": { type: "boolean" },
    });
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(
        `${err.message}\nUsage: pgdelta schema apply --dir <dir> --target <pg-url> [--shadow <pg-url>] ` +
          `[--renames auto|prompt|off] [--force] [--accept-rename <from>=<to>] ... ` +
          `[--profile ${PROFILE_IDS}] [--restrict-to-applier] [--strict-coverage] [--strict-function-bodies] [--no-reorder] [--unsafe-show-secrets] [--isolated-shadow] [--scope database|cluster] [--skip-cluster-ddl] [--keep-shadow]\n` +
          `  --shadow omitted: a co-located shadow database is created on the target's cluster (database scope only) and dropped after.\n`,
      );
      process.exit(2);
    }
    throw err;
  }

  const { flags } = parsed;
  const dir = flags["dir"];
  const shadowFlag = flags["shadow"];
  const targetUrl = flags["target"];
  const force = flags["force"];
  const acceptRenameRaw = flags["accept-rename"];

  // The export directory's manifest (redaction mode, profile, scope), consulted
  // once and reused. Absent for hand-authored dirs / older exports.
  const manifest = readExportManifest(dir);

  // Management scope (declarative default: database-local). `cluster` scope
  // manages roles/memberships/ownership and therefore REQUIRES an isolated
  // shadow — loading cluster-global role DDL onto a shared shadow cluster would
  // mutate roles other databases use. `database` scope treats roles as ambient
  // (assumed to exist at apply time) and never diffs them (§scope). Prefer the
  // flag, else the manifest's scope, else database; reject a flag that
  // contradicts the manifest (mirrors the profile reconciliation).
  const scopeFlag = flags["scope"];
  if (
    scopeFlag !== undefined &&
    scopeFlag !== "database" &&
    scopeFlag !== "cluster"
  ) {
    process.stderr.write(
      `--scope must be database or cluster (got: ${scopeFlag})\n`,
    );
    process.exit(2);
  }
  if (
    (scopeFlag === "database" || scopeFlag === "cluster") &&
    manifest?.scope !== undefined &&
    scopeFlag !== manifest.scope
  ) {
    process.stderr.write(
      `--scope ${scopeFlag} contradicts the export manifest scope (${manifest.scope}); re-export or drop --scope.\n`,
    );
    process.exit(2);
  }
  let scope: ManagementScope = "database";
  if (scopeFlag === "database" || scopeFlag === "cluster") {
    scope = scopeFlag;
  } else if (manifest?.scope !== undefined) {
    scope = manifest.scope;
  }
  if (scope === "cluster" && !flags["isolated-shadow"]) {
    process.stderr.write(
      `--scope cluster manages cluster-global roles and must run against a dedicated shadow cluster; pass --isolated-shadow.\n`,
    );
    process.exit(2);
  }

  // --renames default for CLI is "prompt"
  let renames: RenameMode = "prompt";
  if (flags["renames"] !== undefined) {
    const v = flags["renames"];
    if (v !== "auto" && v !== "prompt" && v !== "off") {
      process.stderr.write(
        `--renames must be auto, prompt, or off (got: ${v})\n`,
      );
      process.exit(2);
    }
    renames = v;
  }

  // parse --accept-rename <from>=<to> entries
  const acceptRenames: Array<{ from: StableId; to: StableId }> = [];
  for (const entry of acceptRenameRaw) {
    const eqIdx = entry.indexOf("=");
    if (eqIdx === -1) {
      process.stderr.write(
        `--accept-rename value must be in <from>=<to> form (got: ${entry})\n`,
      );
      process.exit(2);
    }
    const fromStr = entry.slice(0, eqIdx);
    const toStr = entry.slice(eqIdx + 1);
    try {
      acceptRenames.push({ from: parseId(fromStr), to: parseId(toStr) });
    } catch (e) {
      process.stderr.write(
        `--accept-rename: invalid stable-id in "${entry}": ${e instanceof Error ? e.message : String(e)}\n`,
      );
      process.exit(2);
    }
  }

  // Collect + validate the declarative SQL files: refuse an empty/comment-only
  // dir (would build an empty shadow and drop every managed object), and enforce
  // the database-scope cluster-DDL policy (refuse, or --skip-cluster-ddl and log
  // each skip). Extracted to prepareApplyFiles so the guards — including the
  // re-check that a --skip-cluster-ddl strip did not empty the input — are unit
  // tested.
  const prepared = prepareApplyFiles(
    dir,
    scope,
    flags["skip-cluster-ddl"] === true,
  );
  if (!prepared.ok) {
    process.stderr.write(`schema apply: ${prepared.message}\n`);
    process.exit(2);
  }
  for (const s of prepared.skipped) {
    process.stderr.write(
      `  SKIP cluster DDL (--skip-cluster-ddl) in ${s.file}: ${s.stmt}\n`,
    );
  }
  let files = prepared.files;

  // The profile MUST match the one the directory was exported with: `schema
  // export --profile supabase` projects out platform schemas/roles, so applying
  // that directory under the default (raw) profile would extract the target's
  // platform state as drift and plan destructive drops. Default to the profile
  // stamped in the export manifest and reject a contradicting --profile before
  // opening any connection, exactly as `apply`/`prove` reconcile plan artifacts
  // (review P1).
  const manifestProfile = manifest?.profile;
  let profileId: string | undefined;
  try {
    profileId = effectiveProfileId(flags["profile"], manifestProfile);
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`${err.message}\n`);
      process.exit(2);
    }
    throw err;
  }

  // Resolve the shadow: an explicit --shadow, else a co-located throwaway
  // database created on the TARGET's own cluster (quick mode). Co-located is
  // database scope only — it shares the target's cluster, so it must never carry
  // cluster-global role DDL. The created database is dropped in the finally.
  let coLocated: CoLocatedShadow | undefined;
  let shadowUrl: string;
  if (shadowFlag !== undefined) {
    shadowUrl = shadowFlag;
  } else {
    if (scope === "cluster") {
      process.stderr.write(
        `schema apply --scope cluster needs an explicit --shadow to a dedicated cluster; a co-located shadow (no --shadow) is database scope only.\n`,
      );
      process.exit(2);
    }
    process.stderr.write(
      `No --shadow given; creating a co-located shadow database on the target's cluster...\n`,
    );
    try {
      coLocated = await provisionCoLocatedShadow(targetUrl, {
        keep: flags["keep-shadow"],
      });
    } catch (e) {
      if (isShadowProvisionError(e)) {
        process.stderr.write(`schema apply: ${e.message}\n`);
        process.exit(2);
      }
      throw e;
    }
    shadowUrl = coLocated.url;
    process.stderr.write(`  Created shadow database ${coLocated.name}\n`);
  }

  const shadow = makePool(shadowUrl);
  const tgt = makePool(targetUrl);
  // Close the pools and drop the co-located throwaway database. Shared by the
  // normal `finally` AND the early-exit guards inside the try below: those call
  // `process.exit`, which SKIPS the finally, so without releasing here first
  // they would leak the co-located shadow database (`--keep-shadow` keeps it).
  const releaseResources = async (): Promise<void> => {
    await Promise.all([shadow.end(), tgt.end()]);
    if (coLocated !== undefined) {
      if (flags["keep-shadow"]) {
        process.stderr.write(`  Kept shadow database ${coLocated.name}\n`);
      }
      await coLocated.cleanup();
    }
  };
  try {
    const redactSecrets =
      manifest?.redactSecrets ?? !flags["unsafe-show-secrets"];
    const profile = profileById(profileId);

    // Hand-authored / pre-feature dirs: surface the same NOTE the old path did.
    if (
      scope === "database" &&
      (manifest === undefined || !("defaultOwner" in manifest))
    ) {
      process.stderr.write(
        `  NOTE: the directory records no default owner, so it is applied verbose ` +
          `(all ownership honored as written). Re-export with the current pg-delta to ` +
          `record a default owner.\n`,
      );
    }

    process.stderr.write("Extracting target / loading shadow...\n");
    let planned;
    try {
      planned = await planSchemaFiles(tgt.pool, shadow.pool, files, {
        profile,
        scope,
        ...(manifest !== undefined ? { manifest } : {}),
        redactSecrets,
        skipClusterDdl: flags["skip-cluster-ddl"] === true,
        isolatedShadow: flags["isolated-shadow"] === true,
        seedAssumedSchemas: coLocated !== undefined,
        renames,
        ...(acceptRenames.length > 0 ? { acceptRenames } : {}),
        resolveOptions: {
          restrictToApplier: flags["restrict-to-applier"],
        },
        strictFunctionBodies: flags["strict-function-bodies"] === true,
        reorder: !flags["no-reorder"],
        onWarning: (message) => {
          if (message.startsWith("the directory records no default owner")) {
            // already printed above for CLI parity
            return;
          }
          process.stderr.write(`  WARNING: ${message}\n`);
        },
        onShadowLoadError: (error, ctx) => {
          let enriched = rewriteReorderedShadowError(
            error,
            ctx.orderedFiles!,
            ctx.originalSqlByName,
          );
          const nonConverging = error.details.some(
            (d) =>
              d.code === "stuck_statement" || d.code === "max_rounds_exceeded",
          );
          if (nonConverging) {
            enriched = appendShadowCycleHint(
              enriched,
              ctx.cycles,
              ctx.originalSqlByName,
            );
          }
          return enriched;
        },
      });
    } catch (err) {
      if (err instanceof SchemaFrontendError) {
        process.stderr.write(`schema apply: ${err.message}\n`);
        await releaseResources();
        process.exit(2);
      }
      if (err instanceof UsageError) {
        process.stderr.write(`${err.message}\n`);
        await releaseResources();
        process.exit(2);
      }
      throw err;
    }

    printDiagnostics(planned.loadDiagnostics, { label: "shadow" });
    printDiagnostics(planned.targetDiagnostics, { label: "target" });
    exitIfBlocking([...planned.loadDiagnostics, ...planned.targetDiagnostics], {
      strictCoverage: flags["strict-coverage"],
      action: "apply",
    });

    const thePlan = planned.plan;
    process.stderr.write(`Planning: ${thePlan.actions.length} action(s)\n`);

    if (renames === "prompt" && thePlan.renameCandidates.length > 0) {
      process.stderr.write(`\nRename candidates:\n`);
      for (const c of thePlan.renameCandidates) {
        const fromStr = encodeId(c.from);
        const toStr = encodeId(c.to);
        if (c.status === "unambiguous") {
          process.stderr.write(
            `  ? Rename ${fromStr} -> ${toStr}? (${c.status})\n`,
          );
          process.stderr.write(
            `    To confirm, rerun with: --accept-rename ${fromStr}=${toStr}\n`,
          );
        } else {
          process.stderr.write(
            `  ${c.status}: ${fromStr} -> ${toStr}${c.reason ? ` (${c.reason})` : ""}\n`,
          );
        }
      }
      process.stderr.write("\n");
    }

    if (thePlan.actions.length === 0) {
      process.stderr.write("Target is already up to date.\n");
      return;
    }

    if (force) {
      process.stderr.write("WARNING: --force disables the fingerprint gate.\n");
    }

    const report = await apply(thePlan, tgt.pool, {
      ...planned.applyOptions,
      reextract: (p) =>
        planned.extract(p, { redactSecrets: planned.redactSecrets }),
      fingerprintGate: !force,
    });

    if (report.status === "applied") {
      process.stderr.write(
        `Applied ${report.appliedActions} action(s) successfully.\n`,
      );
    } else {
      process.stderr.write("Apply failed!\n");
      if (report.error) {
        process.stderr.write(
          `  action[${report.error.actionIndex}]: ${report.error.message}\n`,
        );
        process.stderr.write(`  sql: ${report.error.sql}\n`);
      }
      await releaseResources();
      process.exit(1);
    }
  } finally {
    // drop the co-located throwaway database (after our pools close so nothing
    // holds a connection to it); --keep-shadow makes cleanup a no-op.
    await releaseResources();
  }
}

export async function cmdSchemaLint(args: string[]): Promise<void> {
  let parsed;
  try {
    parsed = parseFlags(args, {
      dir: { type: "value", required: true },
    });
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(
        `${err.message}\nUsage: pgdelta schema lint --dir <dir>\n`,
      );
      process.exit(2);
    }
    throw err;
  }

  const { flags } = parsed;
  const dir = flags["dir"];
  const files = collectSqlFiles(dir);
  if (files.length === 0) {
    process.stderr.write(`No .sql files found in ${dir}.\n`);
    return;
  }

  // Pure static analysis — no shadow/target database. Surfaces pg-topo
  // diagnostics (cycles, unknown statements, duplicate producers, …) for
  // proactive authoring; deliberately kept OUT of the apply path so apply stays
  // Postgres-truth. Throws ReorderUnavailableError (with an install hint) when
  // @supabase/pg-topo is absent.
  const { cycles, diagnostics } = await analyzeForShadow(files);
  const originalSqlByName = new Map(files.map((f) => [f.name, f.sql]));
  const report = formatLintReport({ cycles, diagnostics }, originalSqlByName);

  process.stderr.write(`Linted ${files.length} file(s) in ${dir}.\n`);
  for (const line of report.lines) {
    process.stderr.write(`  ${line}\n`);
  }
  if (report.lines.length === 0) {
    process.stderr.write("No issues found.\n");
  } else {
    process.stderr.write(
      `\n${report.errorCount} error(s), ${report.warningCount} warning(s).\n`,
    );
  }
  if (report.blocking) {
    process.exit(1);
  }
}
