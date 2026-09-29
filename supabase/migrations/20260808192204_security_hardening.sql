-- This app deliberately routes every database operation through server-side
-- API handlers. Supabase projects created before the Data API default change
-- can still auto-grant privileges, so remove those grants explicitly.
revoke all on table
  trips,
  travelers,
  venue_candidates,
  itinerary_items,
  votes,
  venue_candidate_categories,
  trip_venue_searches,
  trip_suggestions
from anon, authenticated;

revoke all on function
  join_trip(text, text, text, text[], text, text, text),
  replace_trip_itinerary(uuid, jsonb),
  swap_itinerary_item(uuid, uuid, uuid, text, integer, text, jsonb)
from public, anon, authenticated;

grant execute on function
  join_trip(text, text, text, text[], text, text, text),
  replace_trip_itinerary(uuid, jsonb),
  swap_itinerary_item(uuid, uuid, uuid, text, integer, text, jsonb)
to service_role;

-- Covers the traveler-side foreign key used when a member is removed.
create index trip_suggestions_traveler
  on trip_suggestions (traveler_id);
