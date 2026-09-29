# Itinerary Generation Architecture

## Purpose

Generation turns a trip's travellers, dates and destination into a full plan the
group can vote on. It is the one feature that must work before any other feature
has anything to operate on.

The design is dominated by a single constraint discovered the hard way: **the
model must never be asked to enforce a rule the validator will later apply.**
Every rule `validatePlan` checks is applied first when building the options the
model chooses between, so a rejected plan means the model ignored an instruction,
not that it was never told.

## Behavior

- Generation is organizer-only, and refuses outright when any activity is already
  completed, skipped or locked. Those trips go through Smart reshuffle instead so
  their history survives.
- The request runs in **two stages**. A cold trip fetches venues, caches them and
  returns `{stage:"venues"}`; the client immediately calls again, and that second
  call spends its whole budget on the model.
- Venues come from Google Places, once, and are reused. The pool is topped up for
  anyone who joins later with an interest it was never built for, and for member
  suggestions that have not been searched yet.
- Beyond a 15 km radius the model is asked which nearby towns are worth a day
  out; each area is then searched separately.
- A member suggestion that names a town is offered to the area proposal, so a
  place the group asks for becomes somewhere they go rather than a venue search.
- Days are assigned to areas **in code**, not by the model: the base absorbs
  alternate days and day trips fill the gaps, nearest first. A day whose area
  cannot serve dinner reverts to the base.
- Each day/slot is offered up to five venues, already filtered for area, opening
  hours and slot suitability, dealt out so nothing repeats across the trip.
- Dinner is the only required block. Morning, afternoon and evening are optional
  so the planner can answer "the group needs a quiet day" with a quiet day.
- Attempt order is primary model, primary retry with its own validation errors
  fed back, then the fallback model. If all three fail, generation fails and says
  why.

## Why the model is given aliases, not ids

The model truncated UUID venue ids to eight characters, which invalidated every
stop. Venues are therefore offered as `v1…vN`.

The alias map must be **built once and shared** between the prompt and the reply
reader. When `buildPrompt` numbered the venues it offered and `attemptPlan`
rebuilt the numbering from the whole candidate pool, `v5` meant *the fifth venue
offered* going out and *the fifth of 619* coming back. The model answered
correctly; its answer was translated somewhere else and then rejected for an area
or hours error it never made:

```
Day 0 area "Example Coast" does not match venue "Example Museum" area "Example Town"
```

That error was ours. It shipped alongside the day-structured prompt, so four
subsequent fixes — area headings, explicit rules, per-day option lists, the
deterministic fallback — all sat downstream of a mistranslation nobody had
checked, each one changing *which* wrong venue was resolved to. The errors moved
without ever clearing.

The safety property "an id from another day's list cannot resolve to anything"
was asserted in a code comment instead of tested, and was false. The suite passed
throughout because its fixtures are small enough that both maps coincide.

## Constraints that forced the shape

**Google's bias circle caps at 50 km.** Trips offer 15/60/100 km, so any trip
above 50 could never generate — `Invalid circle.radius`. Reach comes from
searching each area separately; the circle is clamped in `places.ts`, against the
API that imposes the limit, rather than trusting three call sites.

**`locationBias` biases, it does not restrict.** A geographically biased search can return a distant outlier tagged to the
requested area, and one outlier ranking well
breaks the 30 km day-spread rule for the whole plan. Areas are trimmed to within
half the day-spread limit of their own **median** position — chosen because a
median cannot be dragged by outliers, and because it makes any two surviving
venues in an area necessarily close enough to share a day.

**Structured opening hours change validation.** Earlier plans generated without
structured hours are not valid regression baselines for an hours-aware validator.
Options must be filtered before selection so the model cannot choose a venue
that the validator will later reject for missing or incompatible hours.

**One deadline cannot gate both the retry and the fallback.** Two slow rejected
primary attempts spent the fallback's turn, so the stronger model that existed to
rescue exactly that case was never called. The fallback's slot is now reserved
before the primary may spend anything.

**Attempt timeouts must not scale with day count.** Cost is driven by the prompt
— venues and travellers — not by how many days it describes. A 13-day trip was
allowed 202s and finished in ~166; a 7-day trip with more travellers was allowed
118s and cut off. The shorter trip was given less time for being shorter. The
last attempt now gets every second left on the clock.

**Areas are budgeted at `ceil(dayCount / 2)`.** A flat cap of 8 offered a one-week
trip ten towns and 796 venues, and the model could not produce any plan inside
its budget. Fewer, better areas make a better trip and a faster one.

## Decisions taken and rejected

**Day-by-day generation was rejected on product grounds.** The point of the
product is the group seeing one whole plan and shuffling days around. It is not
to be re-proposed.

**Breakfast and lunch are not planned.** Breakfast is wherever the group is
staying, lunch is wherever they happen to be. Booking either was structure nobody
asked for, and every extra block is another chance to place a closed venue.
`"lunch"` remains a valid block so plans made before this still load.

