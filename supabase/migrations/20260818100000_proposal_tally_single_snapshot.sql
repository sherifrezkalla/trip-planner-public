-- One snapshot for the vote tally.
--
-- The numerator and the denominator have to describe the same instant. Read as
-- two statements they do not: PostgreSQL gives every statement in READ
-- COMMITTED its own snapshot, so a traveller joining between the vote read and
-- the roster read produces a majority that never existed — four of seven
-- applying against a roster that is already eight and needs five.
--
-- The vote arithmetic is still not duplicated in SQL. This returns the raw
-- inputs `lib/proposals.ts` needs, taken together, which is the part only the
-- database can guarantee. Being one statement is the whole point of it: two
-- selects inside one function body would take two snapshots again.

create or replace function read_proposal_tally(p_proposal_id uuid)
returns json
language sql
stable
security definer
set search_path = public
as $$
  select json_build_object(
    'votes', coalesce(
      (
        select json_agg(json_build_object('traveler_id', v.traveler_id, 'value', v.value))
        from plan_proposal_votes v
        where v.proposal_id = p_proposal_id
      ),
      '[]'::json
    ),
    -- Humans only, matching the vote denominator in lib/proposals.ts. Uses the
    -- travelers_human_by_trip partial index.
    'traveler_count', (
      select count(*)
      from travelers t
      join plan_proposals p on p.id = p_proposal_id
      where t.trip_id = p.trip_id
        and not t.is_bot
    )
  );
$$;

revoke all on function read_proposal_tally(uuid) from public, anon, authenticated;
grant execute on function read_proposal_tally(uuid) to service_role;
