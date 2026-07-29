---
"@supabase/pg-delta": patch
---

Prevent schema exports from silently overwriting case-twin objects on case-insensitive filesystems by assigning deterministic portable paths.
