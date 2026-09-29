-- When each traveller is actually there.
--
-- A trip has one start and end date, but the people do not. Someone landing on
-- day 2 should not have day 1 planned around them, and a plan that fills the
-- arrival evening for people still on the motorway is worse than an empty one.
--
-- Null means "there for the whole trip", which is both the common case and the
-- honest default for travellers who never say otherwise. It is deliberately not
-- backfilled to the trip dates: a null records that nobody asked, while a date
-- equal to the trip start records that someone answered.

alter table travelers
  add column arrives_on date,
  add column departs_on date;

-- Only orders the two against each other. Bounding them to the trip would mean
-- reaching into another table, which a check constraint cannot do; the API
-- validates that, and a traveller whose dates fall outside the trip is absent
-- for all of it rather than corrupting anything.
alter table travelers
  add constraint travelers_dates_ordered check (
    arrives_on is null or departs_on is null or arrives_on <= departs_on
  );

comment on column travelers.arrives_on is
  'First day this traveller is present. Null means from the trip start.';
comment on column travelers.departs_on is
  'Last day this traveller is present. Null means until the trip end.';
