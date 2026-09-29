-- Make reservations first-class itinerary data and distinguish automatic
-- booking locks from organizer-created manual locks.

alter table itinerary_items
  add column reservation_status text not null default 'none'
    check (reservation_status in ('none', 'tentative', 'confirmed', 'cancelled')),
  add column reservation_at timestamptz,
  add column confirmation_number text,
  add column booking_url text,
  add column cancellation_deadline timestamptz,
  add column reservation_auto_locked boolean not null default false,
  add constraint itinerary_confirmed_reservation_has_time check (
    reservation_status <> 'confirmed' or reservation_at is not null
  ),
  add constraint itinerary_active_reservations_are_locked check (
    reservation_status not in ('tentative', 'confirmed') or status <> 'planned' or is_locked
  ),
  add constraint itinerary_reservation_auto_lock_consistent check (
    not reservation_auto_locked
    or (reservation_status in ('tentative', 'confirmed') and status = 'planned' and is_locked)
  ),
  add constraint itinerary_confirmation_number_length check (
    confirmation_number is null or char_length(confirmation_number) <= 120
  ),
  add constraint itinerary_booking_url_length check (
    booking_url is null or char_length(booking_url) <= 1000
  );

create index itinerary_items_upcoming_cancellation
  on itinerary_items (cancellation_deadline)
  where reservation_status in ('tentative', 'confirmed')
    and cancellation_deadline is not null;

create or replace function update_itinerary_reservation(
  p_trip_id uuid,
  p_actor_id uuid,
  p_item_id uuid,
  p_status text,
  p_reservation_at timestamptz,
  p_confirmation_number text,
  p_booking_url text,
  p_cancellation_deadline timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item_status text;
  v_is_locked boolean;
  v_auto_locked boolean;
  v_next_locked boolean;
  v_next_auto_locked boolean;
begin
  if p_status not in ('none', 'tentative', 'confirmed', 'cancelled') then
    raise exception 'reservation status is invalid' using errcode = '23514';
  end if;
  if p_status = 'confirmed' and p_reservation_at is null then
    raise exception 'confirmed reservations require a date and time' using errcode = '23514';
  end if;
  if p_booking_url is not null and p_booking_url !~* '^https?://' then
    raise exception 'booking link must use http or https' using errcode = '23514';
  end if;

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

  select status, is_locked, reservation_auto_locked
  into v_item_status, v_is_locked, v_auto_locked
  from itinerary_items
  where id = p_item_id and trip_id = p_trip_id
  for update;
  if not found then
    raise exception 'activity not found' using errcode = 'P0002';
  end if;

  v_next_locked := v_is_locked;
  v_next_auto_locked := v_auto_locked;

  if p_status in ('tentative', 'confirmed') and v_item_status = 'planned' then
    -- Preserve an existing manual lock as manual; otherwise record that the
    -- active reservation owns the lock so cancellation can release only it.
    v_next_auto_locked := v_auto_locked or not v_is_locked;
    v_next_locked := true;
  elsif v_auto_locked then
    v_next_locked := false;
    v_next_auto_locked := false;
  end if;

  update itinerary_items
  set reservation_status = p_status,
      reservation_at = case when p_status = 'none' then null else p_reservation_at end,
      confirmation_number = case when p_status = 'none' then null else nullif(trim(p_confirmation_number), '') end,
      booking_url = case when p_status = 'none' then null else nullif(trim(p_booking_url), '') end,
      cancellation_deadline = case when p_status = 'none' then null else p_cancellation_deadline end,
      is_locked = v_next_locked,
      reservation_auto_locked = v_next_auto_locked,
      updated_at = now()
  where id = p_item_id and trip_id = p_trip_id;
end;
$$;

revoke all on function update_itinerary_reservation(
  uuid, uuid, uuid, text, timestamptz, text, text, timestamptz
) from public, anon, authenticated;
grant execute on function update_itinerary_reservation(
  uuid, uuid, uuid, text, timestamptz, text, text, timestamptz
) to service_role;
