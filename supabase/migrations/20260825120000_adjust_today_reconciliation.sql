-- Adjust today: organizer-confirmed, grounded re-planning of the current day.
--
-- The running-late repair reshuffles a day the group can no longer keep. This
-- slice answers a different moment: the group's *intent* changed ("we're low on
-- energy", "keep the museum but find dinner somewhere accessible", "shorter
-- afternoon"). The organizer types a constraint, the app grounds replacements in
-- the trip's own verified venue pool against current regular hours, previews
-- every move/removal/replacement and its reservation and travel impact, and only
-- then writes — as one auditable transaction.
--
-- Everything the route can guarantee in Node is re-checked here, because the
-- reviewed preview and the apply are two requests: the snapshot, the protected
-- rows, the destination vacancies, and the audit row all change together or not
-- at all.

-- ---------------------------------------------------------------------------
-- Lifecycle instrumentation (shared, not adjust-today-private).
--
-- The roadmap asks for previewed/applied/abandoned and follow-through before any
-- broader expansion, and no event store existed. One append-only, service-role
-- table serves every lifecycle event the app records; adjust-today writes
-- `adjust_today_previewed` / `adjust_today_applied` / `adjust_today_abandoned`
-- and the activity-status route tags done/skip/change outcomes that follow an
-- accepted revision so follow-through can be measured.
--
-- Read by the service role only (API routes) — never exposed to anon clients.
create table if not exists trip_events (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  actor_id uuid references travelers(id) on delete set null,
  kind text not null,
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create index if not exists trip_events_trip_created
  on trip_events (trip_id, created_at desc);
create index if not exists trip_events_kind
  on trip_events (trip_id, kind);
create index if not exists trip_events_actor
  on trip_events (actor_id)
  where actor_id is not null;

alter table trip_events enable row level security;
revoke all on table trip_events from public, anon, authenticated;
grant all on table trip_events to service_role;

-- ---------------------------------------------------------------------------
-- The accepted revision is group-visible and traceable.
--
-- `itinerary_revisions.kind` and `.trigger` were created with closed check lists
-- for the running-late repair. Loosen both to admit this feature's kind and its
-- free-text trigger (the organizer's own constraint), then pin the new kind by
-- name. Postgres names inline check constraints; drop by discovery so the
-- migration does not depend on the generated name.
do $$
declare
  c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'itinerary_revisions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%kind%'
  loop
    execute format('alter table itinerary_revisions drop constraint %I', c.conname);
  end loop;
  for c in
    select conname from pg_constraint
    where conrelid = 'itinerary_revisions'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%trigger%'
  loop
    execute format('alter table itinerary_revisions drop constraint %I', c.conname);
  end loop;
end $$;

alter table itinerary_revisions
  add constraint itinerary_revisions_kind_allowed
    check (kind in ('partial_day', 'adjust_today')),
  add constraint itinerary_revisions_trigger_allowed
    check (trigger in ('running-late', 'intent'));

-- A revision stores the reason the organizer wrote and a content fingerprint of
-- the preview it came from, so the group can see what changed and why, and so a
-- re-applied or edited preview can be told apart from the one that was reviewed.
alter table itinerary_revisions
  add column if not exists reason text not null default '',
  add column if not exists fingerprint text;

-- Items changed by an accepted revision carry a one-shot attribution marker.
-- The next explicit status, lock, or move consumes it; ordinary itinerary edits
-- therefore cannot be mistaken for adjust-today follow-through.
alter table itinerary_items
  add column if not exists adjust_today_revision_id uuid
    references itinerary_revisions(id) on delete set null;

create index if not exists itinerary_items_adjust_today_revision
  on itinerary_items (adjust_today_revision_id)
  where adjust_today_revision_id is not null;

-- ---------------------------------------------------------------------------
-- Preview snapshots.
--
-- A preview is a claim about a plan at an instant. Persisting it lets the apply
-- re-check that the plan has not moved between the preview the organizer read
-- and the confirmation they pressed — and refuse (stale-plan) instead of
-- forcing a write against a day that no longer exists. The row also lets the
-- server re-verify the submitted revision is *the* reviewed revision, by
-- fingerprint, rather than trusting the client to echo back unmodified JSON.
create table if not exists adjust_today_previews (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  actor_id uuid not null references travelers(id) on delete cascade,
  day_index integer not null check (day_index >= 0),
  reason text not null,
  -- Content fingerprint (SHA-256 hex) of the canonical preview payload.
  fingerprint text not null,
  -- The snapshot of day-relevant item state the preview was computed against.
  snapshot jsonb not null,
  -- The full preview the organizer reviewed, so the apply can re-derive and
  -- compare instead of trusting the request body.
  preview jsonb not null,
  status text not null default 'open'
    check (status in ('open', 'applied', 'abandoned', 'expired', 'stale')),
  created_at timestamptz not null default now(),
  applied_at timestamptz,
  revision_id uuid references itinerary_revisions(id) on delete set null
);

-- A new preview supersedes the previous open one for the day, so at most one is
-- ever confirmable. Enforced in the function below rather than a partial unique
-- index so the supersede is an explicit, auditable transition.
create index if not exists adjust_today_previews_trip_day
  on adjust_today_previews (trip_id, day_index, created_at desc);
create index if not exists adjust_today_previews_actor
  on adjust_today_previews (actor_id);
create index if not exists adjust_today_previews_revision
  on adjust_today_previews (revision_id)
  where revision_id is not null;

alter table adjust_today_previews enable row level security;
revoke all on table adjust_today_previews from public, anon, authenticated;
grant all on table adjust_today_previews to service_role;

-- ---------------------------------------------------------------------------
-- Record a fresh preview and supersede the day's previous open one atomically.
create or replace function record_adjust_today_preview(
  p_trip_id uuid,
  p_actor_id uuid,
  p_day_index integer,
  p_reason text,
  p_fingerprint text,
  p_snapshot jsonb,
  p_preview jsonb
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  if not exists (
    select 1 from travelers
    where id = p_actor_id and trip_id = p_trip_id and is_organizer
  ) then
    raise exception 'adjust-today requires the trip organizer' using errcode = '42501';
  end if;
  if p_day_index < 0 then
    raise exception 'adjust-today day is invalid' using errcode = '23514';
  end if;

  update adjust_today_previews
  set status = 'stale'
  where trip_id = p_trip_id and day_index = p_day_index and status = 'open';

  insert into adjust_today_previews (
    trip_id, actor_id, day_index, reason, fingerprint, snapshot, preview
  )
  values (
    p_trip_id, p_actor_id, p_day_index, p_reason, p_fingerprint, p_snapshot, p_preview
  )
  returning id into v_id;

  insert into trip_events (trip_id, actor_id, kind, detail)
  values (p_trip_id, p_actor_id, 'adjust_today_previewed', jsonb_build_object(
    'day_index', p_day_index,
    'reason', p_reason
  ));

  return v_id;
end;
$$;

-- Close a still-open preview without applying it. Used for the explicit
-- "abandon" the organizer triggers on the board; a preview that goes stale is
-- marked by `record_adjust_today_preview` / the apply, not here.
create or replace function abandon_adjust_today_preview(
  p_trip_id uuid,
  p_actor_id uuid,
  p_preview_id uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (
    select 1 from travelers
    where id = p_actor_id and trip_id = p_trip_id and is_organizer
  ) then
    raise exception 'adjust-today requires the trip organizer' using errcode = '42501';
  end if;

  update adjust_today_previews
  set status = 'abandoned'
  where id = p_preview_id and trip_id = p_trip_id and status = 'open';
  if not found then
    raise exception 'that preview is already settled' using errcode = '23514';
  end if;

  insert into trip_events (trip_id, actor_id, kind, detail)
  values (p_trip_id, p_actor_id, 'adjust_today_abandoned', jsonb_build_object(
    'preview_id', p_preview_id
  ));
end;
$$;

-- ---------------------------------------------------------------------------
-- Apply a reviewed preview atomically.
--
-- Re-validates the exact reviewed source state against live rows inside the
-- trip lock, applies moves, skips, and swap-ins, records one audit revision,
-- flips the preview to applied, and emits `adjust_today_applied` — all in one
-- transaction, so a partial failure rolls every change back.
create or replace function apply_adjust_today(
  p_trip_id uuid,
  p_actor_id uuid,
  p_preview_id uuid,
  p_fingerprint text,
  p_moves jsonb,
  p_skips jsonb,
  p_swaps jsonb,
  p_reason text
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_preview adjust_today_previews;
  v_revision_id uuid;
  v_change_count integer;
  v_moves jsonb;
  v_skips jsonb;
  v_swaps jsonb;
  v_reviewed_moves jsonb;
  v_reviewed_skips jsonb;
  v_reviewed_swaps jsonb;
begin
  if jsonb_typeof(p_moves) is distinct from 'array'
     or jsonb_typeof(p_skips) is distinct from 'array'
     or jsonb_typeof(p_swaps) is distinct from 'array' then
    raise exception 'adjust-today changes must be arrays' using errcode = '23514';
  end if;
  v_change_count := jsonb_array_length(p_moves) + jsonb_array_length(p_skips) + jsonb_array_length(p_swaps);
  if v_change_count = 0 or v_change_count > 8 then
    raise exception 'adjust-today changes have an invalid size' using errcode = '23514';
  end if;
  if coalesce(char_length(p_reason), 0) = 0 or char_length(p_reason) > 240 then
    raise exception 'adjust-today requires a stated reason' using errcode = '23514';
  end if;

  perform 1 from trips where id = p_trip_id for update;
  if not found then
    raise exception 'trip not found' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from travelers
    where id = p_actor_id and trip_id = p_trip_id and is_organizer
  ) then
    raise exception 'adjust-today requires the trip organizer' using errcode = '42501';
  end if;

  select * into v_preview
  from adjust_today_previews
  where id = p_preview_id and trip_id = p_trip_id
  for update;
  if not found then
    raise exception 'adjust-today preview not found' using errcode = 'P0002';
  end if;
  if v_preview.status <> 'open' then
    raise exception 'adjust-today preview is already settled' using errcode = '23505';
  end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', x.item_id, 'fromDayIndex', x.from_day_index, 'fromBlock', x.from_block,
    'toDayIndex', x.to_day_index, 'toBlock', x.to_block
  ) order by x.item_id), '[]'::jsonb) into v_moves
  from jsonb_to_recordset(p_moves) as x(item_id uuid, from_day_index integer, from_block text, to_day_index integer, to_block text);
  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', x.item_id, 'fromDayIndex', x.from_day_index, 'fromBlock', x.from_block
  ) order by x.item_id), '[]'::jsonb) into v_skips
  from jsonb_to_recordset(p_skips) as x(item_id uuid, from_day_index integer, from_block text);
  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', x.item_id, 'toCandidateId', x.to_candidate_id, 'fromDayIndex', x.from_day_index, 'fromBlock', x.from_block
  ) order by x.item_id), '[]'::jsonb) into v_swaps
  from jsonb_to_recordset(p_swaps) as x(item_id uuid, to_candidate_id uuid, from_day_index integer, from_block text);

  -- The persisted preview carries descriptive fields used by the confirmation
  -- UI. Project it to the same apply-time identity fields as the RPC payload
  -- before comparing, so valid descriptive previews pass while any changed
  -- item, source, destination, or replacement remains tamper-evident.
  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', x."itemId", 'fromDayIndex', x."fromDayIndex", 'fromBlock', x."fromBlock",
    'toDayIndex', x."toDayIndex", 'toBlock', x."toBlock"
  ) order by x."itemId"), '[]'::jsonb) into v_reviewed_moves
  from jsonb_to_recordset(coalesce(v_preview.preview->'impact'->'moves', '[]'::jsonb)) as x(
    "itemId" uuid, "fromDayIndex" integer, "fromBlock" text,
    "toDayIndex" integer, "toBlock" text
  );
  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', x."itemId", 'fromDayIndex', x."fromDayIndex", 'fromBlock', x."fromBlock"
  ) order by x."itemId"), '[]'::jsonb) into v_reviewed_skips
  from jsonb_to_recordset(coalesce(v_preview.preview->'impact'->'skips', '[]'::jsonb)) as x(
    "itemId" uuid, "fromDayIndex" integer, "fromBlock" text
  );
  select coalesce(jsonb_agg(jsonb_build_object(
    'itemId', x."itemId", 'toCandidateId', x."toCandidateId",
    'fromDayIndex', x."fromDayIndex", 'fromBlock', x."fromBlock"
  ) order by x."itemId"), '[]'::jsonb) into v_reviewed_swaps
  from jsonb_to_recordset(coalesce(v_preview.preview->'impact'->'swaps', '[]'::jsonb)) as x(
    "itemId" uuid, "toCandidateId" uuid, "fromDayIndex" integer, "fromBlock" text
  );

  -- The request uses snake_case RPC keys while the reviewed JSON uses the
  -- public camelCase shape; compare normalized values, not client formatting.
  if v_preview.fingerprint <> p_fingerprint or v_preview.actor_id <> p_actor_id
     or p_reason <> v_preview.reason
     or v_reviewed_moves is distinct from v_moves
     or v_reviewed_skips is distinct from v_skips
     or v_reviewed_swaps is distinct from v_swaps then
    raise exception 'adjust-today preview changed; preview again' using errcode = '23505';
  end if;
  if exists (
    select 1
    from jsonb_to_recordset(v_preview.snapshot) as snap(
      id uuid, "dayIndex" integer, block text, status text,
      "isLocked" boolean, "reservationLocked" boolean, "candidateId" uuid
    )
    left join itinerary_items live on live.id = snap.id and live.trip_id = p_trip_id
    where live.id is null
       or live.day_index <> snap."dayIndex"
       or live.block <> snap.block
       or coalesce(live.status, 'planned') <> snap.status
       or coalesce(live.is_locked, false) <> coalesce(snap."isLocked", false)
       or (live.reservation_status in ('tentative', 'confirmed')) <> coalesce(snap."reservationLocked", false)
       or live.candidate_id <> snap."candidateId"
  ) then
    raise exception 'adjust-today preview is stale; review today again' using errcode = '23514';
  end if;
  if (
    select count(*) <> count(distinct move.item_id)
        or count(*) <> count(distinct (move.to_day_index, move.to_block))
    from jsonb_to_recordset(p_moves) as move(
      item_id uuid, from_day_index integer, from_block text,
      to_day_index integer, to_block text
    )
  ) or (
    select count(*) <> count(distinct s.item_id)
    from jsonb_to_recordset(p_skips) as s(item_id uuid, from_day_index integer, from_block text)
  ) or (
    select count(*) <> count(distinct sw.item_id)
    from jsonb_to_recordset(p_swaps) as sw(item_id uuid, to_candidate_id uuid)
  ) then
    raise exception 'adjust-today changes contain duplicate items or destinations' using errcode = '23514';
  end if;

  -- No item may receive two different change types in one apply.
  if exists (
    select 1 from jsonb_to_recordset(p_moves) as m(item_id uuid)
    join jsonb_to_recordset(p_skips) as s(item_id uuid) on s.item_id = m.item_id
  ) or exists (
    select 1 from jsonb_to_recordset(p_moves) as m(item_id uuid)
    join jsonb_to_recordset(p_swaps) as sw(item_id uuid) on sw.item_id = m.item_id
  ) or exists (
    select 1 from jsonb_to_recordset(p_skips) as s(item_id uuid)
    join jsonb_to_recordset(p_swaps) as sw(item_id uuid) on sw.item_id = s.item_id
  ) then
    raise exception 'adjust-today changes conflict on the same activity' using errcode = '23514';
  end if;

  -- Stale-plan / protected-row guard for moves: still planned, unlocked, not
  -- reservation-locked, on the right day, and still in the slot that was
  -- previewed. Anything else means the plan moved under the preview.
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
       or item.reservation_status in ('tentative', 'confirmed')
       or item.day_index <> move.from_day_index
       or item.block <> move.from_block
       or move.from_day_index <> v_preview.day_index
       or move.to_day_index <> v_preview.day_index
       or move.to_block = move.from_block
       or move.to_block not in ('morning', 'lunch', 'afternoon', 'dinner', 'evening')
       or ((move.from_block in ('lunch', 'dinner')) <> (move.to_block in ('lunch', 'dinner')))
  ) then
    raise exception 'adjust-today preview is stale or contains an invalid move' using errcode = '23514';
  end if;

  -- Skips: same guard minus the destination checks.
  if exists (
    select 1
    from jsonb_to_recordset(p_skips) as s(item_id uuid, from_day_index integer, from_block text)
    left join itinerary_items item
      on item.id = s.item_id and item.trip_id = p_trip_id
    where item.id is null
       or item.status <> 'planned'
       or item.is_locked
       or item.reservation_status in ('tentative', 'confirmed')
       or item.day_index <> s.from_day_index
       or item.block <> s.from_block
       or s.from_day_index <> v_preview.day_index
  ) then
    raise exception 'adjust-today preview is stale or contains a protected skip' using errcode = '23514';
  end if;

  -- Swap-ins: the source row must still be movable, and the replacement must be
  -- a real venue for this trip that is not already planned today elsewhere.
  if exists (
    select 1
    from jsonb_to_recordset(p_swaps) as sw(
      item_id uuid, to_candidate_id uuid, from_day_index integer, from_block text
    )
    left join itinerary_items item
      on item.id = sw.item_id and item.trip_id = p_trip_id
    left join venue_candidates cand
      on cand.id = sw.to_candidate_id and cand.trip_id = p_trip_id
    where item.id is null
       or cand.id is null
       or item.status <> 'planned'
       or item.is_locked
       or item.reservation_status in ('tentative', 'confirmed')
       or item.day_index <> sw.from_day_index
       or item.block <> sw.from_block
       or sw.from_day_index <> v_preview.day_index
       or exists (
         select 1 from itinerary_items other
         where other.trip_id = p_trip_id
           and other.status = 'planned'
           and other.day_index = v_preview.day_index
           and other.candidate_id = sw.to_candidate_id
           and other.id <> sw.item_id
       )
  ) then
    raise exception 'adjust-today preview is stale or contains an invalid replacement' using errcode = '23514';
  end if;

  -- A moved destination must be vacant, ignoring slots the same apply is
  -- already vacating (that is what makes a same-day swap of two slots legal).
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
    raise exception 'an adjust-today destination is occupied' using errcode = '23505';
  end if;

  -- Create the audit row before mutating items so every changed row can carry
  -- the accepted revision that caused it. The whole function remains atomic.
  insert into itinerary_revisions (trip_id, actor_id, kind, trigger, day_index, changes, reason, fingerprint)
  values (
    p_trip_id,
    p_actor_id,
    'adjust_today',
    'intent',
    v_preview.day_index,
    jsonb_build_object(
      'reason', p_reason,
      'moves', p_moves,
      'skips', p_skips,
      'swaps', p_swaps
    ),
    p_reason,
    p_fingerprint
  )
  returning id into v_revision_id;

  -- Vacate every reviewed source first so a two-way slot swap cannot trip the
  -- active-plan unique index; moves are restored to planned immediately after.
  update itinerary_items item
  set status = 'skipped',
      completed_at = null,
      completed_day_index = null,
      state_changed_by = p_actor_id,
      adjust_today_revision_id = v_revision_id,
      updated_at = now()
  where item.trip_id = p_trip_id
    and (
      exists (select 1 from jsonb_to_recordset(p_moves) as m(item_id uuid) where m.item_id = item.id)
      or exists (select 1 from jsonb_to_recordset(p_skips) as s(item_id uuid) where s.item_id = item.id)
    );

  -- Moves keep their venue and block kind; only the slot changes.
  update itinerary_items item
  set day_index = move.to_day_index,
      block = move.to_block,
      status = 'planned',
      state_changed_by = p_actor_id,
      adjust_today_revision_id = v_revision_id,
      updated_at = now()
  from jsonb_to_recordset(p_moves) as move(
    item_id uuid, from_day_index integer, from_block text,
    to_day_index integer, to_block text
  )
  where item.id = move.item_id and item.trip_id = p_trip_id;

  -- Swap-ins replace the venue and every venue-derived item field together.
  -- Those values come from the persisted server preview, not the request.
  update itinerary_items item
  set candidate_id = sw."toCandidateId",
      why_note = sw.reason,
      duration_min = sw."durationMin",
      area = sw.area,
      state_changed_by = p_actor_id,
      adjust_today_revision_id = v_revision_id,
      updated_at = now()
  from jsonb_to_recordset(coalesce(v_preview.preview->'impact'->'swaps', '[]'::jsonb)) as sw(
    "itemId" uuid, "toCandidateId" uuid, reason text, "durationMin" integer, area text
  )
  where item.id = sw."itemId" and item.trip_id = p_trip_id;

  -- Travel warnings describe legs between final planned stops. Recompute them
  -- in the preview and persist the reviewed values for every affected survivor.
  update itinerary_items item
  set travel_warning = warning."travelWarning",
      updated_at = now()
  from jsonb_to_recordset(coalesce(v_preview.preview->'impact'->'warningUpdates', '[]'::jsonb)) as warning(
    "itemId" uuid, "travelWarning" boolean
  )
  where item.id = warning."itemId" and item.trip_id = p_trip_id;

  update adjust_today_previews
  set status = 'applied', applied_at = now(), revision_id = v_revision_id
  where id = p_preview_id;

  insert into trip_events (trip_id, actor_id, kind, detail)
  values (p_trip_id, p_actor_id, 'adjust_today_applied', jsonb_build_object(
    'preview_id', p_preview_id,
    'revision_id', v_revision_id,
    'day_index', v_preview.day_index,
    'change_count', v_change_count
  ));

  return v_revision_id;
end;
$$;

revoke all on function record_adjust_today_preview(uuid, uuid, integer, text, text, jsonb, jsonb)
  from public, anon, authenticated;
revoke all on function abandon_adjust_today_preview(uuid, uuid, uuid)
  from public, anon, authenticated;
revoke all on function apply_adjust_today(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, text)
  from public, anon, authenticated;

grant execute on function record_adjust_today_preview(uuid, uuid, integer, text, text, jsonb, jsonb)
  to service_role;
grant execute on function abandon_adjust_today_preview(uuid, uuid, uuid)
  to service_role;
grant execute on function apply_adjust_today(uuid, uuid, uuid, text, jsonb, jsonb, jsonb, text)
  to service_role;
