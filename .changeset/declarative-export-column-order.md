---
"@supabase/pg-delta": patch
---

Declarative export (and any plan that creates a table) now creates the table's columns in their declared (attnum) order instead of moving columns that use a same-schema type, a user-function default, or a generated expression to a trailing `ADD COLUMN`. Columns added to an existing table keep their dependency order.
