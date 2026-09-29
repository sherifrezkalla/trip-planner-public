-- Keep the public destination search from becoming an unlimited Google bill.
--
-- `/api/places/autocomplete` cannot require a trip token: it runs on the trip
-- creation form, before a trip or a traveller exists. The Origin check it had
-- is worth keeping but is not a control — any client can send whatever Origin
-- it likes. A per-caller ceiling is the part that actually bounds the spend.
--
-- Mirrors concierge_requests: timestamps only, never the query text.

create table place_lookups (
  id uuid primary key default gen_random_uuid(),
  -- A salted hash of the caller's address, never the address. Rows live for one
  -- window, so this is short-lived obfuscation rather than anonymisation.
  client_hash text not null,
  created_at timestamptz not null default now()
);

create index place_lookups_client_created
  on place_lookups (client_hash, created_at desc);

-- Retention sweeps by age across all callers, so a one-shot address that never
-- returns cannot leave a row behind forever.
create index place_lookups_created on place_lookups (created_at);

alter table place_lookups enable row level security;
revoke all on table place_lookups from anon, authenticated;
grant all on table place_lookups to service_role;

-- Count, decide, and record in one statement-level transaction, so two requests
-- arriving together cannot both read the same count and both be let through.
create or replace function record_place_lookup(
  p_client_hash text,
  p_limit integer,
  p_window_seconds integer
)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  delete from place_lookups
  where created_at < now() - make_interval(secs => p_window_seconds);

  select count(*) into v_count
  from place_lookups
  where client_hash = p_client_hash;

  if v_count >= p_limit then
    return false;
  end if;

  insert into place_lookups (client_hash) values (p_client_hash);
  return true;
end;
$$;

revoke all on function record_place_lookup(text, integer, integer) from public, anon, authenticated;
grant execute on function record_place_lookup(text, integer, integer) to service_role;
