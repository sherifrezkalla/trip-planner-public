# Adjust Today Reconciliation Architecture

## Goal

Let the organizer respond to a changed pace or preference without turning a
natural-language request into an unreviewed database write. The feature is
organizer-only and applies only to the current trip day.

## Request lifecycle

1. The organizer enters a short constraint such as "low energy, keep the museum,
   shorter accessible activities".
2. The API authenticates the traveler and requires organizer permission.
3. A bounded parser converts supported language into structured constraints:
   energy, duration cap, activity type, accessibility caveat, and must-keep
   names. Unsupported text is surfaced as a conflict instead of being silently
   interpreted.
4. The planner builds a pure preview. Activity-type constraints apply only to
   non-meal activities whose saved venue categories do not already satisfy the
   request. Replacements can only come from the trip's already-verified venue
   pool, same area, compatible meal/activity block, and stored regular opening
   periods. It never asks a model to invent a venue or mutate the itinerary.
5. The preview is persisted with a snapshot and fingerprint. A later preview
   supersedes an earlier open preview for the same day.
6. The organizer explicitly abandons or confirms the preview. Confirmation calls
   one database function that rechecks the snapshot, protected rows, occupied
   destinations, candidate availability, and exact normalized change payload
   before applying all changes in one transaction.

## Invariants owned by the database

`apply_adjust_today` locks the trip and validates the reviewed preview before
it changes rows. Completed, skipped, locked, and tentative/confirmed
reservation-locked items cannot be changed. Duplicate application, stale
plans, tampered move/skip/swap payloads, unauthorized actors, occupied slots,
removed candidates, and invalid blocks fail the transaction. The revision audit
row, preview status, and lifecycle event are written in the same transaction,
so a partial failure rolls back the plan and its audit trail together.

Preview occupancy starts with every planned row that will remain in place,
including flexible rows that do not need a change. Sources explicitly moved or
skipped by the same preview are treated as vacancies, so a safe same-preview
reuse is possible without proposing a destination the apply function will
reject. A replacement updates `candidate_id`, its reason, duration, and area as
one coherent unit. Travel warnings are recalculated for the final ordered day
and persisted for every surviving planned stop.

Accepted revisions are exposed to the group board with the organizer's actor
reference, reason, timestamp, and change payload. Reservation details remain
server-side and are not included in the group-visible revision display.

## Instrumentation

The shared `trip_events` table records previewed, applied, and abandoned
lifecycle events. Each item changed by an accepted revision receives a one-shot
revision marker. Its first later status, lock, or move action consumes that
marker and records done, skipped, or changed with the accepted revision id.
Items without the marker produce no follow-through event, so ordinary itinerary
editing cannot pollute adjust-today analytics. Instrumentation is best-effort:
metrics failures are logged and do not block a valid user action.

## Alternatives rejected

- **Model-generated mutations:** rejected because a model can invent a venue or
  omit a protected reservation. The model may eventually help phrase intent,
  but the current slice uses deterministic parsing and verified local data.
- **Client-side apply:** rejected because the preview and confirmation are
  separate requests and concurrent edits would create stale writes.
- **One broad reshuffle:** rejected because Adjust today represents a changed
  intent, not simply running late; it needs explicit impact and preference
  reporting.
- **External place lookup during adjustment:** rejected because it would make
  a reviewed plan depend on fresh, unverified results. The existing verified
  trip pool is the grounding boundary.

## Deployment and migration ordering

The SQL migration was applied and verified before PR #77 deployed. It creates
the event and preview tables, revision and item-attribution columns, covering
indexes, constraints, and atomic functions used by the API. The automated
migration integration test applies the full ordered migration set to Postgres
in PGlite, including a fixture for Supabase's platform-owned Storage schema,
then exercises valid persisted previews and tamper rejection. The migration,
post-merge CI, Vercel production deployment, and deployed homepage were
verified on 27 August 2026. If rollback is needed, disable the UI/API route
before reverting application code; retain the additive tables, columns, and
functions until no older application instance can call the new route.

## Limitations

Regular hours do not guarantee holiday hours, live availability, or traffic.
Accessibility is reported as a caveat because the current venue data does not
prove step-free access. The current parser supports a deliberately bounded
vocabulary rather than arbitrary natural language. Replanning does not move
activities across days. The feature does not book, cancel, or alter external
reservations.
