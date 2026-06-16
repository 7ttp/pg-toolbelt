# pg-delta-next: integration profile / managed-view design

Date: 2026-06-16
Branch: `feat/pg-delta-next`
Addresses: `docs/archive/pg-delta-next-architecture-handoff-review-2026-06-16.md` (findings P0–P3)

## Problem

The engine has the right pieces (facts, `resolveView`, handlers, baseline, capability)
but the *safe integration view is not first-class*. Managed-object exclusion,
extension handlers, baseline subtraction, capability, proof re-extraction, and apply
fingerprinting are wired in different places, so the default product path (and the
CLI) can plan against a raw view that still contains operationally-managed objects.
Verified findings:

- **P0 (data loss):** `resolveView` excludes `memberOfExtension` but not `managedBy`;
  `plan`, CLI `plan`, and `apply`'s fingerprint gate all run bare `extract`. pg_partman
  children get dropped unless a caller hand-composes `extractWithHandlers` + `excludeManaged`.
- **P1 (snapshot incoherence):** `extractWithHandlers` calls `extract` (which BEGIN…
  REPEATABLE READ, COMMIT, release) and *then* runs `handler.capture(pool, …)` on a fresh
  connection — handler facts/edges are not from the core snapshot.
- **P1 (public API):** the 6 safety helpers are not exported from the root or `./policy`,
  yet JSDoc tells users to call them.
- **P2 (CLI):** no `--profile/--policy/--baseline`; `prove`/`apply` throw on a
  baseline-shaped policy but the CLI cannot supply a baseline.
- **P2 (`loadSqlFiles`):** DML detection uses `nspname NOT IN ('pg_catalog','information_schema')`
  only — rejects extension-owned / platform rows.
- **P3 (docs):** `extension-intent.md` claims edge matching lacks `EdgeKind` (now false);
  the "handlers not in CLI" note is accurate and should be lifted into readiness tracking.

## Solution overview

Introduce one managed-view profile that owns "what state is this engine allowed to
manage?", and route every entry point (plan/prove/apply/CLI) through it so
`plan == prove == apply` holds by construction. Make `resolveView` the single
projection point, and make extension handlers run inside the extraction transaction.

### 1. `src/integrations/` module

Split static declaration from runtime-resolved context. Capability and baseline are
resolved against a live pool *once* and shared across plan/prove/apply — that shared
identity is the `plan == prove == apply` guarantee.

```ts
export interface IntegrationProfile {
  readonly id: string;
  readonly handlers: readonly ExtensionHandler[];
  readonly policy?: Policy;
}

export interface ResolvedProfile {
  readonly id: string;
  extract(pool: Pool, options?: ExtractOptions): Promise<ExtractResult>; // handler-aware
  readonly planOptions: PlanOptions;   // { policy, capability, baseline }
  readonly proveOptions: ProveOptions; // { reextract: handler-aware, policy, capability, baseline }
  readonly applyOptions: ApplyOptions; // { reextract: handler-aware, baseline }
}

export async function resolveProfile(
  pool: Pool,
  profile: IntegrationProfile,
  opts?: { restrictToApplier?: boolean; baselineDir?: string },
): Promise<ResolvedProfile>;

export const supabaseProfile: IntegrationProfile; // SUPABASE_EXTENSION_HANDLERS + supabasePolicy
export const rawProfile: IntegrationProfile;       // no handlers, no policy (generic/test default)
```

`resolveProfile` probes pgMajor + (optionally) `probeApplierCapability`, resolves the
policy's declared baseline snapshot via `resolveBaseline`, and bakes policy + capability
+ baseline into the three option bundles. This supplies the baseline that `prove`/`apply`
demand of a baseline-shaped policy.

### 2. P0 — `resolveView` is the single projection point

```ts
base = excludeByProvenance(base, "memberOfExtension");
base = excludeByProvenance(base, "managedBy");   // NEW — unconditional
```

Safe unconditionally: `managedBy` edges exist only when handlers ran, so it is a no-op
under bare extraction and drops managed children on both sides under handler-aware
extraction — in `plan`, in `prove`'s re-extract, and in `apply`'s fingerprint gate (all
already call `resolveView`). The data-loss path closes structurally.

### 3. P1 — handlers fold into snapshot-bound `extract`

