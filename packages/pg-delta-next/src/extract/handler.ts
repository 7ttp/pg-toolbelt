/**
 * Extension handler contract (docs/architecture/extension-intent.md §4.1).
 *
 * A handler is a data package that teaches the integration layer about ONE
 * stateful extension (pg_partman, pgmq, pg_cron, …). It reads the extension's
 * OWN catalogs — `part_config`, `cron.job`, pgmq's `meta`, none of which are
 * `pg_catalog`, so handlers live ABOVE core (P1: capture, never parse) — and
 * emits facts + edges that are merged into the core fact base.
 *
 * The contract lives in the extract layer (not policy/) on purpose: `extract`
 * invokes handlers inside its own snapshot-bound transaction, so it must be able
 * to reference these types WITHOUT importing `policy/` (which already imports
 * `extract`, so the reverse import would be a cycle). Concrete handlers
 * (`pgPartmanHandler`) live in `src/policy/extensions/` and import this type.
 *
 * Phase A (this slice): handlers emit only `managedBy` edges on the objects the
 * extension created operationally, so the managed view (resolveView) projects
 * them out of the schema diff (no data loss). Phase B adds intent facts + replay
 * rules.
 */
import type { DependencyEdge, Fact, FactBase } from "../core/fact.ts";
import type { Row } from "./scope.ts";

/**
 * The snapshot-bound context handed to a handler's `capture`: a query runner
 * tied to the SAME `REPEATABLE READ READ ONLY` transaction (and the same
 * timeout budget) as core catalog extraction. Handler-produced facts/edges
 * therefore describe the exact same moment in database time as the core facts —
 * the coherent-catalog-read guarantee holds across the integration layer too.
 */
export interface HandlerContext {
  /** Run a query on the core extraction snapshot (timeout-aware, same client). */
  query(sql: string): Promise<Row[]>;
}

export interface CaptureResult {
  /** Intent facts (Phase B). Empty for filter-only handlers. */
  facts: Fact[];
  /** Provenance edges (`managedBy`) marking operationally-created objects. */
  edges: DependencyEdge[];
}

export interface ExtensionHandler {
  /** The `pg_extension` name this handler manages. */
  readonly extension: string;
  /**
   * Read the extension's own catalogs and emit facts + edges. Returns empty
   * when the extension is not installed. Runs on the same snapshot-bound `ctx`
   * as core extraction. Must NOT mutate `current`; it is provided so the handler
   * can target only objects that exist as facts (and avoid dangling edges).
   */
  capture(ctx: HandlerContext, current: FactBase): Promise<CaptureResult>;
}
