# Weather Adaptation

**Status: built.** `replace` proposals, venue exposure, the multi-day forecast and
the scan are all shipped. What remains unbuilt is listed at the end.

## The constraint that shapes everything

The plan must adapt to weather *without a frontier model*. Generation runs on
GLM 5.2 through Ollama Cloud, with Sonnet as fallback — and the whole point of a
SaaS prototype is that it works on the cheap model, not that it works when
somebody with a stronger one is watching.

This rules out the obvious design. "Here is the forecast, here is the itinerary,
here are the travellers, rewrite it" is a single prompt holding weather, geography,
group preferences, opening hours and attendance at once. A strong model can hold
that. A weak one produces something plausible and wrong, and the failure is
invisible until a family is standing outside a closed museum in the rain.

## The shape that survives a weak model

Give the model exactly one job, make it small, cache it, and make everything
around it arithmetic.

| step | who does it | why |
|---|---|---|
| 1. Fetch the forecast per area per day | deterministic | an HTTP call, no judgement |
| 2. Classify each venue's **exposure** | **model, once per venue** | the only judgement in the pipeline |
| 3. Match forecast against exposure | deterministic | thresholds already in `lib/weather.ts` |
| 4. Pick replacements | deterministic | filter and rank over the venue cache |
| 5. Raise a `replace` proposal | existing flow | the group still decides |

**Step 2 is the whole trick.** The question asked of the model is *"is this venue
indoors, outdoors, or covered?"* — one venue, closed vocabulary, no context beyond
a name and a category. GLM answers that reliably. It is asked once per venue for
the life of the trip, not once per request, so 782 candidates cost one batch and
never recur. The answer is inspectable: a list of venues labelled `outdoor` can be
read down in a minute and corrected by hand.

This avoids asking a model to reason simultaneously over forecasts, the entire
plan, attendance, and preferences before proposing a change.

**Errors stay bounded.** A misclassified venue produces one proposal the group
votes down. It cannot corrupt the plan, because step 5 goes through the same
vote-or-organiser gate as every other change, and `apply_plan_proposal` re-checks
the slot and the replacement inside the transaction.

## Classification needs verification

Validate exposure classifications with a synthetic or public venue sample.
A covered market can plausibly be labelled covered or outdoor; the distinction
requires human review. Small spot checks do not establish broad reliability.
Null or unclassified exposure is skipped rather than guessed.

## What is built

`kind = 'replace'` on `plan_proposals`, carrying `to_candidate_id`. A proposal can
now say "this venue, not that one" instead of only "not this day" or "not at all".

Substitutions previously had to go through the swap route, which is organiser-only,
picks the replacement with a model call, and records no reason. A replace proposal
is votable, names its replacement up front, and carries a note the group reads
before deciding — which for a weather swap is the whole point: *"71% rain, indoors
instead"* is the argument, and it should be visible.

Staleness has a second source for this kind. A substitution can rot from the
replacement's end as well as the slot's: the venue can leave the trip's candidates,
or another slot can take it while the group is still voting. Both are checked in
`proposalStaleReason` and again inside the apply transaction.

`venue_candidates.exposure` holds `indoor | outdoor | covered`, or null for not yet
classified. Null is skipped rather than guessed, so a partial or failed
classification narrows what the scan can do instead of making it wrong. Category was
never a usable proxy — Musée Picasso and the Monaco palace square are both filed
under `history`.

`POST /api/trips/[slug]/weather-scan` is organiser-only and previews by default;
`raiseProposals` is opt-in. It classifies only unclassified venues in areas the plan
actually visits, forecasts each area at the mean of its own venues rather than the
trip's base — different areas can have different weather — and returns the swaps it would
raise. Classification is capped per request, with the remainder reported, because
classifying every candidate can outlast a request; exposure is stored, so running it
again resumes rather than repeats.

The organiser's board exposes that two-step flow: **Check weather** fetches and
previews the substitutions, then **Ask the group** raises the ordinary replacement
proposals. Each preview says when its daily outlook lies beyond the three-day
confidence window. That window is measured from the date of the scan to the actual
forecast date, not from the activity's day number inside the trip: trip day zero may
still be weeks away, while trip day four may be tomorrow once the trip is underway.

## Choosing the replacement

Selection filters to same-area, indoor, unused venues and then ranks them. What it
ranks by took two attempts.

The first version sorted on category match then rating, and offered a **swimwear
boutique** to replace a rained-out beach morning: indoor, right area, five stars,
forty reviews. Correct by the rules and absurd to a person. Rating cannot separate
a destination from a place that merely exists indoors — a five-star shop outranks
a four-star museum every time.

Two rules fix it:

- **A review floor** (`MIN_REVIEWS_FOR_REPLACEMENT`, 100). Somewhere worth going in
  the rain has been reviewed by more than forty people. This alone removes the
  boutique.
- **Tiers by what the slot is for.** Outside meals, destinations (art, history,
  museum) rank above ordinary venues, and retail and nightlife rank last — offered
  only when nothing better is nearby. Ties on stars go to whichever more people
  have actually been to.

**A meal block is a hard exclusion, not a preference.** A museum is not a dinner,
whatever the forecast says, so for lunch and dinner a non-food venue is dropped
rather than demoted.

For a beach replacement, an eligible museum should outrank incidental retail.
Exact ranking depends on the available candidate pool.

**Proposing nothing is a valid outcome.** A slot with no decent indoor answer nearby
stays as it is, and the group decides in the moment — better than being handed a
shop because a shop was available.

## What is not built

- **Re-checking as the day approaches.** The scan flags any swap beyond three days
  as `beyondConfidentForecast`, but nothing re-runs it. A proposal raised a week out
  keeps its original reasoning until someone scans again.
- **Attendance is not consulted.** `lib/attendance.ts` knows who is present, but a
  substitution can still land on a day the traveller whose preference it serves has
  already flown home.

## Limitations to design around

- Forecast skill drops sharply past three days. Proposals raised a week out should
  be re-validated, not trusted; the note should carry the forecast's age.
- A blanket "swap everything outdoors when it rains" empties a Riviera trip. The
  rule needs to weigh how much of a day is already indoors, and leave a day that is
  merely damp alone.
- Attendance interacts: a substitution that lands after a traveller flies home does
  not serve the preference it claims to. `lib/attendance.ts` knows who is present;
  the selector should use it.
- Categories are not reliable indoor/outdoor signals, and fixing the exposure
  classification does not fix the category taxonomy underneath it.
