---
"@supabase/pg-delta": patch
---

Fix `schema export` writing a self-referencing foreign key inline in `CREATE TABLE` when the key it references is backed by a standalone `CREATE UNIQUE INDEX`, which made the export fail to load with `there is no unique constraint matching given keys`; the foreign key now renders as an `ALTER TABLE … ADD CONSTRAINT` after the index.
