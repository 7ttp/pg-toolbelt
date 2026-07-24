/**
 * Guardrail 3: PostgreSQL object-kind knowledge belongs in plan/rules/**.
 *
 * Planner-body modules still contain deliberate legacy kind checks. This
 * per-file count ratchet pins that footprint: adding a check fails here, while
 * removing one requires lowering the documented baseline in the same change.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { ALL_FACT_KINDS } from "../core/stable-id.ts";

const PLAN_ROOT = fileURLToPath(new URL(".", import.meta.url));
const FACT_KIND_SET = new Set<string>(ALL_FACT_KINDS);

// Every production module outside plan/rules/** has an entry, including files
// with zero checks. Keep this table sorted by path.
const KIND_LITERAL_BASELINE: Readonly<Record<string, number>> = {
  "artifact.ts": 73,
  "graph.ts": 0,
  "identity-normalize.ts": 17,
  "internal.ts": 28,
  "locks.ts": 18,
  "phases/action-emitter.ts": 10,
  "phases/action-graph.ts": 1,
  "phases/change-set.ts": 4,
  "phases/replacement-expansion.ts": 0,
  "plan.ts": 7,
  "project.ts": 0,
  "renames.ts": 0,
  "render-sql.ts": 0,
  "render.ts": 38,
  "rule-flags.ts": 0,
  "rules.ts": 1,
  "safety.ts": 30,
};

function listPlannerBodyModules(dir: string = PLAN_ROOT): string[] {
  const modules: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (relative(PLAN_ROOT, path).replaceAll("\\", "/") === "rules") {
        continue;
      }
      modules.push(...listPlannerBodyModules(path));
      continue;
    }
    if (!name.endsWith(".ts") || name.endsWith(".test.ts")) continue;
    modules.push(path);
  }
  return modules.sort();
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

function countFactKindLiterals(source: string): number {
  const code = stripComments(source);
  let count = 0;
  for (const match of code.matchAll(/(["'`])([A-Za-z][A-Za-z0-9]*)\1/g)) {
    if (FACT_KIND_SET.has(match[2] ?? "")) count += 1;
  }
  return count;
}

function currentKindLiteralCounts(): Record<string, number> {
  return Object.fromEntries(
    listPlannerBodyModules().map((path) => [
      relative(PLAN_ROOT, path).replaceAll("\\", "/"),
      countFactKindLiterals(readFileSync(path, "utf8")),
    ]),
  );
}

describe("planner body kind-check count ratchet", () => {
  test("detects fact-kind literals but ignores comments and unrelated strings", () => {
    const source = `
      if (fact.id.kind === "table") return;
      switch (parent.kind) {
        case 'schema': return;
        case \`role\`: return;
      }
      // if (fact.id.kind === "policy") return;
      /* case "view": return; */
      throw new Error("not-a-kind");
    `;

    expect(countFactKindLiterals(source)).toBe(3);
  });

  test("does not grow outside plan/rules", () => {
    expect(currentKindLiteralCounts()).toEqual(KIND_LITERAL_BASELINE);
  });
});
