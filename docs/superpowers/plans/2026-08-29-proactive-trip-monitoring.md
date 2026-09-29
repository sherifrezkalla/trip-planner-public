# Proactive Trip Monitoring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect meaningful timing, weather, venue-hour, reservation, live-driving-delay, local-event, and schedule-conflict signals and deliver restrained, deduplicated alerts through the active trip connector.

**Architecture:** A protected server-side scan loads only active in-trip connections and evaluates deterministic signal adapters. It persists group-safe structured events with stable fingerprints. The OpenClaw/Hermes connector runs its own durable five-minute polling job, calls `poll_proactive_events`, sends only returned alerts to the bound WhatsApp group, and acknowledges actual delivery. The planner never writes free-form chat and the signal engine never mutates the itinerary.

**Tech Stack:** Next.js 16 Route Handlers, Supabase/PostgreSQL, Vitest/PGlite, existing Today Mode/Open-Meteo/opening-hours/reservation logic, Google Routes `TRAFFIC_AWARE`, Ticketmaster Discovery API v2, protected external scheduler, OpenClaw Automations, Hermes Cron.

**Spec:** `docs/superpowers/specs/2026-08-29-whatsapp-first-trip-agent-v2-design.md`

## Global Constraints

- Complete and production-verify the gateway and connector plans first.
- Start from verified GitHub `master` on `codex/proactive-trip-monitoring`; inspect open PRs before editing.
- The scan reads itinerary/venue locations only. Do not add continuous traveler tracking or accept live traveler location into persisted policy/events.
- Every signal distinguishes `clear`, `triggered`, and `unavailable`. Provider/configuration/network failure must never be reported as “all clear.”
- Alerts are structured and deterministic. The connector may translate them into the user's language but may not strengthen certainty, invent disruption details, or mutate the plan.
- One event fingerprint produces at most one queued alert inside its cooldown. A failed connector delivery may be retried; a delivered alert may not.
- Quiet hours use the organizer-selected IANA destination timezone. Proactivity remains disabled until a valid timezone is saved.
- Vercel Hobby runs cron only daily and is insufficient. Implement a protected scan endpoint usable by an external five-minute scheduler; add a Vercel 15-minute cron only when the deployed project is confirmed Pro or Enterprise.

---

## File responsibility map

| File | Responsibility |
|---|---|
| `lib/proactive-policy.ts` | Pure policy defaults, IANA timezone/quiet-hour/severity decisions |
| `lib/proactive-events.ts` | Event types, stable fingerprints, cooldown, grouping, redaction, wording facts |
| `lib/proactive-scan.ts` | Orchestrates adapters for one trip; no delivery |
| `lib/proactive-timing.ts` | Departure, meeting, reservation, cancellation, plan-overlap triggers |
| `lib/proactive-traffic.ts` | Live-vs-static driving duration trigger |
| `lib/local-events.ts` | Ticketmaster query/parser and local-event relevance |
| `app/api/cron/trip-agent-events/route.ts` | Protected due-trip scan endpoint |
| `lib/trip-agent-tools.ts` | `poll_proactive_events` claim/ack behavior |
| `components/AgentConnectionSetup.tsx` | Organizer proactivity family, timezone, quiet-hours, pause controls |
| `supabase/migrations/20260830100000_trip_agent_proactivity.sql` | Policy and event records, indexes, RLS, atomic claim/ack helpers |

## Trigger thresholds for the first release

| Family | Trigger | Severity | Cooldown/expiry |
|---|---|---|---|
| Departure | Next planned stop has a leave-by time in 30 minutes or 10 minutes | action / urgent | One per threshold; expires 20 minutes after leave-by |
| Reservation | Confirmed reservation in 24 hours, 2 hours, or 30 minutes | info / action / urgent | One per threshold; expires after reservation time |
| Confirmation risk | Tentative reservation starts within 24 hours, or confirmed reservation lacks reference | action | Once per reservation/day; expires at start |
| Cancellation | Cancellation deadline falls within 24 hours | action | Once; expires at deadline |
| Weather | Existing `dayThreatensOutdoorPlans` marks a planned changeable outdoor/covered stop within 72 hours | action | Once per forecast date/item/outlook band; expires after stop |
| Venue hours | Existing `venueHoursRisk` returns danger for next stop within 24 hours | urgent within 2h, otherwise action | Once per item/hours snapshot; expires after stop |
| Traffic | Driving `duration - staticDuration >= 15 min` and `duration/staticDuration >= 1.3` for a leave-by within 2 hours | action; urgent within 30m | 30-minute cooldown; expires after departure |
| Local event | Ticketmaster event begins within 24 hours and its venue is within 2 km of a planned stop on that date | info | One per provider event/trip; expires at event end/start + 4h |
| Plan conflict | Two planned/reserved items overlap their block/explicit reservation timing or transfer cannot fit | action | Once per item pair/fingerprint; expires after earlier item |

