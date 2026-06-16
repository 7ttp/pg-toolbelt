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

/**
 * Reconcile the `--profile` flag with the profile id stamped on a plan artifact
 * (apply/prove). The apply/prove profile MUST match the plan's, so:
 *
 * - `--profile` omitted → use the plan's stamped id (or undefined → raw when the
 *   plan carries no profile, i.e. it came from a direct library `plan()` call
 *   with no integration);
 * - `--profile` given → use it, but throw if it contradicts the plan's stamp.
 *
 * The returned id is fed to {@link resolveCliProfile} / {@link profileById},
 * which rejects an id unknown to this binary.
 */
export function effectiveProfileId(
  flagId: string | undefined,
  planProfileId: string | undefined,
): string | undefined {
  if (
    flagId !== undefined &&
    planProfileId !== undefined &&
    flagId !== planProfileId
  ) {
    throw new UsageError(
      `--profile ${flagId} does not match the plan's profile "${planProfileId}"; ` +
        `the apply/prove profile must match the plan profile — omit --profile to use the plan's, ` +
        `or re-plan with --profile ${flagId}`,
    );
  }
  return flagId ?? planProfileId;
}
