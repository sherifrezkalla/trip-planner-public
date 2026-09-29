-- Shared place ideas supplied by trip members. searched_at records that the
-- idea has already been sent through Places, including searches with no result.
create table trip_suggestions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  traveler_id uuid not null references travelers(id) on delete cascade,
  text text not null check (char_length(btrim(text)) between 1 and 240),
  searched_at timestamptz,
  created_at timestamptz not null default now()
);

create index trip_suggestions_trip_created
  on trip_suggestions (trip_id, created_at);

alter table trip_suggestions enable row level security;
grant all on table trip_suggestions to service_role;
