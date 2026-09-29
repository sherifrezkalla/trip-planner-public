-- Group change protocol.
--
-- A traveller cannot write to the shared plan, but can ask the group to. A
-- proposal applies when the organizer approves it or when more than half the
-- travellers vote for it, and dies when the organizer rejects it or more than
-- half vote against.
--
-- The vote arithmetic and the staleness rules live in lib/proposals.ts. What
-- lives here is what only the database can guarantee: that the plan is not
-- written twice by two deciding votes arriving together, and that a proposal
-- cannot apply against an activity that moved out from under it.

create table plan_proposals (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  item_id uuid not null references itinerary_items(id) on delete cascade,
  proposed_by uuid not null references travelers(id) on delete cascade,
  kind text not null check (kind in ('move', 'remove')),
  -- The slot the proposer saw. A proposal is written against a plan, not an id,
  -- so an activity that drifts invalidates the request rather than silently
  -- carrying it somewhere nobody agreed to.
  from_day_index integer not null,
  from_block text not null check (from_block in ('morning','lunch','afternoon','dinner','evening')),
  to_day_index integer,
  to_block text check (to_block in ('morning','lunch','afternoon','dinner','evening')),
  note text,
  status text not null default 'open'
    check (status in ('open', 'applied', 'rejected', 'cancelled')),
  resolution text,
  decided_by uuid references travelers(id) on delete set null,
  decided_at timestamptz,
  created_at timestamptz not null default now(),
  constraint plan_proposal_destination_matches_kind check (
    (kind = 'move' and to_day_index is not null and to_block is not null)
    or (kind = 'remove' and to_day_index is null and to_block is null)
  ),
  constraint plan_proposal_note_length check (note is null or char_length(note) <= 200),
  constraint plan_proposal_decided_rows_have_reason check (
    status = 'open' or resolution is not null
  )
);

-- One open proposal per activity, so competing requests replace rather than
-- stack. Two people arguing through the plan is the thing to prevent.
create unique index plan_proposals_one_open_per_item
  on plan_proposals (item_id)
  where status = 'open';

create index plan_proposals_open_by_trip
  on plan_proposals (trip_id)
  where status = 'open';

create table plan_proposal_votes (
  id uuid primary key default gen_random_uuid(),
  proposal_id uuid not null references plan_proposals(id) on delete cascade,
  traveler_id uuid not null references travelers(id) on delete cascade,
  value smallint not null check (value in (-1, 1)),
  created_at timestamptz not null default now(),
  -- One vote each; changing your mind replaces rather than adds.
  unique (proposal_id, traveler_id)
);

alter table plan_proposals enable row level security;
alter table plan_proposal_votes enable row level security;

