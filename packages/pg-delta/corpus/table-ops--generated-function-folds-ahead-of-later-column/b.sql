-- A generated column whose zero-argument IMMUTABLE function, kept from `a`,
-- reads a column declared AFTER it that waits on a type the plan creates.
--
-- PostgreSQL folds the call when CREATE TABLE declares `g`, even on a new empty
-- table, so `g` can only be added once `b` exists. The plpgsql body records no
-- pg_depend edge to `b`, and the kept function has no create action, so `g`
-- must not fold into the CREATE TABLE ahead of `b`.
CREATE SCHEMA app;

CREATE FUNCTION app.f()
 RETURNS integer
 LANGUAGE plpgsql
 IMMUTABLE
AS $function$ begin return (select count(b) from app.t); end $function$;

CREATE TYPE app.mood AS ENUM ('a');

CREATE TABLE app.t (
  id integer,
  g integer GENERATED ALWAYS AS (app.f()) STORED,
  b app.mood
);
