/**
 * Unit tests for CLI profile selection (src/cli/profile.ts). No DB.
 */
import { describe, expect, test } from "bun:test";
import { rawProfile } from "../integrations/profile.ts";
import { supabaseProfile } from "../integrations/supabase.ts";
import { UsageError } from "./flags.ts";
import { profileById } from "./profile.ts";

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
