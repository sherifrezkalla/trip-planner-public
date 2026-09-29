-- Correctness guarantees for collaborative generation and joining.

-- Structured hours make opening-time validation deterministic. NULL identifies
-- legacy cache rows that should be refreshed once; an empty array means Google
-- returned no usable hours for that venue.
alter table venue_candidates add column opening_periods jsonb
  check (opening_periods is null or jsonb_typeof(opening_periods) = 'array');

-- A Google place may satisfy several searches. Keep those labels separately so
-- topping up one interest never overwrites an older interest.
create table venue_candidate_categories (
  candidate_id uuid not null references venue_candidates(id) on delete cascade,
  category text not null,
  primary key (candidate_id, category)
);

insert into venue_candidate_categories (candidate_id, category)
select id, category from venue_candidates
on conflict do nothing;

alter table venue_candidate_categories enable row level security;
grant all on table venue_candidate_categories to service_role;

-- Record completed searches independently of their result count. A category
-- with zero results was still searched and must not trap generation in a loop.
create table trip_venue_searches (
  trip_id uuid not null references trips(id) on delete cascade,
  category text not null,
  searched_at timestamptz not null default now(),
  primary key (trip_id, category)
);

insert into trip_venue_searches (trip_id, category)
select distinct trip_id, category from venue_candidates
on conflict do nothing;

alter table trip_venue_searches enable row level security;
grant all on table trip_venue_searches to service_role;

-- Repair any historical organizer duplication before enforcing the invariant.
with ranked_organizers as (
  select id, row_number() over (partition by trip_id order by created_at, id) as rank
  from travelers
  where is_organizer
)
update travelers
set is_organizer = false
where id in (select id from ranked_organizers where rank > 1);

-- A failed historical first join may have left a populated trip without an
-- organizer. Promote its earliest traveler before adding the unique index.
with first_unowned_traveler as (
  select distinct on (t.trip_id) t.id
  from travelers t
  where not exists (
    select 1 from travelers organizer
    where organizer.trip_id = t.trip_id and organizer.is_organizer
  )
  order by t.trip_id, t.created_at, t.id
)
update travelers
set is_organizer = true
where id in (select id from first_unowned_traveler);

create unique index travelers_one_organizer_per_trip
  on travelers (trip_id)
  where is_organizer;

-- Locking the trip row serializes simultaneous first joins. The partial unique
-- index above remains the final defense if another write path is introduced.
create or replace function join_trip(
  p_slug text,
  p_display_name text,
  p_token text,
  p_interests text[],
  p_pace text,
  p_dietary text,
  p_constraints_note text
)
returns table (traveler_id uuid, is_organizer boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_trip_id uuid;
  v_is_organizer boolean;
begin
  select id into v_trip_id
  from trips
  where slug = p_slug
  for update;

  if not found then
    return;
  end if;

  v_is_organizer := not exists (
    select 1 from travelers where trip_id = v_trip_id
  );

  return query
  insert into travelers as created (
    trip_id, display_name, token, interests, pace, dietary,
    constraints_note, is_organizer
  ) values (
    v_trip_id, p_display_name, p_token, p_interests, p_pace, p_dietary,
    p_constraints_note, v_is_organizer
  )
  returning created.id, created.is_organizer;
end;
$$;

revoke all on function join_trip(text, text, text, text[], text, text, text) from public;
grant execute on function join_trip(text, text, text, text[], text, text, text) to service_role;

-- Remove any historical duplicate blocks produced by overlapping generation
-- requests, keeping the newest copy, before enforcing one block per day.
with ranked_items as (
  select id, row_number() over (
    partition by trip_id, day_index, block
    order by created_at desc, id desc
  ) as rank
  from itinerary_items
)
delete from itinerary_items
where id in (select id from ranked_items where rank > 1);

create unique index itinerary_one_block_per_day
  on itinerary_items (trip_id, day_index, block);

-- Delete + insert occurs inside one database transaction and under a per-trip
-- row lock. Any insertion error rolls the delete back automatically.
create or replace function replace_trip_itinerary(
  p_trip_id uuid,
  p_items jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) = 0 then
    raise exception 'itinerary must contain at least one item' using errcode = '23514';
  end if;

  perform 1 from trips where id = p_trip_id for update;
  if not found then
    raise exception 'trip not found' using errcode = 'P0002';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(
      trip_id uuid, candidate_id uuid
    )
    left join venue_candidates candidate on candidate.id = item.candidate_id
    where item.trip_id <> p_trip_id
       or candidate.id is null
       or candidate.trip_id <> p_trip_id
  ) then
    raise exception 'itinerary item does not belong to trip' using errcode = '23503';
  end if;

  delete from itinerary_items where trip_id = p_trip_id;

  insert into itinerary_items (
    trip_id, day_index, block, candidate_id, why_note, duration_min,
    position, travel_warning, area
  )
  select
    item.trip_id, item.day_index, item.block, item.candidate_id,
    item.why_note, item.duration_min, item.position,
    item.travel_warning, item.area
  from jsonb_to_recordset(p_items) as item(
    trip_id uuid,
    day_index integer,
    block text,
    candidate_id uuid,
    why_note text,
    duration_min integer,
    position integer,
    travel_warning boolean,
    area text
  );
end;
$$;

revoke all on function replace_trip_itinerary(uuid, jsonb) from public;
grant execute on function replace_trip_itinerary(uuid, jsonb) to service_role;

-- A swap, its vote reset, and all affected warning flags commit together.
create or replace function swap_itinerary_item(
  p_trip_id uuid,
  p_item_id uuid,
  p_candidate_id uuid,
  p_why_note text,
  p_duration_min integer,
  p_area text,
  p_warning_updates jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform 1
  from itinerary_items
  where id = p_item_id and trip_id = p_trip_id
  for update;
  if not found then
    raise exception 'itinerary item not found' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from venue_candidates
    where id = p_candidate_id and trip_id = p_trip_id
  ) then
    raise exception 'candidate does not belong to trip' using errcode = '23503';
  end if;

  update itinerary_items
  set candidate_id = p_candidate_id,
      why_note = p_why_note,
      duration_min = p_duration_min,
      area = p_area
  where id = p_item_id and trip_id = p_trip_id;

  update itinerary_items item
  set travel_warning = warning.travel_warning
  from jsonb_to_recordset(p_warning_updates) as warning(
    id uuid,
    travel_warning boolean
  )
  where item.id = warning.id and item.trip_id = p_trip_id;

  delete from votes where item_id = p_item_id;
end;
$$;

revoke all on function swap_itinerary_item(uuid, uuid, uuid, text, integer, text, jsonb) from public;
grant execute on function swap_itinerary_item(uuid, uuid, uuid, text, integer, text, jsonb) to service_role;
