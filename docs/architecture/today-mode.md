# Today Mode Architecture

## Adjust today reconciliation (current-day only)

The organizer-only **Adjust today** panel sits in Today Mode and is also surfaced through the shared TripBoard. It accepts bounded natural-language cues for pace/energy, activity type, duration, accessibility, and must-keep stops. Parsing is intentionally deterministic and returns unmapped text rather than silently guessing. Activity-type constraints target only non-meal stops that do not already carry the requested venue category. Replacements are selected only from the trip's existing verified `venue_candidates` pool, same area/block kind, and stored regular opening periods for the target date. The preview treats every unchanged planned stop as occupied while allowing a slot vacated by another move or skip in the same preview. It labels regular-hours, holiday, traffic, availability, and accessibility uncertainty.

The preview is pure and writes an `adjust_today_previews` row only after a non-conflicting change set exists. Closing or abandoning never mutates itinerary rows. Confirming calls the service-role `apply_adjust_today` RPC. It locks the trip and validates organizer identity, preview ownership/status, fingerprint, the normalized identity fields of the exact reviewed changes, source snapshot, planned/unlocked/non-reservation-locked rows, same-day slot kinds, candidate ownership, duplicate targets, and occupancy before one transaction updates the plan, inserts an `adjust_today` revision, settles the preview, and emits telemetry. Venue replacements persist their reviewed reason, duration, area, and final-day travel warnings with the new candidate instead of retaining stale metadata from the old venue. A settled preview cannot be replayed. The revision is read back on the authenticated board, so every group member sees its reason, day, actor identity reference, and accepted timestamp.

Follow-through instrumentation is best-effort and cannot block a plan action. The apply transaction stamps each changed item with its accepted revision. The first later status, lock, or move action consumes that marker and emits `activity_done_after_adjust`, `activity_skipped_after_adjust`, or `activity_changed_after_adjust` with the revision id. Ordinary edits and later actions on an already-consumed marker emit no adjust-today follow-through event. The event table is service-role-only.

Rejected: model-generated venue names, browser-side writes, broad cross-day optimization, and traveler confirmation. This slice does not verify exceptional/holiday hours, live traffic, current availability, or step-free access; those are explicit caveats rather than claims.

## Purpose

Today Mode turns an existing group itinerary into a live operating view. It answers six questions without mutating the schedule on page load:

1. Which trip day is today?
2. What has the group already settled?
3. What is the next unfinished activity?
4. Are weather or regular venue hours likely to disrupt it?
5. When should the group leave the previous stop?
6. If the group is running late, what safe version of the remaining day could it adopt?

## Behavior

- Before a trip, Today Mode shows a countdown and explains when the live view activates.
- During a trip, the board initially selects the current day using the traveler's local calendar date.
- Every day selector shows its calendar date with the weekday, and the traveler's current date is labeled Today in place of its day number. The weekday is shown because opening hours turn on it: "Mon" tells a reader more than "Day 3".
- Day labels come from `getTripDayDisplay` in every surface that shows one. It existed and was correct for months while nothing called it — Today Mode had grown a private copy built on local time, which shifted the label a day for readers west of UTC. One helper, pinned to UTC, now serves all of them.
- After a trip, Today Mode shows a completion summary and links to the final day.
- Activities completed early appear on the day they actually happened while preserving their original scheduled day in trip history.
- The next activity is the first planned block at or after the current part of the day. If an earlier activity remains unfinished, it is shown as the outstanding fallback.
- Structured Google opening periods are checked against the next activity's planned visit window. A warning remains advisory because holiday and exceptional hours may differ.
- Current conditions and the next six hours of precipitation risk come from Open-Meteo and refresh every 15 minutes while Today Mode is open.
- The forecast request covers two days so the six-hour scan is still answerable in the evening; the scan itself still stops at six hours.
- The panel reports when the reading was retrieved, not the hour it describes, because a cached response can be up to 45 minutes old.
- When the provider answers fewer than six hours, the panel says how far the forecast reached rather than reporting calm weather.
- Leave-by guidance uses an active reservation's exact time when available, otherwise the canonical block start time, plus a conservative distance-based transfer estimate from the previous usable stop.
- Leave-by guidance is explicitly labeled as a planning estimate; travelers open Maps for live routing and traffic.
- The Running late action uses the traveler's local time to identify the current semantic block and proposes changes only within today.

## Weather horizon and freshness

Two properties of the provider and the cache make the naive version of this panel
lie, both in the direction of false reassurance.

**The horizon must outrun local midnight.** `timezone=auto` bounds the hourly
array to the local calendar day, so a single forecast day leaves 21:00 with three
hours ahead of it and 23:00 with one. The scan skips hours it does not have, so a
truncated window produced `maxPrecipitationProbability: 0` and the message "No
significant weather disruption detected" — identical to a genuinely calm evening,
and wrong in exactly the hours a group is deciding where to eat. The request asks
for two days so the six-hour window is always fully populated; the horizon filter,
not the request size, is what keeps the scan at six hours.

Rejected: clamping the horizon to whatever remains of the local day. That keeps
one request but silently shortens the promise the panel makes, and the evening —
when the scan would shrink most — is when it matters most.

**Freshness must survive the caches.** The upstream fetch is cached for 15 minutes
and the route response may then be served stale for 30 more, so a reading can reach
a traveler 45 minutes after it was taken. `observedAt` is the hour the provider
describes and was previously shown as "updated", which conflated the two. The
response now carries `fetchedAt` taken from the provider's `Date` header, because
that header is cached alongside the body and stays true through both layers.

