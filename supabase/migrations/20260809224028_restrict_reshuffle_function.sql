-- Supabase projects can explicitly grant new public-schema functions to the
-- Data API roles through default privileges. Remove those direct grants from
-- this SECURITY DEFINER function; only the server-side service role may call it.
revoke all on function apply_itinerary_reshuffle(uuid, jsonb)
  from public, anon, authenticated;
grant execute on function apply_itinerary_reshuffle(uuid, jsonb) to service_role;
