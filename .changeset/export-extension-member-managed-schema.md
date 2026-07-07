---
"@supabase/pg-delta": patch
---

Fix `schema export` crashing with `FactBase: fact … references missing parent`
when an extension is installed into a non-`public` schema (e.g. `pg_partman` in
`partman`, `hstore` in a custom schema). The export baseline seeded every
reference-only fact but not its ancestors; an extension member whose parent
schema is managed had a dangling parent. Extension members are now excluded from
the export baseline — they never needed seeding (`CREATE EXTENSION` materializes
them and the planner's requirement guard satisfies any consumer), and the managed
install schema is still exported so the result reloads.