Rejected: stamping `Date.now()` in the route handler. It resets on every data-cache
hit, so it would claim a freshness the reading does not have — and on a CDN hit the
handler does not run at all.

**Uncertainty is reported, not inferred.** `coverageHours` states how many of the
six hours the scan actually had. A risk found inside a short window is still a real
risk and is reported normally; the shortfall replaces the message only when the scan
found nothing, which is the case where silence would read as good news.

Coverage asks whether the hourly series *spans* the horizon, not how far the last
sample inside it happened to fall. The distinction is not academic: the provider
timestamps current conditions to the quarter hour while the hourly series sits on
the hour, so the last sample inside the window is normally short of it even when
the series runs two days past. Measured the second way, coverage flapped between
five and six with the minute hand and warned about forecasts that were complete —
observed in production at 18:45 local, reporting `5h` against a series running to
23:00 the following day. Short answers round down, so coverage never overstates.

## Running-late repair policy

- Completed, skipped, and organizer-locked rows are protected and never enter the candidate set.
- Available capacity starts at the current block and excludes any future block occupied by a locked activity.
- Meals can move only between lunch and dinner; activities can move only among morning, afternoon, and evening.
- Candidate order remains chronological. The planner first maximizes the number retained, then group vote support, already-upcoming activities, same-block placement, and finally shorter movement.
- An activity moves only when structured regular opening periods cover its full visit window. Unknown hours may remain in the same block but do not authorize a move.
- Flexible activities that cannot fit are proposed as skipped, which preserves them in trip history rather than deleting them.
- The preview exposes every move, proposed skip, protected-item count, and conflict before the organizer can apply it.

## Safety boundaries

- Opening or refreshing Today Mode performs no database writes.
- Done and Skip are explicit traveler actions and use the existing authenticated activity-status endpoint.
- Rain, lower-energy, and nearby-option buttons populate the concierge input for review; they do not automatically send a request or change the itinerary.
- Running late opens a deterministic schedule preview for the organizer. For other travelers it remains a concierge handoff.
- Only the organizer can preview or apply schedule changes.
- Both whole-trip reshuffling and partial-day repair remain two-step preview/confirm actions.
- Completed, skipped, and locked activities are not rewritten by Today Mode.
- Applying a partial-day repair validates the exact reviewed source state, fails if it is stale, and commits moves, skips, and an audit revision in one database transaction.

## Implementation

- `lib/today.ts` owns deterministic date, timeline, day-label, next-item, structured-hours risk, transfer, and leave-by helpers.
- Day labels use UTC formatting for date-only trip values so they do not shift across timezones.
- `app/api/weather/route.ts` fetches and caches a bounded Open-Meteo response, with an eight-second failure ceiling, and dates the reading from the provider's `Date` header rather than the request clock.
- `lib/weather.ts` validates and translates the provider response used by Today Mode, requests two forecast days, and reports the scanned coverage alongside the risk.
- `lib/partial-day.ts` owns the deterministic capacity, vote, slot-kind, opening-hours, and protected-state policy.
- `components/TodayMode.tsx` renders the trip-phase-aware operating view.
- `components/TripBoard.tsx` integrates Today Mode with authenticated preview and confirmation flows.
- `components/SchedulePreview.tsx` renders the shared, explicit move/skip impact preview.
- `components/TripConcierge.tsx` accepts a reviewable prompt handoff from Today Mode.
- `app/api/trips/[slug]/reshuffle/route.ts` re-authenticates and re-authorizes the organizer for both preview and apply.
- `apply_partial_day_replan` is the service-role-only database function that rejects stale or invalid snapshots and records `itinerary_revisions`.
- `lib/__tests__/today.test.ts` covers trip boundaries, calendar labels, early completion, next-item selection, opening risk, transfer estimates, and leave-by calculations.
- `lib/__tests__/partial-day.test.ts` covers capacity loss, preference priority, protected state, meal slots, and cross-week opening periods.
- `lib/__tests__/weather.test.ts` covers weather-provider validation, risk classification, horizon coverage, and the split between the hour described and the moment retrieved.
- `app/api/__tests__/weather.test.ts` covers coordinate rejection, cache policy, provider failure, and provider-dated freshness.

## Known limitations

- Activities without a tentative or confirmed reservation still use semantic block start times.
- Regular opening hours may be stale or differ on holidays; travelers must verify critical visits.
- Leave-by guidance does not yet include live routes, current position, traffic, parking, or transit schedules.
- Weather availability depends on the traveler's connection and the Open-Meteo service; failure leaves the itinerary fully usable and visibly marks weather unavailable.
- A weather reading can be up to 45 minutes old when it reaches a traveler. The panel states when it was retrieved, but does not refuse to show a stale reading or escalate as it ages.
- Weather risk is a six-hour precipitation and thunderstorm scan only. It does not model wind, heat, cold, or air quality, and it does not consider whether an activity is indoors.
- The weather endpoint takes coordinates and requires no trip authentication, so its cache keys are not bounded by the trips that exist.
- Running-late repair uses semantic block start times rather than exact reservation times and does not optimize travel distance between the newly retained activities.
- The initial partial-day workflow is organizer-confirmed; group proposal, impact preview, voting, and accepted-plan measurement remain later roadmap slices.
