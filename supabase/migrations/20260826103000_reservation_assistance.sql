-- The attempt carries its tenant key so the database can prove that both the
-- itinerary item and the organizer who created it belong to the same trip.
-- PostgreSQL requires the referenced column pairs to be unique even though
-- each id is already globally unique.
alter table itinerary_items
  add constraint itinerary_items_id_trip_id_key unique (id, trip_id);
alter table travelers
  add constraint travelers_id_trip_id_key unique (id, trip_id);

create table reservation_attempts (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  itinerary_item_id uuid not null,
  created_by uuid not null,
  state text not null default 'awaiting_approval' check (state in ('awaiting_approval','in_progress','needs_choice','handoff','confirmed','failed')),
  party_size integer not null check (party_size between 1 and 30),
  requested_at timestamptz not null,
  booking_name text not null check (char_length(booking_name) between 1 and 120),
  contact_email text,
  contact_phone text,
  alternatives jsonb not null default '[]'::jsonb,
  routes jsonb not null,
  route_index integer not null default 0 check (route_index >= 0),
  route_provider text,
  confirmation_reference text,
  confirmation_url text,
  handoff text,
  approved_at timestamptz,
  attempted_at timestamptz,
  confirmed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint reservation_attempts_trip_item_fkey
    foreign key (itinerary_item_id, trip_id)
    references itinerary_items(id, trip_id) on delete cascade,
  constraint reservation_attempts_trip_creator_fkey
    foreign key (created_by, trip_id)
    references travelers(id, trip_id) on delete cascade
);
create unique index one_active_reservation_attempt_per_item on reservation_attempts(itinerary_item_id)
  where state in ('awaiting_approval','in_progress','needs_choice','handoff');
create index reservation_attempts_trip on reservation_attempts(trip_id, created_at desc);
create index reservation_attempts_trip_item on reservation_attempts(trip_id, itinerary_item_id);
create index reservation_attempts_trip_creator on reservation_attempts(trip_id, created_by);
alter table reservation_attempts enable row level security;
revoke all on reservation_attempts from public, anon, authenticated;

comment on table reservation_attempts is 'Organizer-only booking workflow; booking name/contact are intentionally excluded from traveler-facing trip reads.';

-- Confirmation changes canonical reservation data and the audit row together.
-- If either write fails, PostgreSQL rolls back both and leaves the attempt
-- retryable. The existing reservation RPC repeats the organizer/item checks and
-- owns the schedule-lock semantics.
create or replace function confirm_reservation_attempt(
  p_trip_id uuid,
  p_actor_id uuid,
  p_attempt_id uuid,
  p_confirmation_reference text,
  p_confirmation_url text
)
returns setof reservation_attempts
language plpgsql
security definer
set search_path = public
as $$
declare
  v_attempt reservation_attempts%rowtype;
begin
  if nullif(trim(p_confirmation_reference), '') is null then
    raise exception 'confirmation requires a reference' using errcode = '23514';
  end if;
  if p_confirmation_url is not null and p_confirmation_url !~* '^https://' then
    raise exception 'confirmation link must use https' using errcode = '23514';
  end if;

  -- Keep the same trip -> attempt -> item lock order for every confirmation.
  perform 1 from trips where id = p_trip_id for update;
  if not found then
    raise exception 'trip not found' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from travelers
    where id = p_actor_id and trip_id = p_trip_id and is_organizer
  ) then
    raise exception 'reservation changes require the trip organizer' using errcode = '42501';
  end if;

  select * into v_attempt
  from reservation_attempts
  where id = p_attempt_id and trip_id = p_trip_id
  for update;
  if not found then
    raise exception 'reservation attempt not found' using errcode = 'P0002';
  end if;
  if v_attempt.state not in ('in_progress', 'handoff') then
    raise exception 'reservation attempt is not confirmable from its current state' using errcode = 'P0001';
  end if;

  -- This is redundant with the composite foreign key by design: callers get a
  -- clear ownership failure even if historical data is ever repaired manually.
  if not exists (
    select 1 from itinerary_items
    where id = v_attempt.itinerary_item_id and trip_id = p_trip_id
  ) then
    raise exception 'reservation activity not found' using errcode = 'P0002';
  end if;

  perform update_itinerary_reservation(
    p_trip_id => p_trip_id,
    p_actor_id => p_actor_id,
    p_item_id => v_attempt.itinerary_item_id,
    p_status => 'confirmed',
    p_reservation_at => v_attempt.requested_at,
    p_confirmation_number => p_confirmation_reference,
    p_booking_url => coalesce(p_confirmation_url, v_attempt.routes ->> v_attempt.route_index),
    p_cancellation_deadline => null,
    p_details_source => 'organizer',
    p_organizer_verified => false
  );

  update reservation_attempts
  set state = 'confirmed',
      confirmation_reference = nullif(trim(p_confirmation_reference), ''),
      confirmation_url = p_confirmation_url,
      confirmed_at = now(),
      updated_at = now()
  where id = v_attempt.id and trip_id = p_trip_id
  returning * into v_attempt;

  return next v_attempt;
  return;
end;
$$;

revoke all on function confirm_reservation_attempt(uuid, uuid, uuid, text, text)
  from public, anon, authenticated;
grant execute on function confirm_reservation_attempt(uuid, uuid, uuid, text, text)
  to service_role;
