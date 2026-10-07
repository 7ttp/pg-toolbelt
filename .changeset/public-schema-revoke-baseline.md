---
"@supabase/pg-delta": patch
---

Keep the declarative export's revoke of a default grant on schema `public` when a profile baseline or filter hides the rest of its ACL, and stop exporting one for a grantee the policy filters out. `exportSqlFiles` now takes `revokedPublicGrantees`, the grantees to revoke, in place of `sourcePublicGrantees`.
