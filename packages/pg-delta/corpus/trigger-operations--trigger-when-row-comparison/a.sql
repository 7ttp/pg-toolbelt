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
