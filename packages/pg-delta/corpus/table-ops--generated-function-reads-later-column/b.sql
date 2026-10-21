-- Generated columns whose zero-argument IMMUTABLE function reads a column
-- declared AFTER them (#554).
--
-- PostgreSQL folds a zero-argument IMMUTABLE call at ADD COLUMN time, even on a
-- new empty table and even inside a larger expression (`h`), so `g` and `h` can
-- only be added once `b` exists. The plpgsql body records no pg_depend edge to
-- `b`, so neither column may lead the declared-position column chain.
CREATE SCHEMA app;

CREATE FUNCTION app.f()
 RETURNS integer
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$ begin return (select count(b) from app.t); end $function$;

CREATE TABLE app.t (
  id integer,
  g integer GENERATED ALWAYS AS (app.f()) STORED,
  h integer GENERATED ALWAYS AS (id + app.f()) STORED,
  b integer
);