**Failures are logged, not only returned.** The reason a generation failed lived
only in a 502 body, so three failed generations produced *zero* runtime errors in
production while the board's single error line rendered below the fold on an
empty plan — the button simply looked inert. A rescued generation likewise
returns 200 and is indistinguishable from a good one, so `assembledBecause`
carries why both models were turned down into the logs.

## What a suggestion means

A member suggestion can name a venue, describe a kind of stop, or name a town.
Searching a town as a venue near the base can return a similarly named local
business. That name match does not satisfy a request to visit the town.

Suggestions are therefore also handed to the area proposal verbatim, and the
model is asked to echo the member's exact wording back on any area that answers
one. The echo, rather than name matching, is what carries the link — **a request
survives translation this way, and "Nizza" is answered with the area "Nice"**,
which no string comparison would have joined. An echo is honoured only if it
matches something a member actually wrote, because the field grants budget
priority and the model would otherwise be free to claim it for everything.

**The area budget caps the model, not the group.** Every reachable requested
place is kept and the budget fills out the rest. Trimming a request had a second
effect worse than losing the day trip: the caller fell back to venue-searching
it, reintroducing exactly the junk above for whichever request the budget
dropped. An extra area costs only Places lookups, since only areas assigned to a
day contribute options to the prompt.

## Why generation is allowed to fail

A plan was briefly assembled in code when both models failed, from the same
pre-filtered options — valid by construction, but ranked on rating alone, and it
chose a massage service for an evening and a triathlon club for a morning. It
returned 200 exactly like a real success, so a group could be handed a mechanical
itinerary with nothing to tell them one had been substituted.

The product decision is that a group is better served
by being told the plan could not be built. The rejection reasons travel with the
failure, and the message renders next to the button that was pressed rather than
in the shared error line at the foot of the board.

Removing it created one hazard that had to be closed in the same change: a
requested town becomes a day trip because the group asked for it, not because of
how much it has open, and **dinner is the only required block**. A village with a
viewpoint and no restaurant would have failed the whole generation with nothing
left to catch it. A day whose area cannot serve dinner therefore reverts to the
base. Both decisions were individually safe and jointly not; that seam is the
reason the rule exists.

## Implementation

- `app/api/trips/[slug]/generate/route.ts` owns the two-stage split, the cache
  top-up, area search, persistence and the failure/rescue logging.
- `lib/generate.ts` owns `buildDayOptions` (every rule applied before the model
  sees anything, including the dinner-viability fallback to base),
  `venueAliases`/`resolveAliases` (one map, both directions), `validatePlan`, and
  `arrangePlan`'s attempt ladder and budget arithmetic.
- `lib/areas.ts` owns the day-trip area proposal, request echoing and validation,
  and `areaBudget`.
- `lib/places.ts` owns the Places search, the 50 km bias clamp and rating filter.
- `lib/venue-cache.ts` owns category gap detection and result de-duplication.
- `BLOCK_DURATION_MIN` is a single source of truth because the filter and the
  assembler must agree — a venue offered as open for 60 minutes and then booked
  for 120 fails the very check that offered it.
- `lib/__tests__/generate.test.ts` covers alias round-tripping, day-spread,
  light days, the attempt ladder, budget reservation, and that a rescued
  generation records its reason while a model-produced one does not.

## Known limitations

- **Day trips are assigned nearest-first to alternate days**, so a 7-day trip
  takes at most three however many areas exist. A requested town beyond the third
  nearest is in the pool and available for swaps but gets no day of its own. This is the largest remaining gap
  between what a group asks for and what they get, and closing it means deciding
  how a week should be paced.
- Areas are only re-proposed when a venue fetch runs, so an existing trip does not
  pick up a newly suggested town until its cache is cleared and it regenerates.
- A suggestion is classified by the model, not by rule, so a place it does not
  recognise as a town is still searched as a venue near the base and can still
  return a base-town name match.
- Member suggestions are searched once. Clearing a venue cache without resetting
  `trip_suggestions.searched_at` drops them from the pool permanently.
- Clearing a venue cache also drops legacy categories no longer searched, so a
  refetched pool has no breakfast or café venues and mornings become sights.
- `morning` is fixed at 09:00; a traveller asking for no early mornings gets the
  earliest slot the system has rather than a later one.
- Every traveller is planned for every day. Per-traveller arrival and departure
  dates are not modelled, so someone landing on day 3 still has days 1–2 planned
  around them.
- Opening hours are Google's *regular* hours. Holiday and exceptional hours
  differ, and a venue with no structured hours is excluded entirely.
- Category selection reads every traveller's interests including automated ones,
  so a bot's stated interests still widen the search.
- Vercel does not build this project from GitHub; releases go out with
  `vercel --prod --yes`, and the deployed SHA has to be reported by hand.