Urgent quiet-hour override defaults off and can be enabled only by the organizer. Information alerts never override quiet hours.

## Task 1: Add policy and event persistence

**Files:**

- Create: `supabase/migrations/20260830100000_trip_agent_proactivity.sql`
- Create: `lib/__tests__/trip-agent-proactivity-migration.test.ts`

- [ ] Reuse the PGlite all-migrations harness and write failing tests for one policy per connection, valid IANA-like timezone length, valid quiet-hour values, unique event fingerprint per connection, event lifecycle constraints, atomic claim, delivered event not claimable again, failed delivery retry, and deny-all RLS.
- [ ] Create `trip_agent_proactive_policies`: `connection_id` primary key, `enabled`, `timezone`, `quiet_start`, `quiet_end`, `urgent_overrides_quiet_hours`, seven family booleans (`timing`, `weather`, `venue_hours`, `reservations`, `traffic`, `local_events`, `plan_conflicts`), `paused_at`, and timestamps. Defaults enable all families, use `22:00`–`07:00`, and disable urgent override; activation still requires a nonempty timezone.
- [ ] Create `trip_agent_proactive_events`: `id`, `connection_id`, `trip_id`, `family`, `severity`, `fingerprint`, `status`, `scheduled_for`, `expires_at`, `payload`, nullable `claimed_at`, nullable `claim_expires_at`, `delivery_attempts`, nullable `provider_message_digest`, nullable `delivered_at`, nullable `last_error_code`, and timestamps. Unique `(connection_id, fingerprint)`.
- [ ] Check families and severity against the table above; check status against `queued|claimed|delivered|failed|dismissed|expired`; limit payload size to 16 KB and require it to be a JSON object.
- [ ] Add atomic `claim_trip_agent_proactive_events(connection, now, limit)` and `ack_trip_agent_proactive_event(connection, event, delivery, message_digest, error_code)` functions. Claims expire after two minutes; delivered/dismissed/expired rows never requeue.
- [ ] Add service-role grants, deny-all RLS, due-event and trip-history indexes, comments, and a cleanup index for terminal events older than 30 days.
- [ ] Run the migration test and commit.

## Task 2: Implement policy, fingerprint, quiet hours, and grouping

**Files:**

- Create: `lib/proactive-policy.ts`
- Create: `lib/proactive-events.ts`
- Create: `lib/__tests__/proactive-policy.test.ts`
- Create: `lib/__tests__/proactive-events.test.ts`

- [ ] Add failing tests around midnight, daylight-saving transitions, invalid timezone, quiet-hour boundaries, paused/disabled family, urgent override, event expiry, stable order-independent fingerprints, and grouping multiple low-priority events into one summary.
- [ ] Implement timezone conversion with `Intl.DateTimeFormat` and explicit failure for invalid IANA zones. Do not infer timezone from server, browser, coordinates, or destination name.
- [ ] Define the discriminated union payloads for all seven families. Every payload includes `version: 1`, `family`, `severity`, `title`, `facts`, `deepLink`, `source`, and `verifyBy`; family-specific facts contain only itinerary/venue/event IDs and group-safe display values.
- [ ] Fingerprint the family plus canonical sorted fact keys with SHA-256. Group only `info` events due within the same 15-minute poll; never group `urgent` or events needing different deep links.
- [ ] Run focused tests and commit.

## Task 3: Implement timing, reservation, and conflict adapters

**Files:**

- Create: `lib/proactive-timing.ts`
- Create: `lib/__tests__/proactive-timing.test.ts`

- [ ] Build fixtures for before/during/after trip, done/skipped items, locked items, confirmed/tentative/cancelled reservations, cancellation deadlines, explicit reservation times, block times, transfers, and overlaps. Add failing tests for every threshold and negative boundary.
- [ ] Reuse `getTripTiming`, `nextTodayItem`, `leaveByEstimate`, block start times, and group-safe reservation fields. Do not recreate a second schedule clock.
- [ ] Emit only the nearest un-emitted threshold per scan. A reservation in 25 minutes must create the 30-minute event, not also 2-hour and 24-hour events.
- [ ] A “missing confirmation” alert may say the status/reference needs organizer verification; it must not include confirmation numbers, contact, proof, booking name, phone, email, or private route.
- [ ] A plan-conflict event names both stops, calculated window/transfer gap, and exact source facts. It proposes checking the plan; it never moves a stop.
- [ ] Run focused tests and commit.

