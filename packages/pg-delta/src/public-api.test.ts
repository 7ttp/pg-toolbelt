/**
 * Public API surface guard (addresses P1 of the 2026-06-16 handoff review:
 * the safety model the docs advertise must be assemblable through STABLE
 * imports, not deep source paths).
 *
 * The headline safe path (`resolveProfile` + presets) is reachable from the
 * package root; the full profile surface (capability probing, handlers,
 * custom-profile building blocks) is reachable from the
 * `@supabase/pg-delta/integrations` subpath, which package.json declares.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import * as root from "./index.ts";
import * as integrations from "./integrations/index.ts";

describe("public API surface", () => {
  test("root re-exports the headline profile API", () => {
    expect(typeof root.resolveProfile).toBe("function");
    expect(root.supabaseProfile.id).toBe("supabase");
    expect(root.rawProfile.id).toBe("raw");
  });

  test("the integrations subpath exposes the full profile surface", () => {
    expect(typeof integrations.resolveProfile).toBe("function");
    expect(integrations.supabaseProfile.id).toBe("supabase");
    expect(integrations.rawProfile.id).toBe("raw");
    // building blocks for custom profiles + the safety helpers the docs name
    expect(typeof integrations.probeApplierCapability).toBe("function");
    expect(integrations.pgPartmanHandler.extension).toBe("pg_partman");
    expect(Array.isArray(integrations.SUPABASE_EXTENSION_HANDLERS)).toBe(true);
    expect(integrations.SUPABASE_EXTENSION_HANDLERS).toContain(
      integrations.pgPartmanHandler,
    );
  });

  test("package.json declares the ./integrations subpath export", () => {
    const pkgPath = fileURLToPath(new URL("../package.json", import.meta.url));
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as {
      exports: Record<string, { bun: string; import: string; types: string }>;
    };
    // Dual conditional export: the `bun` condition serves TS source directly,
    // while `import`/`require`/`default` serve the compiled dist for Node.
    const entry = pkg.exports["./integrations"];
    expect(entry).toBeDefined();
    expect(entry?.bun).toBe("./src/integrations/index.ts");
    expect(entry?.import).toBe("./dist/integrations/index.js");
    expect(entry?.types).toBe("./dist/integrations/index.d.ts");
  });
});
