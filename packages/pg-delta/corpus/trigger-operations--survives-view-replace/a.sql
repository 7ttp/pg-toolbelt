CREATE SCHEMA test_schema;

CREATE FUNCTION test_schema.noop_trigger()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RETURN NULL;
END;
$$;

CREATE VIEW test_schema.a AS SELECT 1 AS one;

CREATE TRIGGER c INSTEAD OF INSERT ON test_schema.a
  FOR EACH ROW EXECUTE FUNCTION test_schema.noop_trigger();