## Task 4: Reuse weather and venue-hour risk as proactive adapters

**Files:**

- Modify: `lib/weather-scan.ts`
- Create: `lib/proactive-weather.ts`
- Create: `lib/__tests__/proactive-weather.test.ts`
- Modify: `lib/opening-hours.ts`

- [ ] Add failing tests proving only planned, changeable, outdoor/covered stops within the confident forecast window trigger; reserved/locked/done/skipped stops do not; incomplete forecast/hours is `unavailable`; and no suitable indoor replacement still produces a risk alert without inventing a swap.
- [ ] Extract the reusable threatened-item calculation from the existing organizer weather scan without changing its current output. Keep replacement ranking in `weather-scan.ts` and reuse its result when available.
- [ ] Reuse `regularHoursCoverBlock`/`venueHoursRisk` for closures. Holiday uncertainty remains explicit; regular hours cannot be described as live closure data.
- [ ] Include preview deep links to the exact itinerary item. Do not create plan proposals from the scan.
- [ ] Run existing weather tests plus the new adapter test and commit.

## Task 5: Add traffic-aware route signals

**Files:**

- Create: `lib/proactive-traffic.ts`
- Create: `lib/__tests__/proactive-traffic.test.ts`
- Modify: `lib/routes.ts`

- [ ] Add failing tests for the exact 15-minute/30-percent threshold, one-threshold-only cases, next leg outside two hours, missing origin, walking/local transfers, API failure, `duration` without `staticDuration`, and rate limiting to one Routes request per trip scan.
- [ ] Use the previous current-day stop as origin when completed/likely current, otherwise use the trip base. Use only the next planned stop as destination. The first release monitors driving delay; return `unavailable` for public-transit disruption rather than implying coverage.
- [ ] Cache a traffic sample for five minutes in the event payload/source facts or a dedicated in-memory request scope; do not persist polylines.
- [ ] Alert wording says “live driving estimate is X minutes versus Y normally” and provides Maps. It never claims an accident, road closure, or cause the API did not return.
- [ ] Run route/traffic tests and commit.

## Task 6: Add Ticketmaster local-event signals

**Files:**

- Create: `lib/local-events.ts`
- Create: `lib/__tests__/local-events.test.ts`
- Modify: `.env.example`

- [ ] Add parser tests for no embedded events, multiple events, cancelled/test/TBA events, missing coordinates, local date/time, start/end, venue, classification, ticket URL, malformed response, 401/429/5xx, and configured/unconfigured states.
- [ ] Implement and test `encodeGeohash(lat, lng, precision = 9)`, then call Ticketmaster Discovery API v2 events search with `apikey`, that value as `geoPoint`, `radius=10`, `unit=km`, UTC `startDateTime`/`endDateTime`, `includeTBA=no`, `includeTBD=no`, `includeTest=no`, `size=50`, and `sort=distance,asc`.
- [ ] Filter to events whose venue coordinate is within 2 km of at least one planned itinerary stop on the event's local trip date and whose start is within 24 hours. Keep the closest three, then emit one event per provider event ID.
- [ ] Return event name, local start, venue, distance from planned stop, classification, and official event URL. Do not claim crowd size, traffic disruption, availability, or relevance beyond proximity/time.
- [ ] Add `TICKETMASTER_DISCOVERY_API_KEY=` to `.env.example`. Missing key creates an `unavailable` adapter result and no misleading empty-event conclusion.
- [ ] Run focused tests and commit.

## Task 7: Orchestrate and protect the scan endpoint

**Files:**

- Create: `lib/proactive-scan.ts`
- Create: `lib/__tests__/proactive-scan.test.ts`
- Create: `app/api/cron/trip-agent-events/route.ts`
- Create: `app/api/__tests__/trip-agent-events-cron.test.ts`
- Modify: `.env.example`

- [ ] Add orchestration tests for active trip/date filtering, one trip failure not blocking others, family toggles, quiet-hour scheduling, cooldown dedupe, event expiry, structured adapter errors, and no canonical itinerary writes.
- [ ] Load connections with status `active`, enabled policy, and trips between start minus one day and end. Evaluate adapters with a concurrency cap of three trips and provider calls with bounded timeouts.
- [ ] Upsert event rows by fingerprint. If quiet hours block an alert, set `scheduled_for` to quiet end; if that falls after expiry, dismiss it. Record scan summary/failures in `trip_events` without provider response bodies.
- [ ] Protect `POST /api/cron/trip-agent-events` with `Authorization: Bearer ${CRON_SECRET}` using constant-time comparison. Return counts only: trips scanned, events queued, adapter unavailable, failures.
- [ ] Add `CRON_SECRET=` to `.env.example`. Do not add the 15-minute job to `vercel.json` unless the deployment plan is confirmed Pro/Enterprise; document the external scheduler request for all plans.
- [ ] Run focused tests and commit.

