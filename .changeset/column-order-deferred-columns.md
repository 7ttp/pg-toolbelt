---
"@supabase/pg-delta": patch
---

Keep a table's declared column order when a plan creates it, or when it is exported and reloaded, if a column is generated or waits on a same-schema type. Before, such a column was added after the columns declared behind it, so `SELECT *`, positional `INSERT` and `COPY` without a column list saw a different order. Two cases still put a column after the columns declared behind it: a column that calls a user function directly or through a column or type it reads (Postgres can run the function when the column is added, and it may read a later column), and a generated column declared before a column it reads. A generated column that reads a `DEFAULT` column of the first kind can still pull it ahead of the later column its function reads, which fails the plan.
