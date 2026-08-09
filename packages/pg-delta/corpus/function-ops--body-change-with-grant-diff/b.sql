DO $$ BEGIN CREATE ROLE corpus_priv_replace_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA test_schema;

-- Body-only change (still RETURNS void) takes the CREATE OR REPLACE FUNCTION
-- in-place alter path. The grant present in a.sql is intentionally absent
-- here, so the a->b direction must REVOKE it and the b->a direction must
-- GRANT it back, independent of the function body also changing.
CREATE FUNCTION test_schema.c() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 2; END; $$;