```ts
extract(pool, { source?, statementTimeoutMs?, handlers? })  // handlers default []
```

`extractOnClient` runs core extraction, builds a preliminary fact base, runs each handler
on the **same snapshot-bound client inside the same REPEATABLE READ transaction** before
COMMIT, then merges. The handler interface becomes snapshot-bound:

```ts
interface HandlerContext { query(sql: string, params?: unknown[]): Promise<Row[]>; readonly pgMajor: number; }
export interface ExtensionHandler {
  readonly extension: string;
  capture(ctx: HandlerContext, current: FactBase): Promise<CaptureResult>;
}
```

**Layering:** `ExtensionHandler` / `HandlerContext` / `CaptureResult` *types* move to the
extract layer (e.g. `src/extract/handler.ts`) so `extract` can reference them without
importing `policy` (which would be a cycle: `policy` already imports `extract`). Concrete
handlers (`pgPartmanHandler`) stay in `src/policy/extensions/` and import the type.

Consequences (approved):
- **Delete `extractWithHandlers` and `extractManaged`** — redundant once `resolveView`
  owns `managedBy`. The canonical re-extractor is `extract(pool, { handlers })`. (Package
  is private/unreleased, so removal is free.)
- **`apply` gains `reextract?: (pool) => Promise<{ factBase }>`** mirroring `prove`, so the
  fingerprint gate re-extracts handler-aware instead of via bare `extract(target)`.

### 4. P1 — public API surface

- New subpath `@supabase/pg-delta-next/integrations` exporting the profile API
  (`IntegrationProfile`, `ResolvedProfile`, `resolveProfile`, `supabaseProfile`,
  `rawProfile`, `ExtensionHandler`, `pgPartmanHandler`, `SUPABASE_EXTENSION_HANDLERS`,
  `probeApplierCapability`, `ApplierCapability`).
- Root `index.ts` re-exports the headline profile API. JSDoc that names removed helpers
  is rewritten to point at the profile.

### 5. P2 — CLI `--profile`

`plan`/`apply`/`prove` gain `--profile <id>` (`supabase` | `raw`, default `raw`). With
`--profile supabase` the command calls `resolveProfile(pool, supabaseProfile, { restrictToApplier })`
and threads `ctx.extract` + `ctx.{plan,prove,apply}Options`. This supplies the baseline
`prove`/`apply` need. `--restrict-to-applier` stays (folds into resolve options). Raw mode
stays the default. Explicit `--baseline <path>` is deferred as an escape hatch.

### 6. P2 — `loadSqlFiles` DML check

Reuse the shared scope predicate from `scope.ts` (`USER_SCHEMA_FILTER` + `notExtensionMember()`)
so `pg_toast`/`pg_temp` and extension-owned relations are excluded. Report quoted relation
names with provenance. Extension-created internal rows stop being rejected; user DML still is.

### 7. P3 — docs

- `extension-intent.md`: delete the stale "edge matching is missing `EdgeKind`" claim;
  rewrite "remaining for production" (handlers now compose into the CLI via the profile).
- `managed-view-architecture.md`: state `resolveView` is the single projection point
  (memberOfExtension + managedBy); document the profile.
- Add a short readiness section: current / v1-required / Phase-B intent / deferred.

## Testing (RED first)

Unit:
- `resolveView` drops `managedBy` (and is a no-op without managed edges).
- handler `capture` runs on the same snapshot-bound context as core extraction (mock client).
- `resolveProfile` composes options correctly (shared policy/capability/baseline).
- public import-surface test (root + `./integrations`).

Integration (`withDb` + pg_partman / `withDbSupabaseIsolated` where relevant):
- `plan --profile supabase` emits no partman-child drops when desired declares only the parent.
- `apply` fingerprint gate passes for a managed-aware plan with operational children present.
- `prove --profile supabase` reports no operational children as drift.
- `loadSqlFiles` accepts extension-created internal rows but rejects user DML.

Final validation:
- `bun run format-and-lint:fix && bun run check-types && bun run knip --fix`.
- Full corpus run on PG 17 (`resolveView` change fires across every scenario).

## Out of scope / deferred

- Explicit `--baseline <path>` and `--policy <file>` CLI flags (profile covers the safe path).
- Phase-B extension *intent* facts (handlers currently emit `managedBy` filter edges only).
- No changeset (package is private/unreleased).
