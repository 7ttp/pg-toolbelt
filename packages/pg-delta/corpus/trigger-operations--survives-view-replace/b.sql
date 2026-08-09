CREATE SCHEMA test_schema;

CREATE FUNCTION test_schema.noop_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RETURN NULL;
END;
$$;

-- Any view def change demolishes the view (views.ts: def "replace"); this
-- one differs from a.sql only in its column list. The INSTEAD OF trigger
-- below is unchanged from a.sql, so the engine must recreate it after the
-- forced view rebuild.
CREATE VIEW test_schema.a AS SELECT 1 AS one, 2 AS two;

CREATE TRIGGER c INSTEAD OF INSERT ON test_schema.a
  FOR EACH ROW EXECUTE FUNCTION test_schema.noop_trigger();
