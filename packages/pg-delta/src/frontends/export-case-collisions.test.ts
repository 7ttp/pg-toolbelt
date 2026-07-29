import { describe, expect, test } from "bun:test";
import { buildFactBase, type Fact } from "../core/fact.ts";
import { hashString } from "../core/hash.ts";
import { exportSqlFiles } from "./export-sql-files.ts";

type Layout = "by-object" | "grouped" | "ordered";

function tableFacts(schema: string, names: readonly string[]): Fact[] {
  return [
    { id: { kind: "schema", name: schema }, payload: {} },
    ...names.map(
      (name): Fact => ({
        id: { kind: "table", schema, name },
        parent: { kind: "schema", name: schema },
        payload: { persistence: "p" },
      }),
    ),
  ];
}

function exportNames(facts: Fact[], layout: Layout): string[] {
  return exportSqlFiles(buildFactBase(facts, []), { layout }).map(
    (file) => file.name,
  );
}

function expectCaseInsensitivelyUniquePathTree(paths: readonly string[]): void {
  const prefixes = new Set<string>();
  for (const path of paths) {
    const segments = path.split("/");
    for (let index = 1; index <= segments.length; index++) {
      prefixes.add(segments.slice(0, index).join("/"));
    }
  }
  expect(new Set([...prefixes].map((path) => path.toLowerCase())).size).toBe(
    prefixes.size,
  );
}

describe("schema export case-colliding paths", () => {
  for (const layout of ["by-object", "grouped"] as const) {
    test(`${layout} disambiguates case-twin tables without renaming unrelated files`, () => {
      const paths = exportNames(
        tableFacts("public", ["Users", "users", "orders"]),
        layout,
      );

      expect(paths).toHaveLength(3);
      expectCaseInsensitivelyUniquePathTree(paths);
      expect(paths).toContain("schemas/public/tables/orders.sql");
      expect(paths).not.toContain("schemas/public/tables/Users.sql");
      expect(paths).not.toContain("schemas/public/tables/users.sql");
      expect(paths).toEqual(
        expect.arrayContaining([
          "schemas/public/tables/Users-3a09f326.sql",
          "schemas/public/tables/users-33e768af.sql",
        ]),
      );
    });
  }

  for (const layout of ["by-object", "grouped"] as const) {
    test(`${layout} disambiguates every collision in the path tree`, () => {
      const paths = exportNames(
        [...tableFacts("App", ["items"]), ...tableFacts("app", ["items"])],
        layout,
      );

      expect(paths).toHaveLength(4);
      expectCaseInsensitivelyUniquePathTree(paths);
      expect(paths.some((path) => path.startsWith("schemas/App-"))).toBe(true);
      expect(paths.some((path) => path.startsWith("schemas/app-"))).toBe(true);
    });
  }

  test("ordered paths remain unchanged when sequence prefixes already make them portable", () => {
    const paths = exportNames(
      tableFacts("public", ["Users", "users"]),
      "ordered",
    );

    expectCaseInsensitivelyUniquePathTree(paths);
    expect(paths).toHaveLength(2);
    expect(paths.every((path) => /^\d{4}_/.test(path))).toBe(true);
    expect(
      paths.every((path) => !/-[0-9a-f]{8}(?:-\d+)?\.sql$/.test(path)),
    ).toBe(true);
  });

  test("disambiguates collisions introduced by grouped routing", () => {
    const paths = exportSqlFiles(
      buildFactBase(tableFacts("public", ["alpha", "beta"]), []),
      {
        layout: "grouped",
        grouping: {
          mode: "single-file",
          groupPatterns: [
            { pattern: "^alpha$", name: "Auth" },
            { pattern: "^beta$", name: "auth" },
          ],
        },
      },
    ).map((file) => file.name);

    expect(paths).toHaveLength(2);
    expectCaseInsensitivelyUniquePathTree(paths);
  });

  test("renames are deterministic and independent of fact order", () => {
    const facts = tableFacts("public", ["Users", "users"]);
    const forward = exportNames(facts, "by-object").sort();
    const reverse = exportNames([...facts].reverse(), "by-object").sort();

    expect(forward).toEqual(reverse);
  });

  test("does not overwrite an existing hash-shaped file name", () => {
    const originalPath = "schemas/public/tables/Users.sql";
    const shortHash = hashString(originalPath).slice(0, 8);
    const occupiedName = `Users-${shortHash}`;
    const paths = exportNames(
      tableFacts("public", ["Users", "users", occupiedName]),
      "by-object",
    );

    expectCaseInsensitivelyUniquePathTree(paths);
    expect(paths).toContain(`schemas/public/tables/${occupiedName}.sql`);
    expect(paths).toContain(`schemas/public/tables/Users-${shortHash}-1.sql`);
  });
});
