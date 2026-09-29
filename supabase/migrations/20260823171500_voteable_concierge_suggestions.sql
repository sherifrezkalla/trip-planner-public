-- Concierge results must enter the same visible majority-vote queue as plan
-- changes. An accepted suggestion is saved for the next regeneration; it does
-- not silently replace an itinerary slot.

alter table plan_proposals alter column item_id drop not null;
alter table plan_proposals alter column from_day_index drop not null;
alter table plan_proposals alter column from_block drop not null;
alter table plan_proposals add column suggestion_text text;

alter table plan_proposals drop constraint plan_proposals_kind_check;
alter table plan_proposals add constraint plan_proposals_kind_check
  check (kind in ('move', 'remove', 'replace', 'suggest'));

alter table plan_proposals drop constraint plan_proposal_destination_matches_kind;
alter table plan_proposals add constraint plan_proposal_destination_matches_kind check (
  (kind = 'move' and item_id is not null and from_day_index is not null and from_block is not null
    and to_day_index is not null and to_block is not null and to_candidate_id is null and suggestion_text is null)
  or (kind = 'remove' and item_id is not null and from_day_index is not null and from_block is not null
    and to_day_index is null and to_block is null and to_candidate_id is null and suggestion_text is null)
  or (kind = 'replace' and item_id is not null and from_day_index is not null and from_block is not null
    and to_day_index is null and to_block is null and to_candidate_id is not null and suggestion_text is null)
  or (kind = 'suggest' and item_id is null and from_day_index is null and from_block is null
    and to_day_index is null and to_block is null and to_candidate_id is null
    and suggestion_text is not null and char_length(suggestion_text) between 1 and 240)
);

create unique index plan_proposals_one_open_suggestion
  on plan_proposals (trip_id, lower(suggestion_text))
  where status = 'open' and kind = 'suggest';

create or replace function create_suggestion_proposal(
  p_trip_id uuid,
  p_proposed_by uuid,
  p_suggestion_text text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_text text := nullif(trim(regexp_replace(p_suggestion_text, '\s+', ' ', 'g')), '');
  v_id uuid;
begin
  if v_text is null or char_length(v_text) > 240 then
    raise exception 'invalid suggestion' using errcode = '23514';
  end if;
  perform 1 from trips where id = p_trip_id for update;
  if not found then raise exception 'trip not found' using errcode = 'P0002'; end if;

  insert into plan_proposals (trip_id, proposed_by, kind, suggestion_text)
  values (p_trip_id, p_proposed_by, 'suggest', v_text)
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
  if not found then raise exception 'proposal not found' using errcode = 'P0002'; end if;
  if v_proposal.status <> 'open' then
    raise exception 'proposal is already decided' using errcode = '23514';
  end if;

  if v_proposal.kind = 'suggest' then
    insert into trip_suggestions (trip_id, traveler_id, text)
    values (v_proposal.trip_id, v_proposal.proposed_by, v_proposal.suggestion_text);
  else
    perform assert_proposal_still_valid(v_proposal);
    if v_proposal.kind = 'move' then
      update itinerary_items set day_index = v_proposal.to_day_index,
        block = v_proposal.to_block, updated_at = now()
      where id = v_proposal.item_id and trip_id = v_proposal.trip_id;
    elsif v_proposal.kind = 'replace' then
      update itinerary_items item set candidate_id = v_proposal.to_candidate_id,
        area = candidate.area, why_note = coalesce(v_proposal.note, item.why_note), updated_at = now()
      from venue_candidates candidate
      where item.id = v_proposal.item_id and item.trip_id = v_proposal.trip_id
        and candidate.id = v_proposal.to_candidate_id;
    else
      update itinerary_items set status = 'skipped', is_locked = false,
        reservation_auto_locked = false, completed_at = null, completed_day_index = null,
        state_changed_by = p_actor_id, updated_at = now()
      where id = v_proposal.item_id and trip_id = v_proposal.trip_id;
    end if;
  end if;

  update plan_proposals set status = 'applied', resolution = p_resolution,
    decided_by = p_actor_id, decided_at = now()
  where id = p_proposal_id;
end;
$$;

revoke all on function create_suggestion_proposal(uuid, uuid, text) from public, anon, authenticated;
grant execute on function create_suggestion_proposal(uuid, uuid, text) to service_role;

