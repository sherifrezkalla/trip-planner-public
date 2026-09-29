-- Automated travellers, and keeping them out of the group's arithmetic.
--
-- A group change applies when more than half the travellers agree, so the
-- denominator decides whether the group can ever act. An assistant that rejoins
-- daily raises that bar every day: eleven joined travellers already need six
-- votes from ten real people, and a week later a real majority is unreachable.
-- The vote path then quietly dies and every change falls back to the organizer,
-- which is the bottleneck the protocol existed to remove.
--
-- A bot is still a member of the trip and still visible in the roster. It just
-- does not get a share of the group's voice, and its stated interests are not a
-- person's preferences.

alter table travelers
  add column is_bot boolean not null default false;

-- Only real travellers count toward a majority; this index keeps that count
-- cheap on the paths that run it per request.
create index travelers_human_by_trip
  on travelers (trip_id)
  where not is_bot;
