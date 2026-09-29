-- The trip-first indexes support tenant-scoped application reads, but the
-- composite foreign keys are declared item/creator first. PostgreSQL needs
-- matching leading columns to use an index efficiently for FK maintenance.
create index reservation_attempts_item_trip_fk
  on reservation_attempts(itinerary_item_id, trip_id);

create index reservation_attempts_creator_trip_fk
  on reservation_attempts(created_by, trip_id);
