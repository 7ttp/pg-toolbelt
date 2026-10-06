---
"@supabase/pg-delta": patch
---

Stop re-emitting triggers whose `WHEN` compares a row of three or more columns on every declarative sync.
