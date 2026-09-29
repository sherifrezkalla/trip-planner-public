-- Telegram alerts for the trip organizer.
--
-- The travellers table deliberately holds no contact detail — joining from a
-- link with no account is the point of the product. A Telegram chat id is not
-- contact detail in that sense: it is an opaque number Telegram issues, useless
-- to anyone but this bot, and it arrives only because the organizer went and
-- started a conversation. That is what lets this exist without asking anyone
-- for an email address.

create table organizer_telegram_links (
  id uuid primary key default gen_random_uuid(),
  trip_id uuid not null references trips(id) on delete cascade,
  traveler_id uuid not null references travelers(id) on delete cascade,
  -- Null until /start arrives. bigint because Telegram ids outgrow int4.
  chat_id bigint,
  -- Single-use, cleared on linking, so a leaked link cannot be replayed.
  link_code text unique,
  code_expires_at timestamptz,
  linked_at timestamptz,
  created_at timestamptz not null default now(),
  constraint telegram_link_is_pending_or_linked check (
    (chat_id is null and link_code is not null and linked_at is null)
    or (chat_id is not null and link_code is null and linked_at is not null)
  )
);

-- One organizer alert channel per trip. Re-linking replaces rather than stacks.
create unique index organizer_telegram_links_one_per_trip
  on organizer_telegram_links (trip_id);

-- Every callback from Telegram arrives keyed by chat id.
create index organizer_telegram_links_by_chat
  on organizer_telegram_links (chat_id)
  where chat_id is not null;

alter table organizer_telegram_links enable row level security;
