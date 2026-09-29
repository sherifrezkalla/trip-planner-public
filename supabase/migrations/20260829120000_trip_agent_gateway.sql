-- One organizer-owned connector is authoritative for a trip. Replacing or
-- rotating it updates this row instead of creating competing agent identities.
create table trip_agent_connections (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null unique references trips(id) on delete cascade,
  provider text not null check (provider in ('openclaw', 'hermes')),
  lifecycle_generation integer not null default 1 check (lifecycle_generation > 0),
  status text not null default 'pending'
    check (status in ('pending', 'paired', 'active', 'paused', 'revoked', 'archived')),
  credential_digest text unique,
  pairing_code_digest text unique,
  pairing_expires_at timestamptz,
  granted_scopes text[] not null default array['connector.setup']::text[]
    check (granted_scopes <@ array[
      'connector.setup',
      'trip.read',
      'trip.research',
      'trip.propose',
      'trip.modify',
      'trip.vote',
      'proactive.read',
      'announcement.write'
    ]::text[]),
  authority_policy jsonb not null default jsonb_build_object(
    'travelerCanAddSuggestion', true,
    'travelerCanProposeChange', true
  ) check (
    jsonb_typeof(authority_policy) = 'object'
    and authority_policy ? 'travelerCanAddSuggestion'
    and authority_policy ? 'travelerCanProposeChange'
    and authority_policy - 'travelerCanAddSuggestion' - 'travelerCanProposeChange' = '{}'::jsonb
    and jsonb_typeof(authority_policy -> 'travelerCanAddSuggestion') = 'boolean'
    and jsonb_typeof(authority_policy -> 'travelerCanProposeChange') = 'boolean'
  ),
  agent_phone_e164 text,
  whatsapp_group_digest text,
  whatsapp_group_label text,
  privacy_notice_version text,
  privacy_notice_message_digest text,
  last_seen_at timestamptz,
  paired_at timestamptz,
  activated_at timestamptz,
  paused_at timestamptz,
  revoked_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, trip_id),
  constraint trip_agent_connections_digest_formats check (
    (credential_digest is null or credential_digest ~ '^[0-9a-f]{64}$')
    and (pairing_code_digest is null or pairing_code_digest ~ '^[0-9a-f]{64}$')
    and (whatsapp_group_digest is null or whatsapp_group_digest ~ '^[0-9a-f]{64}$')
    and (
      privacy_notice_message_digest is null
      or privacy_notice_message_digest ~ '^[0-9a-f]{64}$'
    )
  ),
  constraint trip_agent_connections_digest_lifecycle check (
    (
      status = 'pending'
      and credential_digest is null
      and pairing_code_digest is not null
      and pairing_expires_at is not null
    )
    or (
      status in ('paired', 'active', 'paused')
      and credential_digest is not null
      and pairing_code_digest is null
      and pairing_expires_at is null
    )
    or (
      status in ('revoked', 'archived')
      and credential_digest is null
      and pairing_code_digest is null
      and pairing_expires_at is null
    )
  )
);

comment on table trip_agent_connections is
  'One connector per trip. Credentials, pairing codes, group IDs, and notice receipts are stored only as digests.';
comment on column trip_agent_connections.credential_digest is
  'SHA-256 digest of the revocable bearer credential; plaintext is returned once and never persisted.';
comment on column trip_agent_connections.pairing_code_digest is
  'SHA-256 digest of the one-time pairing code; plaintext is never persisted.';
comment on column trip_agent_connections.whatsapp_group_digest is
  'Connection-and-lifecycle-scoped HMAC of the provider group identifier; never the raw identifier.';

create index trip_agent_connections_active_lookup
  on trip_agent_connections (credential_digest)
  where status in ('paired', 'active');

alter table travelers
  add constraint travelers_id_trip_id_for_agent_unique unique (id, trip_id);

create table trip_agent_participant_mappings (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null,
  trip_id uuid not null,
  lifecycle_generation integer not null default 1 check (lifecycle_generation > 0),
  external_participant_digest text not null
    check (external_participant_digest ~ '^[0-9a-f]{64}$'),
  display_name_hint text,
  traveler_id uuid,
  status text not null default 'suggested'
    check (status in ('suggested', 'confirmed', 'revoked')),
  confirmed_by uuid,
  confirmed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, lifecycle_generation, external_participant_digest),
  constraint trip_agent_participant_mapping_connection_same_trip
    foreign key (connection_id, trip_id)
    references trip_agent_connections(id, trip_id) on delete cascade,
  constraint trip_agent_participant_mapping_traveler_same_trip
    foreign key (traveler_id, trip_id)
    references travelers(id, trip_id) on delete cascade,
  constraint trip_agent_participant_mapping_confirmer_same_trip
    foreign key (confirmed_by, trip_id)
    references travelers(id, trip_id) on delete cascade,
  constraint trip_agent_participant_mapping_lifecycle check (
    (
      status = 'suggested'
      and confirmed_by is null
      and confirmed_at is null
      and revoked_at is null
    )
    or (
      status = 'confirmed'
      and traveler_id is not null
      and confirmed_by is not null
      and confirmed_at is not null
      and revoked_at is null
    )
    or (status = 'revoked' and revoked_at is not null)
  )
);

comment on table trip_agent_participant_mappings is
  'Digest-only provider identities remain unmatched suggestions until an organizer confirms a same-trip traveler.';
comment on column trip_agent_participant_mappings.external_participant_digest is
  'Connection-and-lifecycle-scoped HMAC of the provider participant identifier; never the raw identifier.';

create unique index trip_agent_participant_mappings_confirmed_traveler
  on trip_agent_participant_mappings (connection_id, lifecycle_generation, traveler_id)
  where status = 'confirmed';
create index trip_agent_participant_mappings_confirmed_lookup
  on trip_agent_participant_mappings (connection_id, lifecycle_generation, external_participant_digest)
  where status = 'confirmed';

create function set_trip_agent_mapping_trip_id()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_trip_id uuid;
  v_generation integer;
begin
  if tg_op = 'UPDATE' then
    if new.connection_id is distinct from old.connection_id
       or new.trip_id is distinct from old.trip_id
       or new.lifecycle_generation is distinct from old.lifecycle_generation then
      raise exception 'participant mapping lifecycle scope is immutable';
    end if;
    return new;
  end if;

  select trip_id, lifecycle_generation into v_trip_id, v_generation
  from trip_agent_connections
  where id = new.connection_id;

  if v_trip_id is null then
    raise exception 'participant mapping connection does not exist';
  end if;
  if new.lifecycle_generation is distinct from v_generation then
    raise exception 'participant mapping lifecycle is stale';
  end if;
  new.trip_id := v_trip_id;

  return new;
end;
$$;

create trigger trip_agent_participant_mappings_same_trip
before insert or update of connection_id, trip_id, lifecycle_generation
on trip_agent_participant_mappings
for each row execute function set_trip_agent_mapping_trip_id();

alter table plan_proposals
  add constraint plan_proposals_id_trip_id_for_agent_unique unique (id, trip_id);

create table trip_agent_actions (
  id uuid primary key default gen_random_uuid(),
  connection_id uuid not null,
  trip_id uuid not null references trips(id) on delete cascade,
  lifecycle_generation integer not null default 1 check (lifecycle_generation > 0),
  idempotency_key text not null check (btrim(idempotency_key) <> ''),
  external_actor_digest text not null
    check (external_actor_digest ~ '^[0-9a-f]{64}$'),
  mapped_traveler_id uuid,
  operation text not null check (operation in (
    'register_group',
    'readiness',
    'activate',
    'read_context',
    'read_today',
    'search_options',
    'read_decisions',
    'preview_change',
    'commit_change',
    'vote',
    'decide',
    'report_announcement',
    'poll_proactive_events'
  )),
  normalized_request jsonb not null check (jsonb_typeof(normalized_request) = 'object'),
  preview jsonb check (preview is null or jsonb_typeof(preview) = 'object'),
  authority_decision text not null check (authority_decision in (
    'allowed',
    'requires_organizer_confirmation',
    'denied'
  )),
  status text not null default 'received' check (status in (
    'received',
    'previewed',
    'executing',
    'awaiting_vote',
    'awaiting_confirmation',
    'succeeded',
    'rejected',
    'cancelled',
    'failed',
    'unknown',
    'refused',
    'expired'
  )),
  plan_fingerprint text,
  confirmation_expires_at timestamptz,
  proposal_id uuid,
  canonical_reference jsonb
    check (canonical_reference is null or jsonb_typeof(canonical_reference) = 'object'),
  result jsonb check (result is null or jsonb_typeof(result) = 'object'),
  error_code text,
  announcement_status text not null default 'pending'
    check (announcement_status in ('pending', 'delivered', 'failed')),
  announced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  executed_at timestamptz,
  unique (connection_id, lifecycle_generation, idempotency_key),
  constraint trip_agent_action_traveler_same_trip
    foreign key (mapped_traveler_id, trip_id)
    references travelers(id, trip_id) on delete set null (mapped_traveler_id),
  constraint trip_agent_action_proposal_same_trip
    foreign key (proposal_id, trip_id)
    references plan_proposals(id, trip_id) on delete set null (proposal_id),
  foreign key (connection_id, trip_id)
    references trip_agent_connections(id, trip_id) on delete cascade
);

comment on table trip_agent_actions is
  'Durable idempotency and audit boundary for connector requests; a key is unique within its connection.';
comment on column trip_agent_actions.external_actor_digest is
  'Connection-and-lifecycle-scoped HMAC of the external actor identifier; never the raw provider identifier.';
comment on column trip_agent_actions.normalized_request is
  'Operation-specific structured JSON only. Envelope IDs, conversation text, and provider secrets must not be copied here.';
comment on column trip_agent_actions.preview is
  'Structured preview JSON tied to plan_fingerprint so later confirmation can recheck current state.';
comment on column trip_agent_actions.result is
  'Structured and redacted result JSON; provider conversation payloads and private trip fields are forbidden.';

create index trip_agent_actions_pending_confirmation
  on trip_agent_actions (connection_id, lifecycle_generation, confirmation_expires_at)
  where status = 'awaiting_confirmation';
create index trip_agent_actions_trip_history
  on trip_agent_actions (trip_id, created_at desc);
create index trip_agent_actions_unannounced_succeeded
  on trip_agent_actions (connection_id, lifecycle_generation, created_at)
  where status = 'succeeded' and announcement_status = 'pending';

create function validate_trip_agent_action_lifecycle()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_trip_id uuid;
  v_generation integer;
begin
  if tg_op = 'UPDATE' then
    if new.connection_id is distinct from old.connection_id
       or new.trip_id is distinct from old.trip_id
       or new.lifecycle_generation is distinct from old.lifecycle_generation then
      raise exception 'trip-agent action lifecycle scope is immutable';
    end if;
    return new;
  end if;

  select trip_id, lifecycle_generation into v_trip_id, v_generation
  from trip_agent_connections where id = new.connection_id;
  if v_trip_id is null or new.trip_id is distinct from v_trip_id then
    raise exception 'trip-agent action violates connection-trip foreign key';
  end if;
  if new.lifecycle_generation is distinct from v_generation then
    raise exception 'trip-agent action lifecycle is stale';
  end if;
  return new;
end;
$$;

create trigger trip_agent_actions_current_lifecycle
before insert or update of connection_id, trip_id, lifecycle_generation
on trip_agent_actions
for each row execute function validate_trip_agent_action_lifecycle();

