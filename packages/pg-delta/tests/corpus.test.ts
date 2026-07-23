import { describe, expect, test } from "bun:test";
import { loadCorpus } from "./corpus.ts";

describe("loadCorpus direction-specific seeds", () => {
  test("loads seed-b.sql for the reverse direction", () => {
    const scenario = loadCorpus().find(
      (entry) => entry.name === "constraint-ops--convert-pk-to-temporal",
    );

    expect(scenario?.seed).toContain("INSERT INTO test_schema.bookings");
    expect(scenario?.seedB).toContain("INSERT INTO test_schema.bookings");
  });
});

describe("loadCorpus action-shape budgets", () => {
  test("loads and validates budget.json by direction", () => {
    const scenario = loadCorpus().find(
      (entry) => entry.name === "view-operations--options",
    );

    expect(scenario?.actionShapeBudget).toEqual({
      "a-to-b": {
        require: [{ shape: "alter", kind: "view" }],
        forbid: [{ shape: "replacement", kind: "view" }],
      },
      "b-to-a": {
        require: [{ shape: "alter", kind: "view" }],
        forbid: [{ shape: "replacement", kind: "view" }],
      },
    });
  });
});
