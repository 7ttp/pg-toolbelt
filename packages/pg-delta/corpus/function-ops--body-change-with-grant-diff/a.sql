DO $$ BEGIN CREATE ROLE corpus_priv_replace_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA test_schema;

CREATE FUNCTION test_schema.c() RETURNS void LANGUAGE plpgsql AS $$ BEGIN PERFORM 1; END; $$;

GRANT ALL ON FUNCTION test_schema.c() TO corpus_priv_replace_role;
