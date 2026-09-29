-- Apply a reviewed repair of today's remaining plan as one auditable transaction.

create table itinerary_revisions (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  actor_id uuid references travelers(id) on delete set null,
  kind text not null check (kind in ('partial_day')),
  trigger text not null check (trigger in ('running-late')),
  day_index integer not null check (day_index >= 0),
  changes jsonb not null,
  created_at timestamptz not null default now()
);

create index itinerary_revisions_trip_created
  on itinerary_revisions (trip_id, created_at desc);
create index itinerary_revisions_actor
  on itinerary_revisions (actor_id)
  where actor_id is not null;

alter table itinerary_revisions enable row level security;
revoke all on table itinerary_revisions from public, anon, authenticated;
grant all on table itinerary_revisions to service_role;

create or replace function apply_partial_day_replan(
  p_trip_id uuid,
  p_actor_id uuid,
  p_day_index integer,
  p_current_block text,
  p_trigger text,
  p_moves jsonb,
  p_skips jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_revision_id uuid;
  v_current_rank integer;
begin
  if jsonb_typeof(p_moves) is distinct from 'array'
     or jsonb_typeof(p_skips) is distinct from 'array' then
    raise exception 'partial-day changes must be arrays' using errcode = '23514';
  end if;
  if jsonb_array_length(p_moves) + jsonb_array_length(p_skips) = 0
     or jsonb_array_length(p_moves) > 5
     or jsonb_array_length(p_skips) > 5 then
    raise exception 'partial-day changes have an invalid size' using errcode = '23514';
  end if;
  if p_day_index < 0 or p_trigger <> 'running-late' then
    raise exception 'partial-day context is invalid' using errcode = '23514';
  end if;

  v_current_rank := case p_current_block
    when 'morning' then 0 when 'lunch' then 1 when 'afternoon' then 2
    when 'dinner' then 3 when 'evening' then 4 else null end;
  if v_current_rank is null then
    raise exception 'partial-day current block is invalid' using errcode = '23514';
  end if;

  perform 1 from trips where id = p_trip_id for update;
  if not found then
    raise exception 'trip not found' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from travelers
    where id = p_actor_id and trip_id = p_trip_id and is_organizer
  ) then
    raise exception 'partial-day changes require the trip organizer' using errcode = '42501';
  end if;

  perform 1
  from itinerary_items
  where trip_id = p_trip_id and day_index = p_day_index
  for update;

  if (
    select count(*) <> count(distinct move.item_id)
        or count(*) <> count(distinct (move.to_day_index, move.to_block))
    from jsonb_to_recordset(p_moves) as move(
      item_id uuid, from_day_index integer, from_block text,
      to_day_index integer, to_block text
    )
  ) or (
    select count(*) <> count(distinct skip.item_id)
    from jsonb_to_recordset(p_skips) as skip(
      item_id uuid, from_day_index integer, from_block text
    )
  ) or exists (
    select 1
    from jsonb_to_recordset(p_moves) as move(item_id uuid)
    join jsonb_to_recordset(p_skips) as skip(item_id uuid)
      on skip.item_id = move.item_id
  ) then
    raise exception 'partial-day changes contain duplicate items or destinations' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_moves) as move(
      item_id uuid, from_day_index integer, from_block text,
      to_day_index integer, to_block text
    )
    left join itinerary_items item
      on item.id = move.item_id and item.trip_id = p_trip_id
    where item.id is null
       or item.status <> 'planned'
       or item.is_locked
       or item.day_index <> move.from_day_index
       or item.block <> move.from_block
       or move.from_day_index <> p_day_index
       or move.to_day_index <> p_day_index
       or move.to_block = move.from_block
       or move.to_block not in ('morning', 'lunch', 'afternoon', 'dinner', 'evening')
       or (case move.to_block
            when 'morning' then 0 when 'lunch' then 1 when 'afternoon' then 2
            when 'dinner' then 3 when 'evening' then 4 else -1 end) < v_current_rank
       or ((move.from_block in ('lunch', 'dinner')) <> (move.to_block in ('lunch', 'dinner')))
  ) then
    raise exception 'partial-day preview is stale or contains an invalid move' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_skips) as skip(
      item_id uuid, from_day_index integer, from_block text
    )
    left join itinerary_items item
      on item.id = skip.item_id and item.trip_id = p_trip_id
    where item.id is null
       or item.status <> 'planned'
       or item.is_locked
       or item.day_index <> skip.from_day_index
       or item.block <> skip.from_block
       or skip.from_day_index <> p_day_index
  ) then
    raise exception 'partial-day preview is stale or contains a protected skip' using errcode = '23514';
  end if;

  if exists (
    select 1
    from jsonb_to_recordset(p_moves) as move(
      item_id uuid, from_day_index integer, from_block text,
      to_day_index integer, to_block text
    )
    join itinerary_items occupied
      on occupied.trip_id = p_trip_id
     and occupied.status = 'planned'
     and occupied.day_index = move.to_day_index
     and occupied.block = move.to_block
    where not exists (
      select 1 from jsonb_to_recordset(p_moves) as source(item_id uuid)
      where source.item_id = occupied.id
    )
      and not exists (
        select 1 from jsonb_to_recordset(p_skips) as removed(item_id uuid)
        where removed.item_id = occupied.id
      )
  ) then
    raise exception 'a partial-day destination is occupied' using errcode = '23505';
  end if;

  -- Vacate every reviewed source first so swaps cannot trip the active-plan
  -- unique index. Rows selected as moves are restored to planned below.
  update itinerary_items item
  set status = 'skipped',
      is_locked = false,
      completed_at = null,
      completed_day_index = null,
      state_changed_by = p_actor_id,
      updated_at = now()
  where item.trip_id = p_trip_id
    and (
      exists (
        select 1 from jsonb_to_recordset(p_moves) as move(item_id uuid)
        where move.item_id = item.id
      )
      or exists (
        select 1 from jsonb_to_recordset(p_skips) as skip(item_id uuid)
        where skip.item_id = item.id
      )
    );

  update itinerary_items item
  set day_index = move.to_day_index,
      block = move.to_block,
      status = 'planned',
      state_changed_by = p_actor_id,
      updated_at = now()
  from jsonb_to_recordset(p_moves) as move(
    item_id uuid, from_day_index integer, from_block text,
    to_day_index integer, to_block text
  )
  where item.id = move.item_id and item.trip_id = p_trip_id;

  insert into itinerary_revisions (trip_id, actor_id, kind, trigger, day_index, changes)
  values (
    p_trip_id,
    p_actor_id,
    'partial_day',
    p_trigger,
    p_day_index,
    jsonb_build_object(
      'current_block', p_current_block,
      'moves', p_moves,
      'skips', p_skips
    )
  )
  returning id into v_revision_id;

  return v_revision_id;
end;
$$;

revoke all on function apply_partial_day_replan(uuid, uuid, integer, text, text, jsonb, jsonb)
  from public, anon, authenticated;
grant execute on function apply_partial_day_replan(uuid, uuid, integer, text, text, jsonb, jsonb)
  to service_role;
