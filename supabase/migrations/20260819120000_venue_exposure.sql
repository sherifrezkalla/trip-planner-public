-- Whether a venue is under a roof.
--
-- The one judgement in weather adaptation that a model has to make, and the
-- reason it is a stored column rather than a call: it is asked once per venue
-- for the life of a trip, never per request, and the answer can be read down a
-- list and corrected by hand.
--
-- Category is not a usable proxy. Musée Picasso and the Monaco palace square are
-- both filed under 'history'; one is indoors and one is not.

alter table venue_candidates
  add column exposure text
  check (exposure in ('indoor', 'outdoor', 'covered'));

-- Null means "not yet classified", not "unknown but decided". An unclassified
-- venue is simply skipped by the scan rather than guessed at, so a partial or
-- failed classification degrades to doing nothing instead of doing harm.
comment on column venue_candidates.exposure is
  'indoor | outdoor | covered. Null means not yet classified; the weather scan skips those.';

create index venue_candidates_trip_exposure
  on venue_candidates (trip_id, exposure)
  where exposure is not null;