## Task 8: Deliver events through connector-owned polling

**Files:**

- Modify: `lib/trip-agent-tools.ts`
- Modify: `lib/__tests__/trip-agent-tools.test.ts`
- Modify: `docs/connectors/openclaw-whatsapp.md`
- Modify: `docs/connectors/hermes-whatsapp.md`
- Create: `docs/connectors/proactive-polling-prompt.md`

- [ ] Implement `poll_proactive_events` with actions `claim` and `ack`. Claim returns at most ten unexpired due events, already grouped/redacted and ordered urgent first. Ack accepts delivered/failed plus optional provider message ID, digests the ID, and calls the atomic RPC.
- [ ] Tests must prove scope/status/pause enforcement, claim lease, duplicate ack idempotency, another connection/trip refusal, delivered no-replay, failed retry, expiry, and that no event payload contains private reservation data.
- [ ] Write a self-contained polling prompt: call `poll_proactive_events(action="claim")`; if empty return the provider's silence token; otherwise send each returned alert to the bound group without adding facts, then ack delivered only after visible delivery ID; ack failed on rejected delivery.
- [ ] For OpenClaw document a durable `openclaw automations create --every 5m` isolated agent job, restricted to the Trip Planner MCP server and bound WhatsApp delivery route. Confirm the exact installed CLI flags from official docs before writing the final command. Verify `openclaw automations list`, one forced run, run history, pause, and resume.
- [ ] For Hermes document `hermes cron create "every 5m"` with the self-contained prompt, pinned provider/model, cron platform toolset restricted to Trip Planner MCP plus WhatsApp delivery, and `deliver` targeting the bound group. Verify `hermes cron list`, `run`, history, pause, and resume.
- [ ] A provider scheduler failure may alert the organizer privately after three failures; it must not spam the group.
- [ ] Run focused tests and commit.

## Task 9: Add organizer policy controls and visibility

**Files:**

- Modify: `components/AgentConnectionSetup.tsx`
- Modify: `app/api/trips/[slug]/agent-connection/route.ts`
- Modify: `app/api/__tests__/trip-agent-connection.test.ts`

- [ ] Extend lifecycle API schema/tests to save a valid IANA timezone, quiet start/end, urgent override, enabled/paused, and each family toggle. Travelers cannot read or change policy.
- [ ] UI defaults timezone from `Intl.DateTimeFormat().resolvedOptions().timeZone` but requires organizer review before enabling. Label it “trip timezone” and allow correction.
- [ ] Show last scan, last connector poll, queued/failed/delivered counts, and current pause state. Do not show raw event payloads or external identifiers.
- [ ] Pause proactivity independently from read access. Pausing expires no events but prevents claims; resuming does not deliver events already expired.
- [ ] Run route/setup tests, lint, build, and commit.

## Task 10: Document, validate, deploy, and verify

**Files:**

- Create: `docs/architecture/proactive-trip-agent.md`
- Modify: `README.md`
- Modify: `ROADMAP.md`

- [ ] Document thresholds, provider/data boundaries, no-location-tracking decision, quiet hours, dedupe/lease/retry, Vercel scheduling constraint, connector polling, and limitations: Ticketmaster coverage varies; regular hours are not holiday/live closure data; Routes covers driving estimates, not named incidents or public-transit disruptions.
- [ ] Cite official Ticketmaster Discovery, Google Routes traffic, Vercel cron limits, OpenClaw Automations, and Hermes Cron documentation.
- [ ] Add setup for `CRON_SECRET`, `GOOGLE_ROUTES_API_KEY`, and `TICKETMASTER_DISCOVERY_API_KEY`, including quota/cost controls and how to test each adapter as unavailable.
- [ ] Run placeholder/privacy scans plus `npm test`, `npm run lint`, and `npm run build`.
- [ ] Push/open a PR with migration, scheduler, provider keys, rollback (disable policy/poll jobs), validation, and screenshots of policy/monitoring states.
- [ ] Merge, apply migration/env, configure a five-minute external scan scheduler, configure one polling job for each verified connector, and run production simulations for rain, closure risk, reservation, traffic, local event, quiet hours, duplicate scan, failed delivery, pause, and expired event.
- [ ] Confirm no simulation changes the itinerary and no delivered alert reappears. Stop/delete test scheduler jobs and fixtures.
- [ ] Update `ROADMAP.md` as shipped only after deployment and production verification; name any provider family left unavailable instead of claiming the full proactive set.
