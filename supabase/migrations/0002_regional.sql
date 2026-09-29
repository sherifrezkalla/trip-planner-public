-- Regional planning: a trip can be planned over a chosen range, and every
-- candidate knows which area it belongs to and how far it is from the base.
alter table trips add column explore_radius_km integer not null default 15;
alter table venue_candidates add column area text not null default '';
alter table venue_candidates add column distance_km double precision not null default 0;
alter table itinerary_items add column area text not null default '';
