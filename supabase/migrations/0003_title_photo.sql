-- A trip can carry its own name and a hero photo, so a shared link renders as a
-- card rather than a bare URL. Empty title falls back to the destination name.
alter table trips add column title text not null default '';
alter table trips add column photo_ref text not null default '';
