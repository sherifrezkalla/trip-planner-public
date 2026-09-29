-- Preserve trip history while allowing the unfinished plan to be rearranged.

alter table itinerary_items
  add column status text not null default 'planned'
    check (status in ('planned', 'done', 'skipped')),
  add column is_locked boolean not null default false,
  add column completed_at timestamptz,
  add column completed_day_index integer check (completed_day_index >= 0),
  add column state_changed_by uuid references travelers(id) on delete set null,
  add column updated_at timestamptz not null default now(),
  add constraint itinerary_completion_consistent check (
    (status = 'done' and completed_at is not null and completed_day_index is not null)
    or
    (status <> 'done' and completed_at is null and completed_day_index is null)
  ),
  add constraint itinerary_only_planned_items_lockable check (
    status = 'planned' or not is_locked
  );

-- Completed and skipped rows are history, so a new planned activity may use
-- their former slot. Only the active plan needs one item per day/block.
drop index itinerary_one_block_per_day;
create unique index itinerary_one_planned_block_per_day
  on itinerary_items (trip_id, day_index, block)
  where status = 'planned';

create index itinerary_items_trip_status
  on itinerary_items (trip_id, status, day_index);

-- PostgreSQL does not index foreign keys automatically. This keeps traveler
-- deletion (ON DELETE SET NULL) from scanning every itinerary row.
create index itinerary_items_state_changed_by
  on itinerary_items (state_changed_by)
  where state_changed_by is not null;

-- Applying a preview is deliberately narrower than arbitrary rescheduling:
-- every target must still be vacant, and every source must match the snapshot
-- the organizer reviewed. This makes stale previews fail instead of overwriting
-- someone else's more recent update.
create or replace function apply_itinerary_reshuffle(
  p_trip_id uuid,
  p_moves jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if jsonb_typeof(p_moves) <> 'array' or jsonb_array_length(p_moves) = 0 then
    raise exception 'reshuffle must contain at least one move' using errcode = '23514';
  end if;

  perform 1 from trips where id = p_trip_id for update;
  if not found then
    raise exception 'trip not found' using errcode = 'P0002';
  end if;

  if (
    select count(*) <> count(distinct move.item_id)
      or count(*) <> count(distinct (move.to_day_index, move.to_block))
    from jsonb_to_recordset(p_moves) as move(
      item_id uuid,
      from_day_index integer,
      from_block text,
      to_day_index integer,
      to_block text
    )
  ) then
    raise exception 'reshuffle contains duplicate items or destinations' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_moves) as move(
      item_id uuid,
      from_day_index integer,
      from_block text,
      to_day_index integer,
      to_block text
    )
    left join itinerary_items item
      on item.id = move.item_id and item.trip_id = p_trip_id
    where item.id is null
       or item.status <> 'planned'
       or item.is_locked
       or item.day_index <> move.from_day_index
       or item.block <> move.from_block
       or move.to_day_index < 0
       or move.to_block not in ('morning', 'lunch', 'afternoon', 'dinner', 'evening')
  ) then
    raise exception 'reshuffle preview is stale or contains an invalid move' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_moves) as move(
      item_id uuid,
      from_day_index integer,
      from_block text,
      to_day_index integer,
      to_block text
    )
    join itinerary_items occupied
      on occupied.trip_id = p_trip_id
     and occupied.status = 'planned'
     and occupied.day_index = move.to_day_index
     and occupied.block = move.to_block
     and occupied.id <> move.item_id
  ) then
    raise exception 'a reshuffle destination is no longer vacant' using errcode = '23505';
  end if;

  update itinerary_items item
  set day_index = move.to_day_index,
      block = move.to_block,
      updated_at = now()
  from jsonb_to_recordset(p_moves) as move(
    item_id uuid,
    from_day_index integer,
    from_block text,
    to_day_index integer,
    to_block text
  )
  where item.id = move.item_id and item.trip_id = p_trip_id;
end;
$$;

revoke all on function apply_itinerary_reshuffle(uuid, jsonb) from public, anon, authenticated;
grant execute on function apply_itinerary_reshuffle(uuid, jsonb) to service_role;

-- Once a trip has progress or locked bookings, a full regeneration must not
-- erase that history. Smart reshuffle is the safe path from that point on.
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
    select 1 from itinerary_items
    where trip_id = p_trip_id and (status <> 'planned' or is_locked)
  ) then
    raise exception 'trip has progress or locked activities; use smart reshuffle' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_items) as item(trip_id uuid, candidate_id uuid)
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

revoke all on function replace_trip_itinerary(uuid, jsonb) from public, anon, authenticated;
grant execute on function replace_trip_itinerary(uuid, jsonb) to service_role;

-- A locked or historical activity can never be swapped through the older API.
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
  where id = p_item_id
    and trip_id = p_trip_id
    and status = 'planned'
    and not is_locked
  for update;
  if not found then
    raise exception 'itinerary item is locked or no longer planned' using errcode = 'P0002';
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
      area = p_area,
      updated_at = now()
  where id = p_item_id and trip_id = p_trip_id;

  update itinerary_items item
  set travel_warning = warning.travel_warning,
      updated_at = now()
  from jsonb_to_recordset(p_warning_updates) as warning(
    id uuid,
    travel_warning boolean
  )
  where item.id = warning.id and item.trip_id = p_trip_id;

  delete from votes where item_id = p_item_id;
end;
$$;

revoke all on function swap_itinerary_item(uuid, uuid, uuid, text, integer, text, jsonb)
  from public, anon, authenticated;
grant execute on function swap_itinerary_item(uuid, uuid, uuid, text, integer, text, jsonb) to service_role;
