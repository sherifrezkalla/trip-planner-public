-- Private reservation evidence with direct signed Storage transfers,
-- concurrency-safe activation, and durable object-cleanup audit history.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'reservation-proofs',
  'reservation-proofs',
  false,
  8388608,
  array['image/jpeg', 'image/png', 'image/webp', 'application/pdf']
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table itinerary_items
  add column reservation_details_source text not null default 'organizer'
    check (reservation_details_source in ('organizer', 'artifact')),
  add column reservation_organizer_verified_at timestamptz,
  add column reservation_organizer_verified_by uuid references travelers(id) on delete set null;

-- Do not invent verification for legacy confirmed rows without a reference.
update itinerary_items
set reservation_status = 'tentative'
where reservation_status = 'confirmed'
  and nullif(trim(confirmation_number), '') is null;

alter table itinerary_items
  add constraint itinerary_confirmed_reservation_is_grounded check (
    reservation_status <> 'confirmed'
    or nullif(trim(confirmation_number), '') is not null
    or reservation_organizer_verified_at is not null
  );

create table reservation_proof_artifacts (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  itinerary_item_id uuid not null references itinerary_items(id) on delete cascade,
  uploaded_by uuid not null references travelers(id) on delete restrict,
  status text not null default 'pending_upload'
    check (status in ('pending_upload', 'active', 'pending_delete', 'deleted')),
  expected_active_artifact_id uuid references reservation_proof_artifacts(id) on delete set null,
  storage_path text not null unique,
  original_file_name text not null check (char_length(original_file_name) between 1 and 240),
  declared_media_type text not null
    check (declared_media_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  declared_byte_size integer not null check (declared_byte_size between 1 and 8388608),
  media_type text check (media_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  byte_size integer check (byte_size between 1 and 8388608),
  storage_etag text check (storage_etag is null or char_length(storage_etag) between 1 and 200),
  content_sha256 text check (content_sha256 is null or content_sha256 ~ '^[0-9a-f]{64}$'),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default (now() + interval '2 hours'),
  activated_at timestamptz,
  deleted_at timestamptz,
  constraint reservation_proof_active_metadata_complete check (
    status <> 'active'
    or (media_type is not null and byte_size is not null and storage_etag is not null
      and content_sha256 is not null and activated_at is not null)
  )
);

create unique index one_active_reservation_proof_per_item
  on reservation_proof_artifacts(itinerary_item_id)
  where status = 'active';
create index reservation_proof_artifacts_trip_status
  on reservation_proof_artifacts(trip_id, status, created_at);

create table reservation_proof_cleanup_jobs (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references reservation_proof_artifacts(id) on delete restrict,
  trip_id uuid references trips(id) on delete set null,
  itinerary_item_id uuid references itinerary_items(id) on delete set null,
  storage_path text not null unique,
  reason text not null check (char_length(reason) between 1 and 80),
  status text not null default 'pending' check (status in ('pending', 'succeeded')),
  attempts integer not null default 0 check (attempts >= 0),
  last_attempt_at timestamptz,
  next_retry_at timestamptz not null default now(),
  last_error text check (last_error is null or char_length(last_error) <= 500),
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index reservation_proof_cleanup_due
  on reservation_proof_cleanup_jobs(trip_id, next_retry_at)
  where status = 'pending';

alter table reservation_proof_artifacts enable row level security;
alter table reservation_proof_cleanup_jobs enable row level security;
revoke all on reservation_proof_artifacts, reservation_proof_cleanup_jobs from public, anon, authenticated;
-- Deliberately no client policies: only organizer-authenticated service routes may act.

create or replace function begin_reservation_proof_upload(
  p_trip_id uuid,
  p_actor_id uuid,
  p_item_id uuid,
  p_storage_path text,
  p_original_file_name text,
  p_declared_media_type text,
  p_declared_byte_size integer
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_expected_active uuid;
  v_artifact_id uuid;
begin
  if p_declared_media_type not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
    or p_declared_byte_size not between 1 and 8388608
    or char_length(p_original_file_name) not between 1 and 240 then
    raise exception 'invalid proof upload metadata' using errcode = '23514';
  end if;

  perform 1 from trips where id = p_trip_id for update;
  if not found then raise exception 'trip not found' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from travelers
    where id = p_actor_id and trip_id = p_trip_id and is_organizer
  ) then
    raise exception 'proof changes require the trip organizer' using errcode = '42501';
  end if;
  perform 1 from itinerary_items where id = p_item_id and trip_id = p_trip_id for update;
  if not found then raise exception 'activity not found' using errcode = 'P0002'; end if;

  select id into v_expected_active
  from reservation_proof_artifacts
  where itinerary_item_id = p_item_id and trip_id = p_trip_id and status = 'active'
  for update;

  insert into reservation_proof_artifacts (
    trip_id, itinerary_item_id, uploaded_by, expected_active_artifact_id,
    storage_path, original_file_name, declared_media_type, declared_byte_size
  ) values (
    p_trip_id, p_item_id, p_actor_id, v_expected_active,
    p_storage_path, p_original_file_name, p_declared_media_type, p_declared_byte_size
  ) returning id into v_artifact_id;

  return jsonb_build_object('artifact_id', v_artifact_id);
end;
$$;

create or replace function finalize_reservation_proof_upload(
  p_trip_id uuid,
  p_actor_id uuid,
  p_artifact_id uuid,
  p_media_type text,
  p_byte_size integer,
  p_storage_etag text,
  p_content_sha256 text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_pending reservation_proof_artifacts%rowtype;
  v_current reservation_proof_artifacts%rowtype;
  v_cleanup_job_id uuid;
  v_outcome text;
begin
  if p_media_type not in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')
    or p_byte_size not between 1 and 8388608
    or nullif(trim(p_storage_etag), '') is null
    or char_length(p_storage_etag) > 200
    or p_content_sha256 is null
    or p_content_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'invalid inspected proof metadata' using errcode = '23514';
  end if;

  perform 1 from trips where id = p_trip_id for update;
  if not found then raise exception 'trip not found' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from travelers
    where id = p_actor_id and trip_id = p_trip_id and is_organizer
  ) then
    raise exception 'proof changes require the trip organizer' using errcode = '42501';
  end if;

  select * into v_pending
  from reservation_proof_artifacts
  where id = p_artifact_id and trip_id = p_trip_id and uploaded_by = p_actor_id
  for update;
  if not found then raise exception 'proof upload not found' using errcode = 'P0002'; end if;
  if v_pending.status = 'active' then
    return jsonb_build_object('outcome', 'already_finalized');
  elsif v_pending.status <> 'pending_upload' then
    return jsonb_build_object('outcome', 'stale');
  end if;

  select * into v_current
  from reservation_proof_artifacts
  where itinerary_item_id = v_pending.itinerary_item_id
    and trip_id = p_trip_id
    and status = 'active'
  for update;

  if v_current.id is distinct from v_pending.expected_active_artifact_id then
    update reservation_proof_artifacts set status = 'pending_delete' where id = v_pending.id;
    insert into reservation_proof_cleanup_jobs (
      artifact_id, trip_id, itinerary_item_id, storage_path, reason
    ) values (
      v_pending.id, p_trip_id, v_pending.itinerary_item_id, v_pending.storage_path, 'stale_replacement'
    ) on conflict (storage_path) do update set next_retry_at = now()
    returning id into v_cleanup_job_id;
    return jsonb_build_object('outcome', 'stale', 'cleanup_job_id', v_cleanup_job_id);
  end if;

  if v_current.id is not null
    and v_current.content_sha256 = p_content_sha256
    and v_current.byte_size = p_byte_size then
    update reservation_proof_artifacts set status = 'pending_delete' where id = v_pending.id;
    insert into reservation_proof_cleanup_jobs (
      artifact_id, trip_id, itinerary_item_id, storage_path, reason
    ) values (
      v_pending.id, p_trip_id, v_pending.itinerary_item_id, v_pending.storage_path, 'duplicate_content'
    ) on conflict (storage_path) do update set next_retry_at = now()
    returning id into v_cleanup_job_id;
    return jsonb_build_object('outcome', 'duplicate', 'cleanup_job_id', v_cleanup_job_id);
  end if;

  if v_current.id is not null then
    update reservation_proof_artifacts set status = 'pending_delete' where id = v_current.id;
    insert into reservation_proof_cleanup_jobs (
      artifact_id, trip_id, itinerary_item_id, storage_path, reason
    ) values (
      v_current.id, p_trip_id, v_current.itinerary_item_id, v_current.storage_path, 'replaced'
    ) on conflict (storage_path) do update set next_retry_at = now()
    returning id into v_cleanup_job_id;
    v_outcome := 'replaced';
  else
    v_outcome := 'created';
  end if;

  update reservation_proof_artifacts set
    status = 'active',
    media_type = p_media_type,
    byte_size = p_byte_size,
    storage_etag = p_storage_etag,
    content_sha256 = p_content_sha256,
    activated_at = now()
  where id = v_pending.id;

  update itinerary_items set reservation_details_source = 'artifact', updated_at = now()
  where id = v_pending.itinerary_item_id and trip_id = p_trip_id;

  return jsonb_build_object(
    'outcome', v_outcome,
    'artifact_id', v_pending.id,
    'cleanup_job_id', v_cleanup_job_id
  );
end;
$$;

create or replace function abandon_reservation_proof_upload(
  p_trip_id uuid,
  p_actor_id uuid,
  p_artifact_id uuid,
  p_reason text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_artifact reservation_proof_artifacts%rowtype;
  v_cleanup_job_id uuid;
begin
  perform 1 from trips where id = p_trip_id for update;
  if not found then raise exception 'trip not found' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from travelers
    where id = p_actor_id and trip_id = p_trip_id and is_organizer
  ) then
    raise exception 'proof changes require the trip organizer' using errcode = '42501';
  end if;
  select * into v_artifact from reservation_proof_artifacts
  where id = p_artifact_id and trip_id = p_trip_id and uploaded_by = p_actor_id
  for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;
  if v_artifact.status = 'pending_upload' then
    update reservation_proof_artifacts set status = 'pending_delete' where id = v_artifact.id;
  elsif v_artifact.status not in ('pending_delete', 'deleted') then
    return jsonb_build_object('outcome', 'not_abandoned');
  end if;
  if v_artifact.status = 'deleted' then return jsonb_build_object('outcome', 'deleted'); end if;
  insert into reservation_proof_cleanup_jobs (
    artifact_id, trip_id, itinerary_item_id, storage_path, reason
  ) values (
    v_artifact.id, p_trip_id, v_artifact.itinerary_item_id, v_artifact.storage_path, left(p_reason, 80)
  ) on conflict (storage_path) do update set next_retry_at = now()
  returning id into v_cleanup_job_id;
  return jsonb_build_object('outcome', 'queued', 'cleanup_job_id', v_cleanup_job_id);
end;
$$;

create or replace function remove_reservation_proof(
  p_trip_id uuid,
  p_actor_id uuid,
  p_item_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_artifact reservation_proof_artifacts%rowtype;
  v_cleanup_job_id uuid;
begin
  perform 1 from trips where id = p_trip_id for update;
  if not found then raise exception 'trip not found' using errcode = 'P0002'; end if;
  if not exists (
    select 1 from travelers
    where id = p_actor_id and trip_id = p_trip_id and is_organizer
  ) then
    raise exception 'proof changes require the trip organizer' using errcode = '42501';
  end if;
  perform 1 from itinerary_items where id = p_item_id and trip_id = p_trip_id for update;
  if not found then raise exception 'activity not found' using errcode = 'P0002'; end if;
  select * into v_artifact from reservation_proof_artifacts
  where itinerary_item_id = p_item_id and trip_id = p_trip_id and status = 'active'
  for update;
  if not found then return jsonb_build_object('outcome', 'not_found'); end if;

  update reservation_proof_artifacts set status = 'pending_delete' where id = v_artifact.id;
  insert into reservation_proof_cleanup_jobs (
    artifact_id, trip_id, itinerary_item_id, storage_path, reason
  ) values (
    v_artifact.id, p_trip_id, p_item_id, v_artifact.storage_path, 'removed'
  ) on conflict (storage_path) do update set next_retry_at = now()
  returning id into v_cleanup_job_id;
  update itinerary_items set reservation_details_source = 'organizer', updated_at = now()
  where id = p_item_id and trip_id = p_trip_id;
  return jsonb_build_object('outcome', 'removed', 'cleanup_job_id', v_cleanup_job_id);
end;
$$;

create or replace function enqueue_expired_reservation_proof_uploads(
  p_trip_id uuid,
  p_actor_id uuid
)
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_artifact reservation_proof_artifacts%rowtype;
  v_count integer := 0;
begin
  if not exists (
    select 1 from travelers
    where id = p_actor_id and trip_id = p_trip_id and is_organizer
  ) then
    raise exception 'proof cleanup requires the trip organizer' using errcode = '42501';
  end if;
  for v_artifact in
    select * from reservation_proof_artifacts
    where trip_id = p_trip_id and status = 'pending_upload' and expires_at <= now()
    for update skip locked
  loop
    update reservation_proof_artifacts set status = 'pending_delete' where id = v_artifact.id;
    insert into reservation_proof_cleanup_jobs (
      artifact_id, trip_id, itinerary_item_id, storage_path, reason
    ) values (
      v_artifact.id, p_trip_id, v_artifact.itinerary_item_id, v_artifact.storage_path, 'expired_upload'
    ) on conflict (storage_path) do update set next_retry_at = now();
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$$;

create or replace function record_reservation_proof_cleanup_failure(
  p_job_id uuid,
  p_error text
)
returns void
language sql
security definer
set search_path = public
as $$
  update reservation_proof_cleanup_jobs set
    attempts = attempts + 1,
    last_attempt_at = now(),
    next_retry_at = now() + make_interval(secs => least(3600, (30 * power(2, least(attempts, 7)))::integer)),
    last_error = left(p_error, 500)
  where id = p_job_id and status = 'pending';
$$;

create or replace function complete_reservation_proof_cleanup(p_job_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_job reservation_proof_cleanup_jobs%rowtype;
begin
  select * into v_job from reservation_proof_cleanup_jobs where id = p_job_id for update;
  if not found or v_job.status = 'succeeded' then return; end if;
  update reservation_proof_artifacts set status = 'deleted', deleted_at = now()
  where id = v_job.artifact_id and status = 'pending_delete';
  update reservation_proof_cleanup_jobs set
    status = 'succeeded', attempts = attempts + 1, last_attempt_at = now(),
    completed_at = now(), last_error = null
  where id = p_job_id;
end;
$$;

-- Reservation RPC v2. The legacy eight-argument wrapper remains available
-- during the migration-before-deploy window and for PR #72 until it is rebased.
create or replace function update_itinerary_reservation(
  p_trip_id uuid,
  p_actor_id uuid,
  p_item_id uuid,
  p_status text,
  p_reservation_at timestamptz,
  p_confirmation_number text,
  p_booking_url text,
  p_cancellation_deadline timestamptz,
  p_details_source text,
  p_organizer_verified boolean
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
  if p_status not in ('none', 'tentative', 'confirmed', 'cancelled') then raise exception 'reservation status is invalid' using errcode = '23514'; end if;
  if p_details_source not in ('organizer', 'artifact') then raise exception 'reservation source is invalid' using errcode = '23514'; end if;
  if p_status = 'confirmed' and p_reservation_at is null then raise exception 'confirmed reservations require a date and time' using errcode = '23514'; end if;
  if p_status = 'confirmed' and nullif(trim(p_confirmation_number), '') is null and not p_organizer_verified then
    raise exception 'confirmed reservations require a confirmation reference or organizer verification' using errcode = '23514';
  end if;
  if p_booking_url is not null and p_booking_url !~* '^https?://' then raise exception 'booking link must use http or https' using errcode = '23514'; end if;

  perform 1 from trips where id = p_trip_id for update;
  if not found then raise exception 'trip not found' using errcode = 'P0002'; end if;
  if not exists (select 1 from travelers where id = p_actor_id and trip_id = p_trip_id and is_organizer) then
    raise exception 'reservation changes require the trip organizer' using errcode = '42501';
  end if;
  select status, is_locked, reservation_auto_locked into v_item_status, v_is_locked, v_auto_locked
  from itinerary_items where id = p_item_id and trip_id = p_trip_id for update;
  if not found then raise exception 'activity not found' using errcode = 'P0002'; end if;

  v_next_locked := v_is_locked;
  v_next_auto_locked := v_auto_locked;
  if p_status in ('tentative', 'confirmed') and v_item_status = 'planned' then
    v_next_auto_locked := v_auto_locked or not v_is_locked;
    v_next_locked := true;
  elsif v_auto_locked then
    v_next_locked := false;
    v_next_auto_locked := false;
  end if;

  update itinerary_items set
    reservation_status = p_status,
    reservation_at = case when p_status = 'none' then null else p_reservation_at end,
    confirmation_number = case when p_status = 'none' then null else nullif(trim(p_confirmation_number), '') end,
    booking_url = case when p_status = 'none' then null else nullif(trim(p_booking_url), '') end,
    cancellation_deadline = case when p_status = 'none' then null else p_cancellation_deadline end,
    reservation_details_source = case when p_status = 'none' then 'organizer' else p_details_source end,
    reservation_organizer_verified_at = case when p_status <> 'none' and p_organizer_verified then coalesce(reservation_organizer_verified_at, now()) else null end,
    reservation_organizer_verified_by = case when p_status <> 'none' and p_organizer_verified then p_actor_id else null end,
    is_locked = v_next_locked,
    reservation_auto_locked = v_next_auto_locked,
    updated_at = now()
  where id = p_item_id and trip_id = p_trip_id;
end;
$$;

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
language sql
security definer
set search_path = public
as $$
  select update_itinerary_reservation(
    p_trip_id, p_actor_id, p_item_id, p_status, p_reservation_at,
    p_confirmation_number, p_booking_url, p_cancellation_deadline,
    'organizer', false
  );
$$;

revoke all on function begin_reservation_proof_upload(uuid, uuid, uuid, text, text, text, integer) from public, anon, authenticated;
revoke all on function finalize_reservation_proof_upload(uuid, uuid, uuid, text, integer, text, text) from public, anon, authenticated;
revoke all on function abandon_reservation_proof_upload(uuid, uuid, uuid, text) from public, anon, authenticated;
revoke all on function remove_reservation_proof(uuid, uuid, uuid) from public, anon, authenticated;
revoke all on function enqueue_expired_reservation_proof_uploads(uuid, uuid) from public, anon, authenticated;
revoke all on function record_reservation_proof_cleanup_failure(uuid, text) from public, anon, authenticated;
revoke all on function complete_reservation_proof_cleanup(uuid) from public, anon, authenticated;
revoke all on function update_itinerary_reservation(uuid, uuid, uuid, text, timestamptz, text, text, timestamptz) from public, anon, authenticated;
revoke all on function update_itinerary_reservation(uuid, uuid, uuid, text, timestamptz, text, text, timestamptz, text, boolean) from public, anon, authenticated;

grant execute on function begin_reservation_proof_upload(uuid, uuid, uuid, text, text, text, integer) to service_role;
grant execute on function finalize_reservation_proof_upload(uuid, uuid, uuid, text, integer, text, text) to service_role;
grant execute on function abandon_reservation_proof_upload(uuid, uuid, uuid, text) to service_role;
grant execute on function remove_reservation_proof(uuid, uuid, uuid) to service_role;
grant execute on function enqueue_expired_reservation_proof_uploads(uuid, uuid) to service_role;
grant execute on function record_reservation_proof_cleanup_failure(uuid, text) to service_role;
grant execute on function complete_reservation_proof_cleanup(uuid) to service_role;
grant execute on function update_itinerary_reservation(uuid, uuid, uuid, text, timestamptz, text, text, timestamptz) to service_role;
grant execute on function update_itinerary_reservation(uuid, uuid, uuid, text, timestamptz, text, text, timestamptz, text, boolean) to service_role;

comment on table reservation_proof_artifacts is
  'Private reservation proof lifecycle; non-active rows retain enough metadata for safe cleanup and concurrency auditing.';
comment on table reservation_proof_cleanup_jobs is
  'Durable, retryable audit ledger for private Storage object deletion.';
