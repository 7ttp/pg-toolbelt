/**
 * Unit tests for CLI profile selection (src/cli/profile.ts). No DB.
 */
import { describe, expect, test } from "bun:test";
import { rawProfile } from "../integrations/profile.ts";
import { supabaseProfile } from "../integrations/supabase.ts";
import { UsageError } from "./flags.ts";
import { effectiveProfileId, profileById } from "./profile.ts";

describe("profileById", () => {
  test("defaults to the raw profile when no id is given", () => {
    expect(profileById(undefined)).toBe(rawProfile);
    expect(profileById("raw")).toBe(rawProfile);
  });

  test("maps 'supabase' to the Supabase profile", () => {
    expect(profileById("supabase")).toBe(supabaseProfile);
  });

  test("rejects an unknown profile id with a UsageError", () => {
    expect(() => profileById("bogus")).toThrow(UsageError);
    expect(() => profileById("bogus")).toThrow(/--profile must be one of/);
  });
});

describe("effectiveProfileId (apply/prove: flag vs plan-stamped profile)", () => {
  test("uses the flag when given", () => {
    expect(effectiveProfileId("supabase", undefined)).toBe("supabase");
    expect(effectiveProfileId("raw", "raw")).toBe("raw");
  });

  test("defaults to the plan's stamped profile when the flag is omitted", () => {
    expect(effectiveProfileId(undefined, "supabase")).toBe("supabase");
  });

  test("profile-less plan (library plan()) + no flag → undefined (resolves to raw)", () => {
    expect(effectiveProfileId(undefined, undefined)).toBeUndefined();
  });

  test("rejects a flag that contradicts the plan's stamped profile", () => {
    expect(() => effectiveProfileId("raw", "supabase")).toThrow(UsageError);
    expect(() => effectiveProfileId("raw", "supabase")).toThrow(
      /does not match the plan's profile/,
    );
  });
});
