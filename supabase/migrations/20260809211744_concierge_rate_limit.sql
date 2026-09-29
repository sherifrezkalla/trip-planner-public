-- Keep the shared trip link from becoming an unlimited model-cost endpoint.
-- Prompts are deliberately not stored; only request timestamps are retained.
create table concierge_requests (
  id uuid primary key default gen_random_uuid(),
  traveler_id uuid not null references travelers(id) on delete cascade,
  created_at timestamptz not null default now()
);

create index concierge_requests_traveler_created
  on concierge_requests (traveler_id, created_at desc);

alter table concierge_requests enable row level security;
revoke all on table concierge_requests from anon, authenticated;
grant all on table concierge_requests to service_role;
