-- Proposing a different venue for a slot, not just a different slot for a venue.
--
-- A proposal could move an activity or drop it, which covers "not this day" but
-- not "not this, that". Every real reason to change a plan mid-trip — weather,
-- a closure, a group that has had enough of beaches — is a substitution, and
-- substitutions had to go through the swap route instead: organiser-only, with
-- a model choosing the replacement and no record of why.
--
-- The vote arithmetic still lives in lib/proposals.ts. What is added here is
-- what only the database can guarantee: that the replacement still belongs to
-- the trip and is not already standing somewhere else in the plan.

alter table plan_proposals
  add column to_candidate_id uuid references venue_candidates(id) on delete cascade;

alter table plan_proposals drop constraint plan_proposals_kind_check;
alter table plan_proposals
  add constraint plan_proposals_kind_check
  check (kind in ('move', 'remove', 'replace'));

alter table plan_proposals drop constraint plan_proposal_destination_matches_kind;
alter table plan_proposals
  add constraint plan_proposal_destination_matches_kind check (
    (kind = 'move'
       and to_day_index is not null and to_block is not null and to_candidate_id is null)
    or (kind = 'remove'
       and to_day_index is null and to_block is null and to_candidate_id is null)
    or (kind = 'replace'
       and to_day_index is null and to_block is null and to_candidate_id is not null)
  );

comment on column plan_proposals.to_candidate_id is
  'For kind=replace: the venue proposed to stand in this slot instead.';

-- Staleness now has a third way to happen: the replacement itself can stop being
-- available while the group is still deciding.
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

  if p_proposal.kind = 'replace' then
    if not exists (
      select 1 from venue_candidates
      where id = p_proposal.to_candidate_id and trip_id = p_proposal.trip_id
    ) then
      raise exception 'replacement venue does not belong to trip' using errcode = '23503';
    end if;
    -- The same venue standing twice in one plan is the failure this prevents:
    -- two slots agreeing to the same replacement while both were open.
    if exists (
      select 1 from itinerary_items already
      where already.trip_id = p_proposal.trip_id
        and already.status = 'planned'
        and already.candidate_id = p_proposal.to_candidate_id
        and already.id <> p_proposal.item_id
    ) then
      raise exception 'replacement venue is already in the plan' using errcode = '23505';
    end if;
  end if;
end;
$$;

create or replace function create_plan_proposal(
  p_trip_id uuid,
  p_item_id uuid,
  p_proposed_by uuid,
  p_kind text,
  p_to_day_index integer,
  p_to_block text,
  p_note text,
  p_to_candidate_id uuid default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_from_day_index integer;
  v_from_block text;
  v_current_candidate uuid;
  v_id uuid;
begin
  perform 1 from trips where id = p_trip_id for update;
  if not found then
    raise exception 'trip not found' using errcode = 'P0002';
  end if;

  select day_index, block, candidate_id
    into v_from_day_index, v_from_block, v_current_candidate
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
  if p_kind = 'replace' and p_to_candidate_id = v_current_candidate then
    raise exception 'that venue is already in this slot' using errcode = '23514';
  end if;

  update plan_proposals
  set status = 'cancelled',
      resolution = 'Replaced by a newer request.',
      decided_at = now()
  where item_id = p_item_id and status = 'open';

  insert into plan_proposals (
    trip_id, item_id, proposed_by, kind,
    from_day_index, from_block, to_day_index, to_block, to_candidate_id, note
  )
  values (
    p_trip_id, p_item_id, p_proposed_by, p_kind,
    v_from_day_index, v_from_block, p_to_day_index, p_to_block, p_to_candidate_id,
    nullif(p_note, '')
  )
  returning id into v_id;

  insert into plan_proposal_votes (proposal_id, traveler_id, value)
  values (v_id, p_proposed_by, 1);

  return v_id;
end;
$$;

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
  elsif v_proposal.kind = 'replace' then
    -- The slot keeps its day, block and duration; only the venue changes. The
    -- area follows the venue, since a replacement can sit in a different town.
    update itinerary_items item
    set candidate_id = v_proposal.to_candidate_id,
        area = candidate.area,
        why_note = coalesce(v_proposal.note, item.why_note),
        updated_at = now()
    from venue_candidates candidate
    where item.id = v_proposal.item_id
      and item.trip_id = v_proposal.trip_id
      and candidate.id = v_proposal.to_candidate_id;
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

revoke all on function create_plan_proposal(uuid, uuid, uuid, text, integer, text, text, uuid) from public, anon, authenticated;
grant execute on function create_plan_proposal(uuid, uuid, uuid, text, integer, text, text, uuid) to service_role;
