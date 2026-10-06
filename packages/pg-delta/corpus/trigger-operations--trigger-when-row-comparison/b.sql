CREATE SCHEMA test_schema;

CREATE TABLE test_schema.items (
  id serial PRIMARY KEY,
  a integer,
  b integer,
  c integer
);

CREATE FUNCTION test_schema.log_item_changes()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RETURN NEW;
END;
$$;

CREATE TRIGGER item_change_trigger
  AFTER UPDATE ON test_schema.items
  FOR EACH ROW
  WHEN ((OLD.a, OLD.b, OLD.c) IS DISTINCT FROM (NEW.a, NEW.b, NEW.c))
  EXECUTE FUNCTION test_schema.log_item_changes();
