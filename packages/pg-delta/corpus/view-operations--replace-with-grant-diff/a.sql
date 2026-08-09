DO $$ BEGIN CREATE ROLE corpus_priv_replace_role NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE SCHEMA test_schema;

CREATE VIEW test_schema.a AS SELECT 1 AS one;

GRANT SELECT ON test_schema.a TO corpus_priv_replace_role;
