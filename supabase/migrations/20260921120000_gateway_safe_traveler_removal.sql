-- Gateway commands lock their connection/mappings before traveler rows. A
-- direct traveler DELETE takes the opposite order through mapping FK cascades.
-- Serialize removal with gateway commands first, then with legacy settlement.
create function remove_trip_traveler_guarded(
  p_trip_id uuid, p_actor_id uuid, p_target_id uuid
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_connection_id uuid;
  v_current_connection_id uuid;
  v_traveler_id uuid;
begin
  select id into v_connection_id from trip_agent_connections
  where trip_id = p_trip_id for update;

  perform 1 from trips where id = p_trip_id for update;
  if not found then return 'not_found'; end if;

  -- An absent connection cannot be row-locked. Its insert may have committed
  -- while we waited for the trip FK lock. Abort and start a fresh transaction
  -- instead of acquiring that new connection after the trip (reverse order).
  -- Inserts begun after our trip lock cannot commit their trip FK until we end.
  select id into v_current_connection_id from trip_agent_connections
  where trip_id = p_trip_id;
  if v_current_connection_id is distinct from v_connection_id then
    raise exception 'connection changed during removal' using errcode = 'TP009';
  end if;

  for v_traveler_id in
    select id from travelers where trip_id = p_trip_id
      and id in (p_actor_id, p_target_id) order by id
  loop
    perform 1 from travelers where id = v_traveler_id and trip_id = p_trip_id
    for no key update;
  end loop;

  if not exists (select 1 from travelers where id = p_actor_id
    and trip_id = p_trip_id and is_organizer and not is_bot) then
    return 'forbidden';
  end if;
  if p_actor_id = p_target_id then return 'self_removal'; end if;

  delete from travelers where id = p_target_id and trip_id = p_trip_id;
  if not found then return 'not_found'; end if;
  return 'removed';
end;
$$;

revoke all on function remove_trip_traveler_guarded(uuid,uuid,uuid)
  from public, anon, authenticated;
grant execute on function remove_trip_traveler_guarded(uuid,uuid,uuid)
  to service_role;
