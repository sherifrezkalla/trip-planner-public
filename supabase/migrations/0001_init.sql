create extension if not exists "pgcrypto";

create table trips (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  destination_name text not null,
  destination_place_id text not null,
  lat double precision not null,
  lng double precision not null,
  start_date date not null,
  end_date date not null,
  budget_level text not null check (budget_level in ('low','mid','high')),
  vibe_note text not null default '',
  created_at timestamptz not null default now()
);

create table travelers (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  display_name text not null,
  token text not null unique,
  interests text[] not null,
  pace text not null check (pace in ('chill','balanced','packed')),
  dietary text not null,
  constraints_note text not null default '',
  is_organizer boolean not null default false,
  created_at timestamptz not null default now()
);

create table venue_candidates (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  place_id text not null,
  name text not null,
  category text not null,
  rating double precision,
  review_count integer not null default 0,
  price_level text,
  opening_hours jsonb not null default '[]',
  lat double precision not null,
  lng double precision not null,
  maps_url text not null default '',
  fetched_at timestamptz not null default now(),
  unique (trip_id, place_id)
);

create table itinerary_items (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  day_index integer not null,
  block text not null check (block in ('morning','lunch','afternoon','dinner','evening')),
  candidate_id uuid not null references venue_candidates(id),
  why_note text not null default '',
  duration_min integer not null,
  position integer not null default 0,
  travel_warning boolean not null default false,
  created_at timestamptz not null default now()
);

create table votes (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references itinerary_items(id) on delete cascade,
  traveler_id uuid not null references travelers(id) on delete cascade,
  value smallint not null check (value in (-1, 1)),
  unique (item_id, traveler_id)
);

alter table trips enable row level security;
alter table travelers enable row level security;
alter table venue_candidates enable row level security;
alter table itinerary_items enable row level security;
alter table votes enable row level security;
-- Intentionally no policies: deny-all. Only the service role (API routes) touches tables.
