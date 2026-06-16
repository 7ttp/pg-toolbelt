/**
 * CLI profile selection (`--profile <id>`).
 *
 * One flag is the safe, discoverable way to opt into integration semantics:
 * `--profile supabase` composes handler-aware extraction, the Supabase policy,
 * baseline resolution, proof re-extraction, and apply fingerprint reconstruction
 * — instead of asking the operator to hand-assemble that recipe. `raw` (the
 * default) is the unrestricted view for generic users and tests.
 */
import type { Pool } from "pg";
import {
  type IntegrationProfile,
  rawProfile,
  type ResolvedProfile,
  type ResolveProfileOptions,
  resolveProfile,
  supabaseProfile,
} from "../integrations/index.ts";
import { UsageError } from "./flags.ts";

const PROFILES: Record<string, IntegrationProfile> = {
  raw: rawProfile,
  supabase: supabaseProfile,
};

/** The `--profile` value shown in usage strings. */
export const PROFILE_IDS = Object.keys(PROFILES).join(" | ");

/** Map a `--profile` id (default `raw`) to its profile, or throw UsageError. */
export function profileById(id: string | undefined): IntegrationProfile {
  const profile = PROFILES[id ?? "raw"];
  if (profile === undefined) {
    throw new UsageError(
      `--profile must be one of: ${PROFILE_IDS} (got: ${id})`,
    );
  }
  return profile;
}

/** Resolve the selected profile against a live pool (source / target / clone). */
export function resolveCliProfile(
  pool: Pool,
  id: string | undefined,
  options?: ResolveProfileOptions,
): Promise<ResolvedProfile> {
  return resolveProfile(pool, profileById(id), options);
}
