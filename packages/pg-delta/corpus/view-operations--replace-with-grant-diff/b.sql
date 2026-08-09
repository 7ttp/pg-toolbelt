DO $$ BEGIN CREATE ROLE corpus_priv_replace_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA test_schema;

-- Column list differs from a.sql (adds "two"), forcing DROP + CREATE VIEW.
-- The grant present in a.sql is intentionally absent here: a->b converges
-- via DROP VIEW's own ACL cascade (nothing to pin), but b->a must
-- independently re-GRANT it while recreating the view from this desired
-- state — the same forced-replace recreate path #394 pins for triggers.
CREATE VIEW test_schema.a AS SELECT 1 AS one, 2 AS two;