-- Shared explicit safety state, used by the service's final locked guards.
create function trip_agent_item_state(p_item itinerary_items)
returns jsonb language sql immutable set search_path = public as $$
  select jsonb_build_object('id', p_item.id, 'dayIndex', p_item.day_index,
    'block', p_item.block, 'candidateId', p_item.candidate_id, 'status', p_item.status,
    'locked', p_item.is_locked, 'reservationStatus', p_item.reservation_status,
    'reservationAt', case when p_item.reservation_at is null then null else to_char(p_item.reservation_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
    'position', p_item.position);
$$;

create function trip_agent_change_state(p_trip_id uuid, p_change jsonb, p_selected_route text default null)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_item itinerary_items%rowtype;
  v_venue venue_candidates%rowtype;
  v_trip jsonb;
  v_destination jsonb;
  v_replacement jsonb := null;
  v_private jsonb := null;
  v_organizer travelers%rowtype;
  v_route text;
  v_booking_url text;
  v_maps_url text;
begin
  select jsonb_build_object('start_date', start_date, 'end_date', end_date) into v_trip from trips where id = p_trip_id;
  select * into v_item from itinerary_items where id = (p_change ->> 'itemId')::uuid and trip_id = p_trip_id;
  if not found then return null; end if;
  select * into v_venue from venue_candidates where id = v_item.candidate_id and trip_id = p_trip_id;
  if not found then return null; end if;
  select coalesce(jsonb_agg(trip_agent_item_state(i) order by i.id), '[]'::jsonb) into v_destination
  from itinerary_items i where i.trip_id = p_trip_id and i.id <> v_item.id and i.status = 'planned'
    and ((p_change ->> 'kind' = 'move' and i.day_index = (p_change ->> 'toDayIndex')::integer and i.block = p_change ->> 'toBlock')
      or (p_change ->> 'kind' = 'replace' and i.candidate_id = (p_change ->> 'replacementCandidateId')::uuid));
  if p_change ->> 'kind' = 'replace' then
    select jsonb_build_object('id', id, 'name', name) into v_replacement from venue_candidates
    where id = (p_change ->> 'replacementCandidateId')::uuid and trip_id = p_trip_id;
  end if;
  if p_change ->> 'kind' = 'reservation_prepare' then
    if (select count(*) from travelers where trip_id = p_trip_id and is_organizer and not is_bot) <> 1 then return null; end if;
    select * into v_organizer from travelers where trip_id = p_trip_id and is_organizer and not is_bot;
    v_booking_url := regexp_replace(v_item.booking_url, '^\s+|\s+$', '', 'g');
    v_maps_url := regexp_replace(v_venue.maps_url, '^\s+|\s+$', '', 'g');
    -- Full URL parsing belongs to the service. Bind its chosen route to both
    -- unchanged canonical inputs, so an invalid booking URL can safely fall
    -- back to Maps without a different SQL URL parser choosing another route.
    -- These fields are transient hash inputs, never action preview/result JSON.
    v_route := case when p_selected_route is not null then
      case when p_selected_route = v_booking_url or p_selected_route = v_maps_url then p_selected_route else null end
      when v_booking_url ~* '^https://[^/@[:space:]?#]+([/?#][^[:space:]]*)?$' then v_booking_url
      when v_maps_url ~* '^https://[^/@[:space:]?#]+([/?#][^[:space:]]*)?$' then v_maps_url else null end;
    v_private := jsonb_build_object('organizerId', v_organizer.id,
      'organizerName', regexp_replace(v_organizer.display_name, '^\s+|\s+$', '', 'g'),
      'route', v_route, 'bookingUrl', v_booking_url, 'mapsUrl', v_maps_url);
  end if;
  return jsonb_build_object('trip', v_trip, 'item', trip_agent_item_state(v_item), 'destination', v_destination,
    'venue', jsonb_build_object('id', v_venue.id, 'name', v_venue.name), 'replacement', v_replacement, 'privateReservation', v_private);
end;
$$;

-- Optional guarded overload: normal web callers retain their established
-- signature. Gateway callers must bind proposal creation to their preview.
create function create_plan_proposal(
  p_trip_id uuid, p_item_id uuid, p_proposed_by uuid, p_kind text,
  p_to_day_index integer, p_to_block text, p_note text,
  p_to_candidate_id uuid, p_expected_state jsonb
)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_state jsonb; v_change jsonb;
begin
  perform 1 from trips where id = p_trip_id for update;
  if not found then raise exception 'trip missing' using errcode = 'P0002'; end if;
  perform 1 from itinerary_items where trip_id = p_trip_id order by id for update;
  perform 1 from venue_candidates where trip_id = p_trip_id and id in (select candidate_id from itinerary_items where id = p_item_id)
    or (trip_id = p_trip_id and id = p_to_candidate_id) order by id for update;
  v_change := jsonb_build_object('kind', p_kind, 'itemId', p_item_id, 'toDayIndex', p_to_day_index, 'toBlock', p_to_block, 'replacementCandidateId', p_to_candidate_id);
  v_state := trip_agent_change_state(p_trip_id, v_change);
  if v_state -> 'item' ->> 'locked' = 'true' or v_state -> 'item' ->> 'reservationStatus' in ('tentative', 'confirmed') then
    raise exception 'reservation locked' using errcode = 'TP002'; end if;
  if jsonb_array_length(v_state -> 'destination') > 0 then
    raise exception 'destination occupied' using errcode = 'TP003'; end if;
  if p_expected_state is null or v_state is null or v_state is distinct from p_expected_state then
    raise exception 'preview safety changed' using errcode = 'TP001'; end if;
  return create_plan_proposal(p_trip_id, p_item_id, p_proposed_by, p_kind, p_to_day_index, p_to_block, p_note, p_to_candidate_id);
end;
$$;

create function create_suggestion_proposal(
  p_trip_id uuid, p_proposed_by uuid, p_suggestion_text text, p_expected_state jsonb
)
returns uuid language plpgsql security definer set search_path = public as $$
begin
  perform 1 from trips where id = p_trip_id for update;
  if not found then raise exception 'trip missing' using errcode = 'P0002'; end if;
  if exists (select 1 from plan_proposals where trip_id = p_trip_id and kind = 'suggest' and status = 'open'
    and lower(btrim(regexp_replace(suggestion_text, '\s+', ' ', 'g'))) = lower(btrim(regexp_replace(p_suggestion_text, '\s+', ' ', 'g')))) then
    raise exception 'matching suggestion exists' using errcode = 'TP004'; end if;
  if p_expected_state is distinct from jsonb_build_object('tripId', p_trip_id, 'matchingOpenSuggestions', '[]'::jsonb) then
    raise exception 'preview safety changed' using errcode = 'TP001'; end if;
  begin
    return create_suggestion_proposal(p_trip_id, p_proposed_by, p_suggestion_text);
  exception when unique_violation then
    raise exception 'matching suggestion exists' using errcode = 'TP004';
  end;
end;
$$;

create function finalize_trip_agent_preview(
  p_action_id uuid, p_connection_id uuid, p_trip_id uuid, p_actor_digest text,
  p_status text, p_preview jsonb, p_fingerprint text, p_error_code text
)
returns setof trip_agent_actions language plpgsql security definer set search_path = public as $$
declare v_now timestamptz; v_expiry timestamptz; v_generation integer;
begin
  if p_status not in ('previewed', 'refused', 'failed') or p_status is null then return; end if;
  select lifecycle_generation into v_generation from trip_agent_connections
    where id = p_connection_id and trip_id = p_trip_id
    for update;
  if not found then return; end if;
  perform 1 from trip_agent_actions
    where id = p_action_id and connection_id = p_connection_id and trip_id = p_trip_id
      and lifecycle_generation = v_generation
      and external_actor_digest = p_actor_digest and status = 'received' for update;
  if not found then return; end if;
  v_now := clock_timestamp();
  if p_status = 'previewed' then
    if p_preview is null or p_fingerprint is null then return; end if;
    v_expiry := v_now + interval '10 minutes';
    p_preview := jsonb_set(p_preview, '{expiresAt}', to_jsonb(to_char(v_expiry at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  end if;
  return query update trip_agent_actions
    set status = p_status, preview = p_preview, plan_fingerprint = p_fingerprint,
      confirmation_expires_at = v_expiry, error_code = p_error_code, updated_at = v_now
    where id = p_action_id and connection_id = p_connection_id and trip_id = p_trip_id
      and lifecycle_generation = v_generation
      and external_actor_digest = p_actor_digest and status = 'received'
    returning *;
end;
$$;

-- Application result writes share the lifecycle lock used by replacement.
-- This preserves connection -> action ordering and makes a stale authenticated
-- context a no-op instead of allowing it to mutate retained history.
create function write_trip_agent_action_state(
  p_connection_id uuid,
  p_trip_id uuid,
  p_lifecycle_generation integer,
  p_action_id uuid,
  p_actor_digest text,
  p_from_status text,
  p_patch jsonb
)
returns setof trip_agent_actions
language plpgsql
security definer
set search_path = public
as $$
declare
  v_action trip_agent_actions%rowtype;
begin
  if p_lifecycle_generation is null
     or p_lifecycle_generation <= 0
     or p_actor_digest is null
     or p_actor_digest !~ '^[0-9a-f]{64}$'
     or p_from_status is null
     or p_from_status not in ('received','previewed','executing','awaiting_vote','awaiting_confirmation','succeeded','rejected','cancelled','failed','unknown','refused','expired')
     or p_patch is null
     or jsonb_typeof(p_patch) <> 'object'
     or p_patch - 'status' - 'preview' - 'plan_fingerprint' - 'authority_decision'
       - 'confirmation_expires_at' - 'proposal_id' - 'canonical_reference'
       - 'result' - 'error_code' - 'executed_at' - 'updated_at' <> '{}'::jsonb
     or not (p_patch ?& array['status','updated_at'])
     or coalesce(p_patch->>'status','') not in ('received','previewed','executing','awaiting_vote','awaiting_confirmation','succeeded','rejected','cancelled','failed','unknown','refused','expired')
     or jsonb_typeof(p_patch->'updated_at') <> 'string'
     or (p_patch ? 'preview' and p_patch->'preview' <> 'null'::jsonb and jsonb_typeof(p_patch->'preview') <> 'object')
     or (p_patch ? 'result' and p_patch->'result' <> 'null'::jsonb and jsonb_typeof(p_patch->'result') <> 'object')
     or (p_patch ? 'authority_decision' and coalesce(p_patch->>'authority_decision','') not in ('allowed','requires_organizer_confirmation','denied'))
     or (p_patch ? 'canonical_reference' and p_patch->'canonical_reference' <> 'null'::jsonb
       and (jsonb_typeof(p_patch->'canonical_reference') <> 'object'
         or (p_patch->'canonical_reference') - 'kind' - 'id' <> '{}'::jsonb
         or p_patch#>>'{canonical_reference,kind}' <> 'plan_proposal'
         or (p_patch#>>'{canonical_reference,id}') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$')) then
    return;
  end if;

  perform 1 from trip_agent_connections
  where id = p_connection_id
    and trip_id = p_trip_id
    and lifecycle_generation = p_lifecycle_generation
  for update;
  if not found then return; end if;

  select * into v_action from trip_agent_actions
  where id = p_action_id
    and connection_id = p_connection_id
    and trip_id = p_trip_id
    and lifecycle_generation = p_lifecycle_generation
    and external_actor_digest = p_actor_digest
    and status = p_from_status
  for update;
  if not found then return; end if;

  return query update trip_agent_actions
  set status = p_patch->>'status',
      preview = case when p_patch ? 'preview' then nullif(p_patch->'preview', 'null'::jsonb) else v_action.preview end,
      plan_fingerprint = case when p_patch ? 'plan_fingerprint' then p_patch->>'plan_fingerprint' else v_action.plan_fingerprint end,
      authority_decision = case when p_patch ? 'authority_decision' then p_patch->>'authority_decision' else v_action.authority_decision end,
      confirmation_expires_at = case when p_patch ? 'confirmation_expires_at' then (p_patch->>'confirmation_expires_at')::timestamptz else v_action.confirmation_expires_at end,
      proposal_id = case when p_patch ? 'proposal_id' then (p_patch->>'proposal_id')::uuid else v_action.proposal_id end,
      canonical_reference = case when p_patch ? 'canonical_reference' then nullif(p_patch->'canonical_reference', 'null'::jsonb) else v_action.canonical_reference end,
      result = case when p_patch ? 'result' then nullif(p_patch->'result', 'null'::jsonb) else v_action.result end,
      error_code = case when p_patch ? 'error_code' then p_patch->>'error_code' else v_action.error_code end,
      executed_at = case when p_patch ? 'executed_at' then (p_patch->>'executed_at')::timestamptz else v_action.executed_at end,
      updated_at = (p_patch->>'updated_at')::timestamptz
  where id = v_action.id
    and lifecycle_generation = p_lifecycle_generation
    and status = p_from_status
  returning *;
end;
$$;

-- The service re-reads and fingerprints current safety facts before claiming.
-- Claim is the at-most-once boundary: execution is never automatically retried
-- after this transaction. Core proposal RPCs retain the final itinerary locks.
create function claim_trip_agent_action(
  p_action_id uuid,
  p_connection_id uuid,
  p_trip_id uuid,
  p_actor_digest text,
  p_group_digest text,
  p_expected_fingerprint text,
  p_now timestamptz,
  p_expected_is_organizer boolean,
  p_expected_state jsonb
)
returns table (action jsonb, is_organizer boolean, authority_policy jsonb)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection trip_agent_connections%rowtype;
  v_mapping trip_agent_participant_mappings%rowtype;
  v_traveler travelers%rowtype;
  v_action trip_agent_actions%rowtype;
  v_kind text;
  v_scope text;
  v_now timestamptz;
begin
  if p_now is null or p_expected_fingerprint is null
     or p_actor_digest is null or p_group_digest is null
     or p_expected_is_organizer is null or p_expected_state is null then return; end if;

  -- Connection -> mapping -> trip -> traveler, consistent with settlement.
  select * into v_connection from trip_agent_connections
  where id = p_connection_id and trip_id = p_trip_id for update;
  if not found or v_connection.status <> 'active'
     or v_connection.whatsapp_group_digest is distinct from p_group_digest then return; end if;

  select * into v_mapping from trip_agent_participant_mappings
  where connection_id = p_connection_id and trip_id = p_trip_id
    and lifecycle_generation = v_connection.lifecycle_generation
    and external_participant_digest = p_actor_digest for update;
  if not found or v_mapping.status <> 'confirmed' then return; end if;

  perform 1 from trips where id = p_trip_id for update;
  if not found then return; end if;
  select * into v_traveler from travelers
  where id = v_mapping.traveler_id and trip_id = p_trip_id for no key update;
  -- Role/name updates remain blocked, while the KEY SHARE acquired by a
  -- proposal's traveler foreign key stays compatible. FOR UPDATE here would
  -- invert legacy proposal creation's trip -> traveler FK lock order.
  if not found or v_traveler.is_bot is not false
     or v_traveler.is_organizer is distinct from p_expected_is_organizer then return; end if;

  select * into v_action from trip_agent_actions
  where id = p_action_id and connection_id = p_connection_id and trip_id = p_trip_id
    and lifecycle_generation = v_connection.lifecycle_generation
    and external_actor_digest = p_actor_digest for update;
  v_now := clock_timestamp();
  if not found or v_action.status <> 'previewed'
     or v_action.operation <> 'preview_change'
     or v_action.mapped_traveler_id is distinct from v_traveler.id
     or v_action.confirmation_expires_at is null
     or v_action.plan_fingerprint is distinct from p_expected_fingerprint then return; end if;

  v_kind := v_action.normalized_request ->> 'kind';
  if v_kind is null or v_kind not in ('move', 'remove', 'replace', 'suggest', 'reservation_prepare') then return; end if;
  v_scope := case when v_traveler.is_organizer and v_kind <> 'suggest' then 'trip.modify' else 'trip.propose' end;
  if not (v_scope = any(v_connection.granted_scopes)) then return; end if;
  if not v_traveler.is_organizer and v_kind <> 'reservation_prepare' then
    if v_kind = 'suggest' and (v_connection.authority_policy ->> 'travelerCanAddSuggestion')::boolean is not true then return; end if;
    if v_kind <> 'suggest' and (v_connection.authority_policy ->> 'travelerCanProposeChange')::boolean is not true then return; end if;
  end if;
  v_now := clock_timestamp();
  if v_kind = 'reservation_prepare' and v_action.confirmation_expires_at > v_now then
    perform 1 from trips where id = p_trip_id for update;
    perform 1 from itinerary_items where trip_id = p_trip_id and id = (v_action.normalized_request ->> 'itemId')::uuid for update;
    perform 1 from venue_candidates where trip_id = p_trip_id and id in
      (select candidate_id from itinerary_items where id = (v_action.normalized_request ->> 'itemId')::uuid) for update;
    perform 1 from travelers t where t.trip_id = p_trip_id and t.is_organizer and not t.is_bot order by t.id for no key update;
    -- An expiry reached while waiting for locks is the durable outcome even
    -- if plan state also changed during that wait.
    if v_action.confirmation_expires_at > clock_timestamp() then
      if trip_agent_change_state(p_trip_id, v_action.normalized_request, p_expected_state #>> '{privateReservation,route}') is distinct from p_expected_state then
        raise exception 'reservation preview changed' using errcode = 'TP001'; end if;
    end if;
  end if;
  -- Locks may have waited. Expiry and the new confirmation clock are evaluated
  -- at the actual transition, after every relevant row has been locked.
  v_now := clock_timestamp();
  update trip_agent_actions
  set status = case when v_action.confirmation_expires_at <= v_now then 'expired' else 'executing' end,
    error_code = case when v_action.confirmation_expires_at <= v_now then 'preview_expired' else null end,
    result = case when v_action.confirmation_expires_at <= v_now then jsonb_build_object('status', 'expired') else null end,
    updated_at = v_now,
    confirmation_expires_at = case when v_action.confirmation_expires_at > v_now and v_kind = 'reservation_prepare' then v_now + interval '15 minutes' else null end
  where id = v_action.id and lifecycle_generation = v_connection.lifecycle_generation
    and status = 'previewed' returning * into v_action;
  return query select to_jsonb(v_action), v_traveler.is_organizer, v_connection.authority_policy;
end;
$$;

-- Acquire each row physically in canonical order, including bots: a bot can
-- become human, and a former human's historical vote must not count.
-- Trip FOR UPDATE blocks joining travelers through their trip foreign key.
create function lock_plan_proposal_settlement(p_proposal_id uuid)
returns plan_proposals language plpgsql security definer set search_path=public as $$
declare v_trip_id uuid; v_id uuid; v_proposal plan_proposals;
begin
  select trip_id into v_trip_id from plan_proposals where id=p_proposal_id;
  if not found then raise exception 'proposal missing' using errcode='TP007'; end if;
  perform 1 from trips where id=v_trip_id for update;
  if not found then raise exception 'trip missing' using errcode='TP007'; end if;
  for v_id in select id from travelers where trip_id=v_trip_id order by id loop
    perform 1 from travelers where id=v_id and trip_id=v_trip_id for no key update;
  end loop;
  select * into v_proposal from plan_proposals where id=p_proposal_id for update;
  if not found or v_proposal.trip_id is distinct from v_trip_id then
    raise exception 'proposal changed' using errcode='TP008'; end if;
  if v_proposal.status <> 'open' then raise exception 'already decided' using errcode='TP005'; end if;
  for v_id in select traveler_id from plan_proposal_votes where proposal_id=p_proposal_id order by traveler_id loop
    perform 1 from plan_proposal_votes where proposal_id=p_proposal_id and traveler_id=v_id for update;
  end loop;
  return v_proposal;
end;
$$;

-- SQL verifies the pure TypeScript policy result; it does not choose a verdict.
create function validate_plan_proposal_settlement(p_proposal_id uuid,p_actor_id uuid,p_force text,p_settlement jsonb)
returns void language plpgsql security definer set search_path=public as $$
declare v_proposal plan_proposals; v_key text; v_yes integer; v_no integer;
  v_count integer; v_needed integer; v_status text; v_reason text;
begin
  v_proposal := lock_plan_proposal_settlement(p_proposal_id);
  if not exists(select 1 from travelers where id=p_actor_id and trip_id=v_proposal.trip_id and not is_bot
    and (p_force is null or is_organizer)) or (p_force is not null and p_force not in ('approve','reject')) then
    raise exception 'authority changed' using errcode='TP006'; end if;
  if p_settlement is null or jsonb_typeof(p_settlement)<>'object'
    or p_settlement - 'status' - 'reasonCode' - 'yes' - 'no' - 'needed' - 'travelerCount' <> '{}'::jsonb then
    raise exception 'invalid settlement' using errcode='TP008'; end if;
  foreach v_key in array array['yes','no','needed','travelerCount'] loop
    if coalesce(jsonb_typeof(p_settlement->v_key),'')<>'number' or (p_settlement->>v_key) !~ '^[0-9]+$'
      or (p_settlement->>v_key)::numeric > 1000000 then raise exception 'invalid tally' using errcode='TP008'; end if;
  end loop;
  select count(*) into v_count from travelers where trip_id=v_proposal.trip_id and not is_bot;
  select count(*) filter(where v.value=1),count(*) filter(where v.value=-1) into v_yes,v_no
    from plan_proposal_votes v join travelers t on t.id=v.traveler_id
    where v.proposal_id=p_proposal_id and t.trip_id=v_proposal.trip_id and not t.is_bot;
  v_needed := v_count / 2 + 1;
  v_status := coalesce(p_settlement->>'status','');
  v_reason := coalesce(p_settlement->>'reasonCode','');
  if (p_settlement->>'yes')::integer<>v_yes or (p_settlement->>'no')::integer<>v_no
    or (p_settlement->>'needed')::integer<>v_needed or (p_settlement->>'travelerCount')::integer<>v_count
    or not coalesce(((v_status='open' and v_reason='awaiting_vote' and p_force is null and v_yes<v_needed and v_no<v_needed)
      or (v_status='applied' and v_reason='approved' and (p_force='approve' or (p_force is null and v_yes>=v_needed)))
      or (v_status='rejected' and v_reason='rejected' and (p_force='reject' or (p_force is null and v_no>=v_needed)))
      or (v_status='cancelled' and v_reason in ('proposal_stale','reservation_locked','destination_occupied'))),false) then
    raise exception 'settlement drift' using errcode='TP008'; end if;
end;
$$;

-- Legacy finalizers must obtain the same trip-first locks before suggestion
-- inserts acquire trip/traveler FK locks. This replaces proposal-first locking.
create or replace function apply_plan_proposal(p_proposal_id uuid,p_actor_id uuid,p_resolution text)
returns void language plpgsql security definer set search_path=public as $$
declare v_proposal plan_proposals;
begin
  v_proposal := lock_plan_proposal_settlement(p_proposal_id);
  if v_proposal.kind='suggest' then
    insert into trip_suggestions (trip_id, traveler_id, text)
    values(v_proposal.trip_id,v_proposal.proposed_by,v_proposal.suggestion_text);
  else
    perform assert_proposal_still_valid(v_proposal);
    if v_proposal.kind='move' then
      update itinerary_items set day_index=v_proposal.to_day_index,block=v_proposal.to_block,updated_at=now()
      where id=v_proposal.item_id and trip_id=v_proposal.trip_id;
    elsif v_proposal.kind='replace' then
      update itinerary_items item set candidate_id=v_proposal.to_candidate_id,area=candidate.area,
        why_note=coalesce(v_proposal.note,item.why_note),updated_at=now()
      from venue_candidates candidate where item.id=v_proposal.item_id and item.trip_id=v_proposal.trip_id
        and candidate.id=v_proposal.to_candidate_id;
    else
      update itinerary_items set status='skipped',is_locked=false,reservation_auto_locked=false,
        completed_at=null,completed_day_index=null,state_changed_by=p_actor_id,updated_at=now()
      where id=v_proposal.item_id and trip_id=v_proposal.trip_id;
    end if;
  end if;
  update plan_proposals set status='applied',resolution=p_resolution,decided_by=p_actor_id,decided_at=now() where id=p_proposal_id;
end;
$$;

create or replace function close_plan_proposal(p_proposal_id uuid,p_actor_id uuid,p_status text,p_resolution text)
returns void language plpgsql security definer set search_path=public as $$
begin
  perform lock_plan_proposal_settlement(p_proposal_id);
  if p_status is null or p_status not in ('rejected','cancelled') then raise exception 'invalid status' using errcode='23514'; end if;
  update plan_proposals set status=p_status,resolution=p_resolution,decided_by=p_actor_id,decided_at=now() where id=p_proposal_id;
end;
$$;

create function settle_plan_proposal_guarded(p_proposal_id uuid,p_actor_id uuid,p_force text,p_resolution text,p_settlement jsonb)
returns void language plpgsql security definer set search_path=public as $$
begin
  perform validate_plan_proposal_settlement(p_proposal_id,p_actor_id,p_force,p_settlement);
  if p_settlement->>'status'='applied' then
    perform apply_plan_proposal(p_proposal_id,p_actor_id,p_resolution);
  elsif p_settlement->>'status' in ('rejected','cancelled') then
    perform close_plan_proposal(p_proposal_id,p_actor_id,p_settlement->>'status',p_resolution);
  end if;
end;
$$;

create or replace function read_proposal_tally(p_proposal_id uuid)
returns json language sql stable security definer set search_path=public as $$
  select json_build_object('votes',coalesce((select json_agg(json_build_object('traveler_id',v.traveler_id,'value',v.value))
    from plan_proposal_votes v join travelers t on t.id=v.traveler_id join plan_proposals p on p.id=v.proposal_id
    where v.proposal_id=p_proposal_id and t.trip_id=p.trip_id and not t.is_bot),'[]'::json),
    'traveler_count',(select count(*) from travelers t join plan_proposals p on p.id=p_proposal_id
      where t.trip_id=p.trip_id and not t.is_bot));
$$;

revoke all on function lock_plan_proposal_settlement(uuid),validate_plan_proposal_settlement(uuid,uuid,text,jsonb),settle_plan_proposal_guarded(uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function lock_plan_proposal_settlement(uuid),validate_plan_proposal_settlement(uuid,uuid,text,jsonb),settle_plan_proposal_guarded(uuid,uuid,text,text,jsonb) to service_role;

-- Both preparation and final settlement use the same current authority guard.
-- A command belongs to its actor, but its referenced preview may belong to any
-- confirmed group member. All references are constrained to the connection/trip.
create function lock_trip_agent_proposal_action(
  p_action_id uuid, p_connection_id uuid, p_trip_id uuid,
  p_actor_digest text, p_group_digest text, p_phase text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_connection trip_agent_connections%rowtype;
  v_action trip_agent_actions%rowtype;
  v_target trip_agent_actions%rowtype;
  v_mapping trip_agent_participant_mappings%rowtype;
  v_traveler travelers%rowtype;
  v_proposal plan_proposals%rowtype;
begin
  select * into v_connection from trip_agent_connections
    where id=p_connection_id and trip_id=p_trip_id for update;
  if not found or v_connection.status <> 'active'
    or v_connection.whatsapp_group_digest is distinct from p_group_digest
    or p_group_digest is null or not ('trip.vote'=any(v_connection.granted_scopes)) then
    raise exception 'authority changed' using errcode='TP006'; end if;
  select * into v_action from trip_agent_actions where id=p_action_id
    and connection_id=p_connection_id and trip_id=p_trip_id
    and lifecycle_generation=v_connection.lifecycle_generation
    and external_actor_digest=p_actor_digest;
  if not found or v_action.operation not in ('vote','decide') then
    raise exception 'action missing' using errcode='TP007'; end if;
  if v_action.authority_decision<>'allowed' then raise exception 'authority changed' using errcode='TP006'; end if;
  if (v_action.operation='vote' and (v_action.normalized_request - 'actionId' - 'vote' <> '{}'::jsonb
      or coalesce(v_action.normalized_request->>'vote','') not in ('up','down')))
    or (v_action.operation='decide' and (v_action.normalized_request - 'actionId' - 'decision' <> '{}'::jsonb
      or coalesce(v_action.normalized_request->>'decision','') not in ('approve','reject')))
    or not (v_action.normalized_request ? 'actionId') then
    raise exception 'invalid command' using errcode='TP007'; end if;
  select * into v_target from trip_agent_actions where id=(v_action.normalized_request->>'actionId')::uuid
    and connection_id=p_connection_id and trip_id=p_trip_id
    and lifecycle_generation=v_connection.lifecycle_generation for update;
  if not found or v_target.operation <> 'preview_change' or v_target.proposal_id is null
    or v_target.canonical_reference is distinct from jsonb_build_object('kind','plan_proposal','id',v_target.proposal_id) then
    raise exception 'target missing' using errcode='TP007'; end if;
  select * into v_mapping from trip_agent_participant_mappings where connection_id=p_connection_id
    and trip_id=p_trip_id and lifecycle_generation=v_connection.lifecycle_generation
    and external_participant_digest=p_actor_digest for update;
  if not found or v_mapping.status <> 'confirmed' then
    raise exception 'authority changed' using errcode='TP006'; end if;
  v_proposal := lock_plan_proposal_settlement(v_target.proposal_id);
  if v_proposal.trip_id is distinct from p_trip_id then raise exception 'target changed' using errcode='TP007'; end if;
  select * into v_traveler from travelers where id=v_mapping.traveler_id and trip_id=p_trip_id for no key update;
  if not found or v_traveler.is_bot is not false or v_traveler.id is distinct from v_action.mapped_traveler_id
    or (v_action.operation='decide' and v_traveler.is_organizer is not true) then
    raise exception 'authority changed' using errcode='TP006'; end if;
  select * into v_action from trip_agent_actions where id=p_action_id and connection_id=p_connection_id
    and trip_id=p_trip_id and lifecycle_generation=v_connection.lifecycle_generation
    and external_actor_digest=p_actor_digest for update;
  if v_action.status is distinct from p_phase then return jsonb_build_object('action',to_jsonb(v_action)); end if;
  if p_phase='executing' and v_action.proposal_id is distinct from v_target.proposal_id then
    raise exception 'target changed' using errcode='TP007'; end if;
  return jsonb_build_object('action',to_jsonb(v_action),'proposal',to_jsonb(v_proposal));
end;
$$;

create function prepare_trip_agent_proposal_action(
  p_action_id uuid, p_connection_id uuid, p_trip_id uuid, p_actor_digest text, p_group_digest text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_locked jsonb; v_action trip_agent_actions%rowtype; v_proposal_id uuid;
begin
  v_locked := lock_trip_agent_proposal_action(p_action_id,p_connection_id,p_trip_id,p_actor_digest,p_group_digest,'received');
  if not (v_locked ? 'proposal') then return v_locked; end if;
  v_action := jsonb_populate_record(null::trip_agent_actions,v_locked->'action');
  v_proposal_id := (v_locked#>>'{proposal,id}')::uuid;
  if v_action.operation='vote' then
    insert into plan_proposal_votes(proposal_id,traveler_id,value)
      values(v_proposal_id,v_action.mapped_traveler_id,case when v_action.normalized_request->>'vote'='up' then 1 else -1 end)
      on conflict(proposal_id,traveler_id) do update set value=excluded.value;
  end if;
  update trip_agent_actions set status='executing',proposal_id=v_proposal_id,
    canonical_reference=jsonb_build_object('kind','plan_proposal','id',v_proposal_id),updated_at=clock_timestamp()
    where id=v_action.id and lifecycle_generation=v_action.lifecycle_generation
      and status='received' returning * into v_action;
  return jsonb_build_object('action',to_jsonb(v_action),'proposal',v_locked->'proposal');
end;
$$;

-- TypeScript settleProposal owns the arithmetic/staleness verdict. Under the
-- final locks, recheck authority and canonical guards, and save exactly that
-- verdict in the SAME transaction as apply/close. Lost responses are reread.
create function settle_trip_agent_proposal_action(
  p_action_id uuid, p_connection_id uuid, p_trip_id uuid, p_actor_digest text, p_group_digest text,
  p_proposal_id uuid, p_actor_id uuid, p_force text, p_resolution text, p_settlement jsonb
)
returns void language plpgsql security definer set search_path = public as $$
declare v_locked jsonb; v_action trip_agent_actions%rowtype; v_status text;
begin
  v_locked := lock_trip_agent_proposal_action(p_action_id,p_connection_id,p_trip_id,p_actor_digest,p_group_digest,'executing');
  if not (v_locked ? 'proposal') then raise exception 'already decided' using errcode='TP005'; end if;
  v_action := jsonb_populate_record(null::trip_agent_actions,v_locked->'action');
  if p_proposal_id is distinct from v_action.proposal_id or p_actor_id is distinct from v_action.mapped_traveler_id
    or (v_action.operation='decide' and p_force is distinct from v_action.normalized_request->>'decision')
    or (v_action.operation='vote' and p_force is not null) then
    raise exception 'authority changed' using errcode='TP006'; end if;
  perform settle_plan_proposal_guarded(p_proposal_id,p_actor_id,p_force,p_resolution,p_settlement);
  v_status := case p_settlement->>'status' when 'open' then 'awaiting_vote' when 'applied' then 'succeeded' else p_settlement->>'status' end;
  update trip_agent_actions set status=v_status,
    result=jsonb_build_object('status',v_status,'proposalId',p_proposal_id,'settlement',p_settlement),
    error_code=null,confirmation_expires_at=null,executed_at=clock_timestamp(),updated_at=clock_timestamp()
    where id=p_action_id and lifecycle_generation=v_action.lifecycle_generation
      and status='executing';
end;
$$;

revoke all on function lock_trip_agent_proposal_action(uuid,uuid,uuid,text,text,text) from public,anon,authenticated;
revoke all on function prepare_trip_agent_proposal_action(uuid,uuid,uuid,text,text) from public,anon,authenticated;
revoke all on function settle_trip_agent_proposal_action(uuid,uuid,uuid,text,text,uuid,uuid,text,text,jsonb) from public,anon,authenticated;
grant execute on function lock_trip_agent_proposal_action(uuid,uuid,uuid,text,text,text) to service_role;
grant execute on function prepare_trip_agent_proposal_action(uuid,uuid,uuid,text,text) to service_role;
grant execute on function settle_trip_agent_proposal_action(uuid,uuid,uuid,text,text,uuid,uuid,text,text,jsonb) to service_role;

-- Private organizer confirmation creates a draft only. There is no provider
-- call, booking, payment, or contact disclosure in this transaction.
create function confirm_trip_agent_action(
  p_action_id uuid, p_trip_id uuid, p_actor_id uuid, p_decision text,
  p_expected_fingerprint text, p_expected_state jsonb, p_snapshot_error text
)
returns jsonb language plpgsql security definer set search_path = public as $$
declare
  v_connection_id uuid;
  v_connection trip_agent_connections%rowtype;
  v_action trip_agent_actions%rowtype;
  v_organizer travelers%rowtype;
  v_item itinerary_items%rowtype;
  v_venue venue_candidates%rowtype;
  v_attempt_id uuid;
  v_name text;
  v_route text;
  v_now timestamptz;
  v_result jsonb;
begin
  if p_decision is null or p_decision not in ('confirm','reject') then return jsonb_build_object('code','invalid_input'); end if;
  select action_row.connection_id into v_connection_id
  from trip_agent_actions as action_row
  join trip_agent_connections as connection_row
    on connection_row.id = action_row.connection_id
   and connection_row.trip_id = action_row.trip_id
   and connection_row.lifecycle_generation = action_row.lifecycle_generation
  where action_row.id=p_action_id and action_row.trip_id=p_trip_id;
  if not found then return jsonb_build_object('code','action_not_found'); end if;
  select * into v_connection from trip_agent_connections where id=v_connection_id and trip_id=p_trip_id for update;
  if not found or v_connection.status<>'active' then return jsonb_build_object('code','connection_unavailable'); end if;
  select * into v_action from trip_agent_actions where id=p_action_id and trip_id=p_trip_id
    and connection_id=v_connection.id and lifecycle_generation=v_connection.lifecycle_generation for update;
  if not found then return jsonb_build_object('code','action_not_found'); end if;
  perform 1 from trips where id=p_trip_id for update;
  if not found then return jsonb_build_object('code','action_not_found'); end if;
  select * into v_organizer from travelers where id=p_actor_id and trip_id=p_trip_id for no key update;
  if not found or v_organizer.is_organizer is not true or v_organizer.is_bot is not false then
    return jsonb_build_object('code','organizer_required'); end if;
  if v_action.status<>'awaiting_confirmation' then return jsonb_build_object('code','confirmation_used'); end if;
  if v_action.operation<>'preview_change' or v_action.normalized_request->>'kind' is distinct from 'reservation_prepare'
    or v_action.authority_decision<>'requires_organizer_confirmation' then return jsonb_build_object('code','action_not_confirmable'); end if;
  if not ('trip.modify'=any(v_connection.granted_scopes)) then return jsonb_build_object('code','missing_scope'); end if;
  -- Reject never gets to bypass an expired challenge. Expiry is a durable
  -- transition, returned as data so PostgreSQL does not roll it back.
  v_now := clock_timestamp();
  if v_action.confirmation_expires_at is null or v_action.confirmation_expires_at<=v_now then
    update trip_agent_actions set status='expired',error_code='confirmation_expired',confirmation_expires_at=null,
      result=jsonb_build_object('action',jsonb_build_object('id',id,'status','expired')),updated_at=v_now
      where id=v_action.id and lifecycle_generation=v_connection.lifecycle_generation;
    return jsonb_build_object('code','confirmation_expired');
  end if;
  if p_decision='reject' then
    v_result:=jsonb_build_object('action',jsonb_build_object('id',v_action.id,'status','rejected'));
    update trip_agent_actions set status='rejected',result=v_result,error_code=null,confirmation_expires_at=null,updated_at=v_now
      where id=v_action.id and lifecycle_generation=v_connection.lifecycle_generation;
    return v_result;
  end if;
  if p_snapshot_error is not null then
    return jsonb_build_object('code',case when p_snapshot_error in ('booking_route_unavailable','organizer_unavailable','proposal_stale','reservation_locked','plan_changed') then p_snapshot_error else 'database_unavailable' end);
  end if;
  if v_action.normalized_request - 'kind' - 'itemId' - 'partySize' - 'requestedAt' <> '{}'::jsonb
    or not (v_action.normalized_request ?& array['itemId','partySize','requestedAt'])
    or jsonb_typeof(v_action.normalized_request->'partySize')<>'number'
    or (v_action.normalized_request->>'partySize') !~ '^[0-9]+$'
    or (v_action.normalized_request->>'partySize')::numeric not between 1 and 30 then
    return jsonb_build_object('code','action_not_confirmable'); end if;
  select * into v_item from itinerary_items where id=(v_action.normalized_request->>'itemId')::uuid and trip_id=p_trip_id for update;
  if not found then return jsonb_build_object('code','proposal_stale'); end if;
  select * into v_venue from venue_candidates where id=v_item.candidate_id and trip_id=p_trip_id for update;
  if not found then return jsonb_build_object('code','proposal_stale'); end if;
  -- Locks may have waited across the deadline; re-evaluate before any insert.
  v_now:=clock_timestamp();
  if v_action.confirmation_expires_at<=v_now then
    update trip_agent_actions set status='expired',error_code='confirmation_expired',confirmation_expires_at=null,
      result=jsonb_build_object('action',jsonb_build_object('id',id,'status','expired')),updated_at=v_now
      where id=v_action.id and lifecycle_generation=v_connection.lifecycle_generation;
    return jsonb_build_object('code','confirmation_expired'); end if;
  if v_item.status<>'planned' then return jsonb_build_object('code','proposal_stale'); end if;
  if v_item.is_locked or v_item.reservation_status in ('tentative','confirmed') then return jsonb_build_object('code','reservation_locked'); end if;
  v_name:=regexp_replace(v_organizer.display_name,'^\s+|\s+$','','g');
  if char_length(v_name) not between 1 and 120 then return jsonb_build_object('code','organizer_unavailable'); end if;
  -- The service parses canonical URLs, prefers valid booking_url, and binds
  -- both source strings plus the chosen route into the private fingerprint.
  v_route:=p_expected_state#>>'{privateReservation,route}';
  if v_route is null or v_route !~* '^https://' then return jsonb_build_object('code','booking_route_unavailable'); end if;
  if p_expected_fingerprint is null or p_expected_fingerprint is distinct from v_action.plan_fingerprint
    or p_expected_state is null or trip_agent_change_state(p_trip_id,v_action.normalized_request,v_route) is distinct from p_expected_state then
    return jsonb_build_object('code','plan_changed'); end if;
  begin
    insert into reservation_attempts(trip_id,itinerary_item_id,created_by,state,party_size,requested_at,
      booking_name,contact_email,contact_phone,alternatives,routes,route_index)
    values(p_trip_id,v_item.id,v_organizer.id,'awaiting_approval',(v_action.normalized_request->>'partySize')::integer,
      (v_action.normalized_request->>'requestedAt')::timestamptz,v_name,null,null,'[]'::jsonb,jsonb_build_array(v_route),0)
    returning id into v_attempt_id;
  exception when unique_violation then
    -- A manual flow or another challenge owns the active draft. Do not adopt
    -- it, consume this challenge, or abort the outer transaction.
    return jsonb_build_object('code','reservation_attempt_active');
  end;
  v_result:=jsonb_build_object('action',jsonb_build_object('id',v_action.id,'status','succeeded'),
    'attempt',jsonb_build_object('id',v_attempt_id,'state','awaiting_approval'),
    'item',jsonb_build_object('id',v_item.id,'venueName',v_venue.name));
  update trip_agent_actions set status='succeeded',result=v_result,
    canonical_reference=jsonb_build_object('kind','reservation_attempt','id',v_attempt_id),
    confirmation_expires_at=null,error_code=null,executed_at=v_now,updated_at=v_now
    where id=v_action.id and lifecycle_generation=v_connection.lifecycle_generation
      and status='awaiting_confirmation';
  return v_result;
end;
$$;
revoke all on function confirm_trip_agent_action(uuid,uuid,uuid,text,text,jsonb,text) from public,anon,authenticated;
grant execute on function confirm_trip_agent_action(uuid,uuid,uuid,text,text,jsonb,text) to service_role;

create table trip_agent_rate_windows (
  connection_id uuid not null references trip_agent_connections(id) on delete cascade,
  bucket text not null check (bucket in ('setup', 'read', 'mutation')),
  window_started_at timestamptz not null
    check (window_started_at = date_trunc('minute', window_started_at)),
  request_count integer not null default 0 check (request_count >= 0),
  updated_at timestamptz not null default now(),
  primary key (connection_id, bucket, window_started_at)
);


create function consume_trip_agent_rate_limit(
  p_connection uuid,
  p_bucket text,
  p_limit integer,
  p_now timestamptz
)
returns table (allowed boolean, count integer, retry_after integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_window_started_at timestamptz;
  v_count integer;
begin
  if p_bucket not in ('setup', 'read', 'mutation') then
    raise exception 'invalid trip-agent rate bucket';
  end if;
  if p_limit <= 0 then
    raise exception 'trip-agent rate limit must be positive';
  end if;

  v_window_started_at := date_trunc('minute', p_now);

  insert into trip_agent_rate_windows (
    connection_id,
    bucket,
    window_started_at,
    request_count,
    updated_at
  ) values (
    p_connection,
    p_bucket,
    v_window_started_at,
    1,
    p_now
  )
  on conflict (connection_id, bucket, window_started_at)
  do update set
    request_count = trip_agent_rate_windows.request_count + 1,
    updated_at = excluded.updated_at
  returning request_count into v_count;

  allowed := v_count <= p_limit;
  count := v_count;
  retry_after := greatest(
    0,
    ceil(extract(epoch from (v_window_started_at + interval '1 minute' - p_now)))::integer
  );
  return next;
end;
$$;

create function consume_trip_agent_pairing(
  p_pairing_digest text,
  p_provider text,
  p_credential_digest text,
  p_now timestamptz
)
returns table (connection_id uuid, trip_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection trip_agent_connections%rowtype;
begin
  select * into v_connection
  from trip_agent_connections
  where pairing_code_digest = p_pairing_digest
  for update;

  if not found
     or v_connection.status <> 'pending'
     or v_connection.provider <> p_provider
     or v_connection.pairing_expires_at <= p_now then
    raise exception 'invalid, expired, or used trip-agent pairing code';
  end if;

  update trip_agent_connections
  set status = 'paired',
      credential_digest = p_credential_digest,
      pairing_code_digest = null,
      pairing_expires_at = null,
      paired_at = p_now,
      updated_at = greatest(p_now, v_connection.updated_at + interval '1 microsecond')
  where id = v_connection.id;

  return query select v_connection.id, v_connection.trip_id;
end;
$$;

-- Rotation changes the bearer credential and its audit history together. The
-- observed update timestamp makes a stale organizer request a no-op instead of
-- letting it overwrite a newer rotation or lifecycle transition.
create function rotate_trip_agent_credential(
  p_connection_id uuid,
  p_expected_updated_at timestamptz,
  p_credential_digest text,
  p_actor_id uuid,
  p_now timestamptz
)
returns table (
  id uuid,
  trip_id uuid,
  provider text,
  status text,
  lifecycle_generation integer,
  pairing_expires_at timestamptz,
  granted_scopes text[],
  authority_policy jsonb,
  agent_phone_e164 text,
  whatsapp_group_label text,
  last_seen_at timestamptz,
  paired_at timestamptz,
  activated_at timestamptz,
  paused_at timestamptz,
  revoked_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection trip_agent_connections%rowtype;
  v_actor travelers%rowtype;
begin
  select * into v_connection
  from trip_agent_connections as connection_row
  where connection_row.id = p_connection_id
    and connection_row.updated_at = p_expected_updated_at
    and connection_row.status in ('paired', 'active', 'paused')
  for update;

  if not found then
    return;
  end if;

  perform 1 from trips as locked_trip where locked_trip.id = v_connection.trip_id for update;
  if not found then return; end if;
  select * into v_actor from travelers as actor_row
  where actor_row.id = p_actor_id and actor_row.trip_id = v_connection.trip_id
  for update;
  if not found then
    return;
  end if;
  if v_actor.is_organizer is not true or v_actor.is_bot is not false then
    return;
  end if;

  update trip_agent_connections
  set credential_digest = p_credential_digest,
      updated_at = greatest(p_now, v_connection.updated_at + interval '1 microsecond')
  where trip_agent_connections.id = v_connection.id
  returning * into v_connection;

  insert into trip_events (trip_id, actor_id, kind, detail)
  values (
    v_connection.trip_id,
    p_actor_id,
    'trip_agent_credential_rotated',
    jsonb_build_object(
      'connectionId', v_connection.id,
      'provider', v_connection.provider,
      'lifecycleStatus', v_connection.status
    )
  );

  return query select
    v_connection.id,
    v_connection.trip_id,
    v_connection.provider,
    v_connection.status,
    v_connection.lifecycle_generation,
    v_connection.pairing_expires_at,
    v_connection.granted_scopes,
    v_connection.authority_policy,
    v_connection.agent_phone_e164,
    v_connection.whatsapp_group_label,
    v_connection.last_seen_at,
    v_connection.paired_at,
    v_connection.activated_at,
    v_connection.paused_at,
    v_connection.revoked_at,
    v_connection.archived_at,
    v_connection.created_at,
    v_connection.updated_at;
end;
$$;

-- A terminal connector may be replaced without deleting its action or mapping
-- history. The generation is the hard identity/idempotency boundary: all
-- connector-owned metadata is cleared while historical rows remain immutable.
create function replace_trip_agent_connection(
  p_connection_id uuid,
  p_expected_updated_at timestamptz,
  p_provider text,
  p_pairing_digest text,
  p_pairing_expires_at timestamptz,
  p_actor_id uuid,
  p_now timestamptz
)
returns table (
  id uuid,
  trip_id uuid,
  provider text,
  status text,
  lifecycle_generation integer,
  pairing_expires_at timestamptz,
  granted_scopes text[],
  authority_policy jsonb,
  agent_phone_e164 text,
  whatsapp_group_label text,
  last_seen_at timestamptz,
  paired_at timestamptz,
  activated_at timestamptz,
  paused_at timestamptz,
  revoked_at timestamptz,
  archived_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection trip_agent_connections%rowtype;
  v_actor travelers%rowtype;
begin
  if p_provider not in ('openclaw', 'hermes')
     or p_pairing_digest is null
     or p_pairing_digest !~ '^[0-9a-f]{64}$'
     or p_pairing_expires_at is null
     or p_now is null
     or p_pairing_expires_at <= p_now then
    return;
  end if;

  select * into v_connection from trip_agent_connections as connection_row
  where connection_row.id = p_connection_id
    and connection_row.updated_at = p_expected_updated_at
    and connection_row.status in ('revoked', 'archived')
  for update;
  if not found then return; end if;

  perform 1 from trips as locked_trip where locked_trip.id = v_connection.trip_id for update;
  if not found then return; end if;
  select * into v_actor from travelers as actor_row
  where actor_row.id = p_actor_id and actor_row.trip_id = v_connection.trip_id
  for update;
  if not found or v_actor.is_organizer is not true or v_actor.is_bot is not false then
    return;
  end if;

  update trip_agent_connections as connection_row
  set provider = p_provider,
      lifecycle_generation = v_connection.lifecycle_generation + 1,
      status = 'pending',
      credential_digest = null,
      pairing_code_digest = p_pairing_digest,
      pairing_expires_at = p_pairing_expires_at,
      granted_scopes = array['connector.setup']::text[],
      authority_policy = jsonb_build_object(
        'travelerCanAddSuggestion', true,
        'travelerCanProposeChange', true
      ),
      agent_phone_e164 = null,
      whatsapp_group_digest = null,
      whatsapp_group_label = null,
      privacy_notice_version = null,
      privacy_notice_message_digest = null,
      last_seen_at = null,
      paired_at = null,
      activated_at = null,
      paused_at = null,
      revoked_at = null,
      archived_at = null,
      updated_at = greatest(p_now, v_connection.updated_at + interval '1 microsecond')
  where connection_row.id = v_connection.id
    and connection_row.updated_at = p_expected_updated_at
    and connection_row.status in ('revoked', 'archived')
  returning * into v_connection;
  if not found then return; end if;

  insert into trip_events (trip_id, actor_id, kind, detail)
  values (v_connection.trip_id, v_actor.id, 'trip_agent_connection_replaced',
    jsonb_build_object(
      'connectionId', v_connection.id,
      'provider', v_connection.provider,
      'lifecycleGeneration', v_connection.lifecycle_generation
    ));

  return query select
    v_connection.id,
    v_connection.trip_id,
    v_connection.provider,
    v_connection.status,
    v_connection.lifecycle_generation,
    v_connection.pairing_expires_at,
    v_connection.granted_scopes,
    v_connection.authority_policy,
    v_connection.agent_phone_e164,
    v_connection.whatsapp_group_label,
    v_connection.last_seen_at,
    v_connection.paired_at,
    v_connection.activated_at,
    v_connection.paused_at,
    v_connection.revoked_at,
    v_connection.archived_at,
    v_connection.created_at,
    v_connection.updated_at;
end;
$$;

-- Activation is the readiness commit point. Locking and revalidating every
-- prerequisite here prevents a mapping revocation or metadata change between a
-- separate readiness read and the paired -> active transition.
create function activate_trip_agent_connection(
  p_connection_id uuid,
  p_group_digest text,
  p_privacy_notice_version text,
  p_receipt_digest text,
  p_now timestamptz
)
returns table (status text, activated_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection trip_agent_connections%rowtype;
  v_mapping trip_agent_participant_mappings%rowtype;
  v_organizer travelers%rowtype;
  v_mapping_id uuid;
begin
  select * into v_connection
  from trip_agent_connections as connection_row
  where connection_row.id = p_connection_id
  for update;

  if not found
     or v_connection.status <> 'paired'
     or not ('connector.setup' = any(v_connection.granted_scopes))
     or v_connection.whatsapp_group_digest is null
     or p_group_digest is null
     or p_group_digest !~ '^[0-9a-f]{64}$'
     or v_connection.whatsapp_group_digest <> p_group_digest
     or nullif(btrim(v_connection.whatsapp_group_label), '') is null
     or p_privacy_notice_version is distinct from 'v1'
     or p_receipt_digest is null
     or p_receipt_digest !~ '^[0-9a-f]{64}$'
     or p_now is null
     or jsonb_typeof(v_connection.authority_policy) <> 'object'
     or not (v_connection.authority_policy ? 'travelerCanAddSuggestion')
     or not (v_connection.authority_policy ? 'travelerCanProposeChange')
     or v_connection.authority_policy - 'travelerCanAddSuggestion' - 'travelerCanProposeChange' <> '{}'::jsonb
     or jsonb_typeof(v_connection.authority_policy -> 'travelerCanAddSuggestion') <> 'boolean'
     or jsonb_typeof(v_connection.authority_policy -> 'travelerCanProposeChange') <> 'boolean' then
    return;
  end if;

  -- Locate a candidate without locking, then acquire and revalidate locks in
  -- the same connection -> mapping -> traveler order as mapping mutations.
  select mapping.id into v_mapping_id
  from trip_agent_participant_mappings as mapping
  join travelers as traveler
    on traveler.id = mapping.traveler_id
   and traveler.trip_id = mapping.trip_id
  where mapping.connection_id = v_connection.id
    and mapping.trip_id = v_connection.trip_id
    and mapping.lifecycle_generation = v_connection.lifecycle_generation
    and mapping.status = 'confirmed'
    and traveler.is_organizer = true
    and traveler.is_bot = false
  order by mapping.id
  limit 1;

  if v_mapping_id is null then
    return;
  end if;

  select * into v_mapping
  from trip_agent_participant_mappings as mapping
  where mapping.id = v_mapping_id
    and mapping.connection_id = v_connection.id
    and mapping.trip_id = v_connection.trip_id
    and mapping.lifecycle_generation = v_connection.lifecycle_generation
  for update;

  if not found then
    return;
  end if;

  perform 1 from trips as locked_trip where locked_trip.id = v_connection.trip_id for update;
  if not found then return; end if;
  select * into v_organizer
  from travelers as traveler
  where traveler.id = v_mapping.traveler_id
    and traveler.trip_id = v_connection.trip_id
  for update;

  if not found
     or v_mapping.status <> 'confirmed'
     or v_mapping.traveler_id <> v_organizer.id
     or v_organizer.is_organizer is not true
     or v_organizer.is_bot is not false then
    return;
  end if;

  update trip_agent_connections as connection_row
  set status = 'active',
      privacy_notice_version = p_privacy_notice_version,
      privacy_notice_message_digest = p_receipt_digest,
      activated_at = p_now,
      updated_at = greatest(p_now, v_connection.updated_at + interval '1 microsecond')
  where connection_row.id = v_connection.id
    and connection_row.status = 'paired'
  returning connection_row.status, connection_row.activated_at
  into status, activated_at;

  if found then
    return next;
  end if;
end;
$$;

-- Setup and announcement commands use the same current-generation action
-- ledger as itinerary mutations. Each function owns the connection lock
-- before any command, mapping, or target-action lock.
create function register_trip_agent_group_command(
  p_connection_id uuid,
  p_trip_id uuid,
  p_lifecycle_generation integer,
  p_request_id text,
  p_actor_digest text,
  p_normalized_request jsonb,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection trip_agent_connections%rowtype;
  v_action trip_agent_actions%rowtype;
  v_participant jsonb;
  v_participants jsonb;
  v_normalized_request jsonb;
  v_request_id text;
  v_result jsonb;
begin
  if p_lifecycle_generation is null or p_lifecycle_generation <= 0
     or p_request_id is null
     or p_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or p_actor_digest is null or p_actor_digest !~ '^[0-9a-f]{64}$'
     or p_now is null
     or p_normalized_request is null
     or jsonb_typeof(p_normalized_request) <> 'object'
     or p_normalized_request - 'groupDigest' - 'groupLabel' - 'participants' <> '{}'::jsonb
     or not (p_normalized_request ?& array['groupDigest','groupLabel','participants'])
     or jsonb_typeof(p_normalized_request->'groupDigest') <> 'string'
     or p_normalized_request->>'groupDigest' <> p_actor_digest
     or jsonb_typeof(p_normalized_request->'groupLabel') <> 'string'
     or nullif(btrim(p_normalized_request->>'groupLabel'), '') is null
     or char_length(p_normalized_request->>'groupLabel') > 240
     or jsonb_typeof(p_normalized_request->'participants') <> 'array'
     or jsonb_array_length(p_normalized_request->'participants') > 100 then
    return jsonb_build_object('code','invalid_input');
  end if;

  for v_participant in select value from jsonb_array_elements(p_normalized_request->'participants') loop
    if jsonb_typeof(v_participant) <> 'object'
       or v_participant - 'digest' - 'displayNameHint' <> '{}'::jsonb
       or not (v_participant ?& array['digest','displayNameHint'])
       or jsonb_typeof(v_participant->'digest') <> 'string'
       or (v_participant->>'digest') !~ '^[0-9a-f]{64}$'
       or (v_participant->'displayNameHint' <> 'null'::jsonb
         and (jsonb_typeof(v_participant->'displayNameHint') <> 'string'
           or char_length(v_participant->>'displayNameHint') > 240)) then
      return jsonb_build_object('code','invalid_input');
    end if;
  end loop;
  if (select count(*) from jsonb_array_elements(p_normalized_request->'participants')) <>
     (select count(distinct value->>'digest') from jsonb_array_elements(p_normalized_request->'participants')) then
    return jsonb_build_object('code','invalid_input');
  end if;

  v_request_id := lower(p_request_id);
  select coalesce(jsonb_agg(value order by value->>'digest'), '[]'::jsonb)
  into v_participants
  from jsonb_array_elements(p_normalized_request->'participants');
  v_normalized_request := jsonb_build_object(
    'groupDigest', p_normalized_request->>'groupDigest',
    'groupLabel', p_normalized_request->>'groupLabel',
    'participants', v_participants
  );

  select * into v_connection from trip_agent_connections
  where id = p_connection_id and trip_id = p_trip_id
  for update;
  if not found or v_connection.lifecycle_generation <> p_lifecycle_generation then
    return jsonb_build_object('code','connection_changed');
  end if;
  select * into v_action from trip_agent_actions
  where connection_id=v_connection.id and trip_id=v_connection.trip_id
    and lifecycle_generation=v_connection.lifecycle_generation
    and idempotency_key=v_request_id
  for update;
  if found then
    if v_action.operation <> 'register_group'
       or v_action.external_actor_digest <> p_actor_digest
       or v_action.normalized_request is distinct from v_normalized_request then
      return jsonb_build_object('code','idempotency_conflict');
    end if;
    if v_connection.status not in ('paired','active')
       or not ('connector.setup'=any(v_connection.granted_scopes)) then
      return jsonb_build_object('code','authority_changed');
    end if;
    if v_action.status = 'succeeded' then
      if v_connection.whatsapp_group_digest is distinct from p_actor_digest then
        return jsonb_build_object('code','authority_changed');
      end if;
      return jsonb_build_object('groupRegistered',true,
        'participantCount',jsonb_array_length(v_action.normalized_request->'participants'));
    end if;
    if v_action.status = 'refused' then
      if v_action.error_code = 'group_mismatch' then
        return jsonb_build_object('code','group_mismatch');
      end if;
      return jsonb_build_object('code','database_unavailable');
    end if;
    return jsonb_build_object('code','action_in_progress');
  end if;

  if v_connection.status <> 'paired'
     or not ('connector.setup'=any(v_connection.granted_scopes)) then
    return jsonb_build_object('code','authority_changed');
  end if;

  insert into trip_agent_actions(connection_id,trip_id,lifecycle_generation,idempotency_key,
    external_actor_digest,operation,normalized_request,authority_decision,status,announcement_status)
  values(v_connection.id,v_connection.trip_id,v_connection.lifecycle_generation,v_request_id,
    p_actor_digest,'register_group',v_normalized_request,'allowed','received','pending')
  returning * into v_action;

  if v_connection.whatsapp_group_digest is not null
     and v_connection.whatsapp_group_digest <> p_actor_digest then
    update trip_agent_actions set status='refused',error_code='group_mismatch',
      result=jsonb_build_object('code','group_mismatch'),updated_at=p_now
    where id=v_action.id;
    return jsonb_build_object('code','group_mismatch');
  end if;

  update trip_agent_connections set
    whatsapp_group_digest=p_actor_digest,
    whatsapp_group_label=v_normalized_request->>'groupLabel',
    updated_at=greatest(p_now,v_connection.updated_at+interval '1 microsecond')
  where id=v_connection.id;

  insert into trip_agent_participant_mappings(connection_id,trip_id,lifecycle_generation,
    external_participant_digest,display_name_hint,status)
  select v_connection.id,v_connection.trip_id,v_connection.lifecycle_generation,
    participant->>'digest',participant->>'displayNameHint','suggested'
  from jsonb_array_elements(v_normalized_request->'participants') participant
  on conflict(connection_id,lifecycle_generation,external_participant_digest) do update
    set display_name_hint=excluded.display_name_hint,
        updated_at=greatest(p_now,trip_agent_participant_mappings.updated_at+interval '1 microsecond')
    where trip_agent_participant_mappings.status='suggested';

  v_result := jsonb_build_object('groupRegistered',true,
    'participantCount',jsonb_array_length(v_normalized_request->'participants'));
  update trip_agent_actions set status='succeeded',result=v_result,error_code=null,
    executed_at=p_now,updated_at=p_now where id=v_action.id;
  return v_result;
end;
$$;

create function activate_trip_agent_command(
  p_connection_id uuid,
  p_trip_id uuid,
  p_lifecycle_generation integer,
  p_request_id text,
  p_actor_digest text,
  p_normalized_request jsonb,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection trip_agent_connections%rowtype;
  v_action trip_agent_actions%rowtype;
  v_activated record;
  v_organizer_mapping_id uuid;
  v_request_id text;
  v_result jsonb;
begin
  if p_lifecycle_generation is null or p_lifecycle_generation <= 0
     or p_request_id is null
     or p_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or p_actor_digest is null or p_actor_digest !~ '^[0-9a-f]{64}$'
     or p_now is null
     or p_normalized_request is null
     or jsonb_typeof(p_normalized_request) <> 'object'
     or p_normalized_request - 'groupDigest' - 'privacyNoticeVersion' - 'receiptDigest' <> '{}'::jsonb
     or not (p_normalized_request ?& array['groupDigest','privacyNoticeVersion','receiptDigest'])
     or jsonb_typeof(p_normalized_request->'groupDigest') <> 'string'
     or jsonb_typeof(p_normalized_request->'privacyNoticeVersion') <> 'string'
     or jsonb_typeof(p_normalized_request->'receiptDigest') <> 'string'
     or p_normalized_request->>'groupDigest' <> p_actor_digest
     or p_normalized_request->>'privacyNoticeVersion' <> 'v1'
     or (p_normalized_request->>'receiptDigest') !~ '^[0-9a-f]{64}$' then
    return jsonb_build_object('code','invalid_input');
  end if;
  v_request_id := lower(p_request_id);

  select * into v_connection from trip_agent_connections
  where id=p_connection_id and trip_id=p_trip_id for update;
  if not found or v_connection.lifecycle_generation <> p_lifecycle_generation then
    return jsonb_build_object('code','connection_changed');
  end if;
  select * into v_action from trip_agent_actions
  where connection_id=v_connection.id and trip_id=v_connection.trip_id
    and lifecycle_generation=v_connection.lifecycle_generation
    and idempotency_key=v_request_id
  for update;
  if found then
    if v_action.operation <> 'activate'
       or v_action.external_actor_digest <> p_actor_digest
       or v_action.normalized_request is distinct from p_normalized_request then
      return jsonb_build_object('code','idempotency_conflict');
    end if;
    if v_connection.status not in ('paired','active')
       or not ('connector.setup'=any(v_connection.granted_scopes))
       or v_connection.whatsapp_group_digest is distinct from p_actor_digest then
      return jsonb_build_object('code','authority_changed');
    end if;
    if v_action.status='succeeded' and v_connection.status='active' and v_connection.activated_at is not null then
      select mapping.id into v_organizer_mapping_id
      from trip_agent_participant_mappings mapping
      join travelers traveler
        on traveler.id=mapping.traveler_id and traveler.trip_id=mapping.trip_id
      where mapping.connection_id=v_connection.id
        and mapping.trip_id=v_connection.trip_id
        and mapping.lifecycle_generation=v_connection.lifecycle_generation
        and mapping.status='confirmed'
        and traveler.is_organizer=true
        and traveler.is_bot=false
      order by mapping.id
      limit 1
      for update of mapping, traveler;
      if not found then return jsonb_build_object('code','authority_changed'); end if;
      return jsonb_build_object('status','active','activatedAt',
        to_char(v_connection.activated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    end if;
    if v_action.status='refused' then
      if v_action.error_code='not_ready' then return jsonb_build_object('code','not_ready'); end if;
      return jsonb_build_object('code','database_unavailable');
    end if;
    return jsonb_build_object('code','action_in_progress');
  end if;

  if v_connection.status <> 'paired'
     or not ('connector.setup'=any(v_connection.granted_scopes)) then
    return jsonb_build_object('code','authority_changed');
  end if;

  insert into trip_agent_actions(connection_id,trip_id,lifecycle_generation,idempotency_key,
    external_actor_digest,operation,normalized_request,authority_decision,status,announcement_status)
  values(v_connection.id,v_connection.trip_id,v_connection.lifecycle_generation,v_request_id,
    p_actor_digest,'activate',p_normalized_request,'allowed','received','pending')
  returning * into v_action;

  select * into v_activated from activate_trip_agent_connection(
    v_connection.id,p_actor_digest,'v1',p_normalized_request->>'receiptDigest',p_now
  );
  if not found then
    update trip_agent_actions set status='refused',error_code='not_ready',
      result=jsonb_build_object('code','not_ready'),updated_at=p_now where id=v_action.id;
    return jsonb_build_object('code','not_ready');
  end if;
  v_result := jsonb_build_object('status','active','activatedAt',
    to_char(v_activated.activated_at at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
  update trip_agent_actions set status='succeeded',result=v_result,error_code=null,
    executed_at=p_now,updated_at=p_now where id=v_action.id;
  return v_result;
end;
$$;

create function report_trip_agent_announcement_command(
  p_connection_id uuid,
  p_trip_id uuid,
  p_lifecycle_generation integer,
  p_request_id text,
  p_actor_digest text,
  p_normalized_request jsonb,
  p_now timestamptz
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection trip_agent_connections%rowtype;
  v_command trip_agent_actions%rowtype;
  v_target trip_agent_actions%rowtype;
  v_action_id uuid;
  v_delivery_status text;
  v_message_digest text;
  v_stored_message_digest text;
  v_request_id text;
  v_normalized_request jsonb;
  v_result jsonb;
begin
  if p_lifecycle_generation is null or p_lifecycle_generation <= 0
     or p_request_id is null
     or p_request_id !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or p_actor_digest is null or p_actor_digest !~ '^[0-9a-f]{64}$'
     or p_now is null
     or p_normalized_request is null
     or jsonb_typeof(p_normalized_request) <> 'object'
     or p_normalized_request - 'actionId' - 'deliveryStatus' - 'providerMessageDigest' <> '{}'::jsonb
     or not (p_normalized_request ?& array['actionId','deliveryStatus','providerMessageDigest'])
     or jsonb_typeof(p_normalized_request->'actionId') <> 'string'
     or jsonb_typeof(p_normalized_request->'deliveryStatus') <> 'string'
     or (p_normalized_request->>'actionId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
     or coalesce(p_normalized_request->>'deliveryStatus','') not in ('delivered','failed')
     or (p_normalized_request->'providerMessageDigest' <> 'null'::jsonb
       and (jsonb_typeof(p_normalized_request->'providerMessageDigest') <> 'string'
         or (p_normalized_request->>'providerMessageDigest') !~ '^[0-9a-f]{64}$')) then
    return jsonb_build_object('code','invalid_input');
  end if;
  v_action_id := (p_normalized_request->>'actionId')::uuid;
  v_request_id := lower(p_request_id);
  v_delivery_status := p_normalized_request->>'deliveryStatus';
  v_message_digest := p_normalized_request->>'providerMessageDigest';
  v_normalized_request := jsonb_build_object(
    'actionId', v_action_id::text,
    'deliveryStatus', v_delivery_status,
    'providerMessageDigest', coalesce(to_jsonb(v_message_digest), 'null'::jsonb)
  );

  select * into v_connection from trip_agent_connections
  where id=p_connection_id and trip_id=p_trip_id for update;
  if not found or v_connection.lifecycle_generation <> p_lifecycle_generation then
    return jsonb_build_object('code','connection_changed');
  end if;
  if v_connection.status <> 'active'
     or not ('announcement.write'=any(v_connection.granted_scopes))
     or v_connection.whatsapp_group_digest is distinct from p_actor_digest then
    return jsonb_build_object('code','authority_changed');
  end if;

  insert into trip_agent_actions(connection_id,trip_id,lifecycle_generation,idempotency_key,
    external_actor_digest,operation,normalized_request,authority_decision,status,announcement_status)
  values(v_connection.id,v_connection.trip_id,v_connection.lifecycle_generation,v_request_id,
    p_actor_digest,'report_announcement',v_normalized_request,'allowed','received','pending')
  on conflict(connection_id,lifecycle_generation,idempotency_key) do nothing
  returning * into v_command;
  if not found then
    select * into v_command from trip_agent_actions
    where connection_id=v_connection.id and trip_id=v_connection.trip_id
      and lifecycle_generation=v_connection.lifecycle_generation
      and idempotency_key=v_request_id
    for update;
    if not found or v_command.operation <> 'report_announcement'
       or v_command.external_actor_digest <> p_actor_digest
       or v_command.normalized_request is distinct from v_normalized_request then
      return jsonb_build_object('code','idempotency_conflict');
    end if;
    if v_command.status='succeeded' then
      select * into v_target from trip_agent_actions
      where id=v_action_id and connection_id=v_connection.id and trip_id=v_connection.trip_id
        and lifecycle_generation=v_connection.lifecycle_generation
      for update;
      if not found then return jsonb_build_object('code','action_not_found'); end if;
      if v_target.status <> 'succeeded' then
        return jsonb_build_object('code','action_not_announceable');
      end if;
      v_stored_message_digest := v_target.result#>>'{announcement,providerMessageDigest}';
      if v_target.announcement_status <> v_delivery_status
         or v_stored_message_digest is distinct from v_message_digest then
        return jsonb_build_object('code','announcement_conflict');
      end if;
      return jsonb_build_object('deliveryStatus',v_command.normalized_request->>'deliveryStatus');
    end if;
    if v_command.status='refused' then
      if v_command.error_code in ('action_not_found','action_not_announceable','announcement_conflict') then
        return jsonb_build_object('code',v_command.error_code);
      end if;
      return jsonb_build_object('code','database_unavailable');
    end if;
    return jsonb_build_object('code','action_in_progress');
  end if;

  select * into v_target from trip_agent_actions
  where id=v_action_id and connection_id=v_connection.id and trip_id=v_connection.trip_id
    and lifecycle_generation=v_connection.lifecycle_generation
  for update;
  if not found then
    update trip_agent_actions set status='refused',error_code='action_not_found',
      result=jsonb_build_object('code','action_not_found'),updated_at=p_now where id=v_command.id;
    return jsonb_build_object('code','action_not_found');
  end if;
  if v_target.status <> 'succeeded' then
    update trip_agent_actions set status='refused',error_code='action_not_announceable',
      result=jsonb_build_object('code','action_not_announceable'),updated_at=p_now where id=v_command.id;
    return jsonb_build_object('code','action_not_announceable');
  end if;

  v_stored_message_digest := v_target.result#>>'{announcement,providerMessageDigest}';
  if v_target.announcement_status = 'pending' then
    update trip_agent_actions set
      announcement_status=v_delivery_status,
      announced_at=case when v_delivery_status='delivered' then p_now else null end,
      result=jsonb_set(coalesce(v_target.result,'{}'::jsonb),'{announcement}',
        jsonb_strip_nulls(jsonb_build_object('providerMessageDigest',v_message_digest)),true),
      updated_at=p_now
    where id=v_target.id;
  elsif v_target.announcement_status <> v_delivery_status
     or v_stored_message_digest is distinct from v_message_digest then
    update trip_agent_actions set status='refused',error_code='announcement_conflict',
      result=jsonb_build_object('code','announcement_conflict'),updated_at=p_now where id=v_command.id;
    return jsonb_build_object('code','announcement_conflict');
  end if;

  v_result := jsonb_build_object('deliveryStatus',v_delivery_status);
  update trip_agent_actions set status='succeeded',result=v_result,error_code=null,
    executed_at=p_now,updated_at=p_now where id=v_command.id;
  return v_result;
end;
$$;

-- Organizer mapping changes and their audit receipt share one transaction.
-- The observed mapping fields are a compare-and-set token, while locking the
-- owning connection first keeps this operation ordered with activation.
create function transition_trip_agent_participant_mapping(
  p_connection_id uuid,
  p_trip_id uuid,
  p_lifecycle_generation integer,
  p_mapping_id uuid,
  p_actor_id uuid,
  p_action text,
  p_traveler_id uuid,
  p_expected_updated_at timestamptz,
  p_expected_status text,
  p_expected_traveler_id uuid,
  p_now timestamptz
)
returns table (
  id uuid,
  connection_id uuid,
  trip_id uuid,
  lifecycle_generation integer,
  display_name_hint text,
  traveler_id uuid,
  status text,
  confirmed_by uuid,
  confirmed_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection trip_agent_connections%rowtype;
  v_mapping trip_agent_participant_mappings%rowtype;
  v_actor travelers%rowtype;
  v_target travelers%rowtype;
  v_previous_traveler_id uuid;
  v_event_kind text;
  v_event_detail jsonb;
begin
  if p_action is null
     or p_action not in ('confirm', 'remap', 'revoke')
     or p_now is null
     or p_lifecycle_generation is null
     or p_lifecycle_generation <= 0
     or p_expected_updated_at is null
     or p_expected_status is null
     or p_expected_status not in ('suggested', 'confirmed', 'revoked') then
    return;
  end if;

  select * into v_connection
  from trip_agent_connections as connection_row
  where connection_row.id = p_connection_id
    and connection_row.trip_id = p_trip_id
    and connection_row.lifecycle_generation = p_lifecycle_generation
  for update;

  if not found then
    return;
  end if;

  select * into v_mapping
  from trip_agent_participant_mappings as mapping
  where mapping.id = p_mapping_id
    and mapping.connection_id = v_connection.id
    and mapping.trip_id = v_connection.trip_id
    and mapping.lifecycle_generation = v_connection.lifecycle_generation
    and mapping.updated_at = p_expected_updated_at
    and mapping.status = p_expected_status
    and mapping.traveler_id is not distinct from p_expected_traveler_id
  for update;

  if not found then
    return;
  end if;

  perform 1 from trips as locked_trip where locked_trip.id = v_connection.trip_id for update;
  if not found then return; end if;
  select * into v_actor
  from travelers as traveler
  where traveler.id = p_actor_id
    and traveler.trip_id = v_connection.trip_id
  for update;

  if not found or v_actor.is_organizer is not true or v_actor.is_bot is not false then
    return;
  end if;

  if p_action in ('confirm', 'remap') then
    if p_traveler_id is null then
      return;
    end if;
    select * into v_target
    from travelers as traveler
    where traveler.id = p_traveler_id
      and traveler.trip_id = v_connection.trip_id
    for update;
    if not found then
      return;
    end if;
  elsif p_traveler_id is not null then
    return;
  end if;

  if (p_action = 'confirm' and v_mapping.status = 'confirmed')
     or (p_action = 'remap' and v_mapping.status <> 'confirmed')
     or (p_action = 'revoke' and v_mapping.status = 'revoked') then
    return;
  end if;

  v_previous_traveler_id := v_mapping.traveler_id;
  if p_action in ('confirm', 'remap') then
    update trip_agent_participant_mappings as mapping
    set traveler_id = v_target.id,
        status = 'confirmed',
        confirmed_by = v_actor.id,
        confirmed_at = p_now,
        revoked_at = null,
        updated_at = greatest(p_now, v_mapping.updated_at + interval '1 microsecond')
    where mapping.id = v_mapping.id
    returning * into v_mapping;
  else
    update trip_agent_participant_mappings as mapping
    set status = 'revoked',
        revoked_at = p_now,
        updated_at = greatest(p_now, v_mapping.updated_at + interval '1 microsecond')
    where mapping.id = v_mapping.id
    returning * into v_mapping;
  end if;

  if p_action = 'confirm' then
    v_event_kind := 'agent_participant_mapping_confirmed';
    v_event_detail := jsonb_build_object(
      'mappingId', v_mapping.id,
      'travelerId', v_mapping.traveler_id
    );
  elsif p_action = 'remap' then
    v_event_kind := 'agent_participant_mapping_changed';
    v_event_detail := jsonb_build_object(
      'mappingId', v_mapping.id,
      'previousTravelerId', v_previous_traveler_id,
      'travelerId', v_mapping.traveler_id
    );
  else
    v_event_kind := 'agent_participant_mapping_revoked';
    v_event_detail := jsonb_strip_nulls(jsonb_build_object(
      'mappingId', v_mapping.id,
      'travelerId', v_previous_traveler_id
    ));
  end if;

  insert into trip_events (trip_id, actor_id, kind, detail)
  values (v_connection.trip_id, v_actor.id, v_event_kind, v_event_detail);

  return query select
    v_mapping.id,
    v_mapping.connection_id,
    v_mapping.trip_id,
    v_mapping.lifecycle_generation,
    v_mapping.display_name_hint,
    v_mapping.traveler_id,
    v_mapping.status,
    v_mapping.confirmed_by,
    v_mapping.confirmed_at,
    v_mapping.revoked_at,
    v_mapping.created_at,
    v_mapping.updated_at;
end;
$$;

alter table trip_agent_connections enable row level security;
alter table trip_agent_participant_mappings enable row level security;
alter table trip_agent_actions enable row level security;
alter table trip_agent_rate_windows enable row level security;

revoke all on table
  trip_agent_connections,
  trip_agent_participant_mappings,
  trip_agent_actions,
  trip_agent_rate_windows
from public, anon, authenticated;

grant all on table
  trip_agent_connections,
  trip_agent_participant_mappings,
  trip_agent_actions,
  trip_agent_rate_windows
to service_role;

revoke all on function set_trip_agent_mapping_trip_id()
  from public, anon, authenticated;
revoke all on function validate_trip_agent_action_lifecycle()
  from public, anon, authenticated;
revoke all on function claim_trip_agent_action(uuid, uuid, uuid, text, text, text, timestamptz, boolean, jsonb)
  from public, anon, authenticated;
grant execute on function claim_trip_agent_action(uuid, uuid, uuid, text, text, text, timestamptz, boolean, jsonb)
  to service_role;
revoke all on function trip_agent_item_state(itinerary_items), trip_agent_change_state(uuid, jsonb, text),
  create_plan_proposal(uuid, uuid, uuid, text, integer, text, text, uuid, jsonb),
  create_suggestion_proposal(uuid, uuid, text, jsonb),
  finalize_trip_agent_preview(uuid, uuid, uuid, text, text, jsonb, text, text) from public, anon, authenticated;
grant execute on function trip_agent_item_state(itinerary_items), trip_agent_change_state(uuid, jsonb, text),
  create_plan_proposal(uuid, uuid, uuid, text, integer, text, text, uuid, jsonb),
  create_suggestion_proposal(uuid, uuid, text, jsonb),
  finalize_trip_agent_preview(uuid, uuid, uuid, text, text, jsonb, text, text) to service_role;
revoke all on function write_trip_agent_action_state(uuid, uuid, integer, uuid, text, text, jsonb),
  register_trip_agent_group_command(uuid, uuid, integer, text, text, jsonb, timestamptz),
  activate_trip_agent_command(uuid, uuid, integer, text, text, jsonb, timestamptz),
  report_trip_agent_announcement_command(uuid, uuid, integer, text, text, jsonb, timestamptz)
  from public, anon, authenticated;
grant execute on function write_trip_agent_action_state(uuid, uuid, integer, uuid, text, text, jsonb),
  register_trip_agent_group_command(uuid, uuid, integer, text, text, jsonb, timestamptz),
  activate_trip_agent_command(uuid, uuid, integer, text, text, jsonb, timestamptz),
  report_trip_agent_announcement_command(uuid, uuid, integer, text, text, jsonb, timestamptz)
  to service_role;
revoke all on function consume_trip_agent_pairing(text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function consume_trip_agent_rate_limit(uuid, text, integer, timestamptz)
  from public, anon, authenticated;
revoke all on function rotate_trip_agent_credential(uuid, timestamptz, text, uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function replace_trip_agent_connection(uuid, timestamptz, text, text, timestamptz, uuid, timestamptz)
  from public, anon, authenticated;
revoke all on function activate_trip_agent_connection(uuid, text, text, text, timestamptz)
  from public, anon, authenticated;
revoke all on function transition_trip_agent_participant_mapping(uuid, uuid, integer, uuid, uuid, text, uuid, timestamptz, text, uuid, timestamptz)
  from public, anon, authenticated;

grant execute on function consume_trip_agent_pairing(text, text, text, timestamptz)
  to service_role;
grant execute on function consume_trip_agent_rate_limit(uuid, text, integer, timestamptz)
  to service_role;
grant execute on function rotate_trip_agent_credential(uuid, timestamptz, text, uuid, timestamptz)
  to service_role;
grant execute on function replace_trip_agent_connection(uuid, timestamptz, text, text, timestamptz, uuid, timestamptz)
  to service_role;
grant execute on function activate_trip_agent_connection(uuid, text, text, text, timestamptz)
  to service_role;
grant execute on function transition_trip_agent_participant_mapping(uuid, uuid, integer, uuid, uuid, text, uuid, timestamptz, text, uuid, timestamptz)
  to service_role;

-- Public IP and pairing-digest quotas share this ledger. A transaction alone
-- cannot serialize count/insert under READ COMMITTED: lock the bucket first.
-- Expire this bucket by its own window. Sweep abandoned buckets after the
-- maximum supported one-day window, skipping locked rows so unrelated callers
-- never wait for the sweep. Current public callers use at most one hour.
create or replace function record_place_lookup(
  p_client_hash text, p_limit integer, p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
  v_now timestamptz;
begin
  if p_client_hash is null or p_client_hash = '' or p_limit is null or p_limit < 1
    or p_window_seconds is null or p_window_seconds < 1 or p_window_seconds > 86400 then
    return false;
  end if;
  perform pg_advisory_xact_lock(hashtextextended('public-request-limit:' || p_client_hash, 0));
  v_now := clock_timestamp();
  with expired_bucket as (
    select id from place_lookups
    where client_hash = p_client_hash
      and created_at <= v_now - make_interval(secs => p_window_seconds)
    for update skip locked
  )
  delete from place_lookups using expired_bucket where place_lookups.id = expired_bucket.id;
  with expired as (
    select id from place_lookups where created_at <= v_now - interval '1 day'
    order by created_at limit 1000 for update skip locked
  )
  delete from place_lookups using expired where place_lookups.id = expired.id;
  select count(*) into v_count from place_lookups
    where client_hash = p_client_hash
      and created_at > v_now - make_interval(secs => p_window_seconds);
  if v_count >= p_limit then return false; end if;
  insert into place_lookups (client_hash, created_at) values (p_client_hash, v_now);
  return true;
end;
$$;

revoke all on function record_place_lookup(text, integer, integer) from public, anon, authenticated;
grant execute on function record_place_lookup(text, integer, integer) to service_role;