-- Raise unless this activity can still take the proposed change. Mirrors the
-- protections in apply_itinerary_reshuffle rather than inventing weaker ones.
create or replace function assert_proposal_still_valid(
  p_proposal plan_proposals
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_is_locked boolean;
  v_reservation_status text;
  v_day_index integer;
  v_block text;
begin
  select status, is_locked, reservation_status, day_index, block
    into v_status, v_is_locked, v_reservation_status, v_day_index, v_block
  from itinerary_items
  where id = p_proposal.item_id and trip_id = p_proposal.trip_id
  for update;

  if not found then
    raise exception 'proposal activity no longer exists' using errcode = 'P0002';
  end if;
  if v_status <> 'planned' or v_is_locked
     or v_reservation_status in ('tentative', 'confirmed')
     or v_day_index <> p_proposal.from_day_index
     or v_block <> p_proposal.from_block then
    raise exception 'proposal is stale' using errcode = '23514';
  end if;

  if p_proposal.kind = 'move' and exists (
    select 1 from itinerary_items occupied
    where occupied.trip_id = p_proposal.trip_id
      and occupied.status = 'planned'
      and occupied.day_index = p_proposal.to_day_index
      and occupied.block = p_proposal.to_block
      and occupied.id <> p_proposal.item_id
  ) then
    raise exception 'proposal destination is no longer vacant' using errcode = '23505';
  end if;
end;
$$;

-- Open a proposal, replacing whatever open one the activity already had.
create or replace function create_plan_proposal(
  p_trip_id uuid,
  p_item_id uuid,
  p_proposed_by uuid,
  p_kind text,
  p_to_day_index integer,
  p_to_block text,
  p_note text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from_day_index integer;
  v_from_block text;
  v_id uuid;
begin
  perform 1 from trips where id = p_trip_id for update;
  if not found then
    raise exception 'trip not found' using errcode = 'P0002';
  end if;

  select day_index, block into v_from_day_index, v_from_block
  from itinerary_items
  where id = p_item_id and trip_id = p_trip_id
    and status = 'planned'
    and not is_locked
    and reservation_status not in ('tentative', 'confirmed')
  for update;

  if not found then
    raise exception 'that activity cannot be changed' using errcode = '23514';
  end if;
  if p_kind = 'move'
     and p_to_day_index = v_from_day_index and p_to_block = v_from_block then
    raise exception 'that activity is already in this slot' using errcode = '23514';
  end if;

  update plan_proposals
  set status = 'cancelled',
      resolution = 'Replaced by a newer request.',
      decided_at = now()
  where item_id = p_item_id and status = 'open';

  insert into plan_proposals (
    trip_id, item_id, proposed_by, kind,
    from_day_index, from_block, to_day_index, to_block, note
  )
  values (
    p_trip_id, p_item_id, p_proposed_by, p_kind,
    v_from_day_index, v_from_block, p_to_day_index, p_to_block, nullif(p_note, '')
  )
  returning id into v_id;

  -- Proposing is voting for your own request.
  insert into plan_proposal_votes (proposal_id, traveler_id, value)
  values (v_id, p_proposed_by, 1);

  return v_id;
end;
$$;

-- Apply an open proposal to the plan. The status flip and the write happen
-- together, so two deciding votes arriving at once cannot apply it twice.
create or replace function apply_plan_proposal(
  p_proposal_id uuid,
  p_actor_id uuid,
  p_resolution text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_proposal plan_proposals;
begin
  select * into v_proposal from plan_proposals where id = p_proposal_id for update;
  if not found then
    raise exception 'proposal not found' using errcode = 'P0002';
  end if;
  if v_proposal.status <> 'open' then
    raise exception 'proposal is already decided' using errcode = '23514';
  end if;

  perform assert_proposal_still_valid(v_proposal);

  if v_proposal.kind = 'move' then
    update itinerary_items
    set day_index = v_proposal.to_day_index,
        block = v_proposal.to_block,
        updated_at = now()
    where id = v_proposal.item_id and trip_id = v_proposal.trip_id;
  else
    update itinerary_items
    set status = 'skipped',
        is_locked = false,
        reservation_auto_locked = false,
        completed_at = null,
        completed_day_index = null,
        state_changed_by = p_actor_id,
        updated_at = now()
    where id = v_proposal.item_id and trip_id = v_proposal.trip_id;
  end if;

  update plan_proposals
  set status = 'applied',
      resolution = p_resolution,
      decided_by = p_actor_id,
      decided_at = now()
  where id = p_proposal_id;
end;
$$;

-- Close an open proposal without touching the plan: rejected by the organizer
-- or the group, or cancelled because it went stale.
create or replace function close_plan_proposal(
  p_proposal_id uuid,
  p_actor_id uuid,
  p_status text,
  p_resolution text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if p_status not in ('rejected', 'cancelled') then
    raise exception 'a proposal can only be closed as rejected or cancelled' using errcode = '23514';
  end if;

  update plan_proposals
  set status = p_status,
      resolution = p_resolution,
      decided_by = p_actor_id,
      decided_at = now()
  where id = p_proposal_id and status = 'open';

  if not found then
    raise exception 'proposal is already decided' using errcode = '23514';
  end if;
end;
$$;

revoke all on function assert_proposal_still_valid(plan_proposals) from public, anon, authenticated;
revoke all on function create_plan_proposal(uuid, uuid, uuid, text, integer, text, text) from public, anon, authenticated;
revoke all on function apply_plan_proposal(uuid, uuid, text) from public, anon, authenticated;
revoke all on function close_plan_proposal(uuid, uuid, text, text) from public, anon, authenticated;

grant execute on function assert_proposal_still_valid(plan_proposals) to service_role;
grant execute on function create_plan_proposal(uuid, uuid, uuid, text, integer, text, text) to service_role;
grant execute on function apply_plan_proposal(uuid, uuid, text) to service_role;
grant execute on function close_plan_proposal(uuid, uuid, text, text) to service_role;
