# Deterministic itinerary lookup in the concierge

## Problem

People remember an activity type ("the gym"), not the venue name or the day it
was booked. The plan is split by day, and the concierge answered every
question with a fresh Google Places search even when the answer was already in
the itinerary — it could retrieve an exterior lookalike, not *their* stop.

## Decision

A deterministic first hop runs before any external search
(`lib/itinerary-finder.ts`). The question is answerable from the plan or it is
not; there is no "confidently wrong" middle state.

1. **Classify, then normalize.** Case, accents (NFD), and `ß→ss` fold away so
   "Musée" meets "musee". Before removing anything, the finder records a
   bounded English, French, or German group-locator frame: a where/when word
   paired with a possessive such as "our", "notre", or "unser". The question
   frame, articles, and possessives are then stop-worded out and remaining
   tokens are singularized, so "beaches", "museums", and "gyms" match their
   singulars without losing the intent that preceded tokenization.

2. **Match.** A token can hit a venue's stored name or one of its stored
   category labels via a short, hand-bounded synonym list per category
   (active→gym/fitness/Fitnessstudio…, history→museum/château/Schloss…, in
   English, French, and German). Nothing is translated through a model; the
   lists are deterministic code, reviewed like code.

3. **Decide.** If nothing in the itinerary matches, the concierge falls
   through to the existing Google Places search unchanged. If something
   matches, the external search is skipped entirely — the plan is the
   authority.

A query made only of generic service or discovery words ("restaurant?", "find
a restaurant nearby", "boat trips?", plus their French and German forms) goes
straight to external search even when the plan contains that category: the
person is asking what's around, not where their booking is. A preserved group
locator ("Where is our restaurant?", "Quand est notre excursion en bateau ?",
"Wann ist unsere Bootstour?") overrides that generic gate. A distinctive venue
token ("when are we eating at Chez Marcel?") also re-enters the itinerary hop
through the name match.

## Response contract

`/api/trips/[slug]/concierge` now also returns `itineraryMatches`:

```json
{
  "itineraryMatches": [{
    "name": "City Gym",
    "categoryLabel": "active",
    "area": "Antibes",
    "mapsUrl": "https://maps.google.com/…",
    "occurrences": [
      { "dayIndex": 1, "date": "2026-08-08", "block": "morning", "status": "skipped" },
      { "dayIndex": 3, "date": "2026-08-10", "block": "evening", "status": "planned" }
    ]
  }]
}
```

Occurrences are grouped by the stored venue-candidate ID: two slots sharing
one candidate are the same venue booked twice and the UI says so; two
same-named venues with different IDs stay separate. Dates are derived from
"day index + trip start date" in UTC so they read the same wherever the
server runs. Status is labelled (`Removed`, `Done`), not presented as current
and not hidden — a removed stop is still something a group asks about.

## Privacy boundary

The finder reads `itinerary_items` (day, block, status) and
`venue_candidates` (name, area, Maps URL, categories) only. Reservation
columns — confirmation numbers, booking URLs, cancellation deadlines — belong
to the organizer and are never selected on this path; nothing about them can
leak into the route response, the LLM instructions, or the UI.

## Never invent

When data is missing the response shows the gap rather than filling it: a
venue with no `mapsUrl` renders as plain text with "No Maps link stored" (the
name is never guessed into a Maps search URL), and every fact shown — day,
date, block, status, area — comes from one stored row.

## Deployment status

PR #76 merged on 27 August 2026 without a database migration or configuration
change. Post-merge CI, the Vercel production deployment, and the deployed
homepage were verified before dependent integration work continued.

## Limitations

- The synonym lists are deliberately short. A question outside them ("wo
  kriegen wir was zu essen?") falls through to external search rather than
  risk a wrong match. The cost of a miss is one normal search; the cost of a
  false positive is a hallucinated plan.
- Name matching is token-overlap, not semantic similarity — "picasso" matches
  "Musée Picasso", but "the artist's museum" does not.
- English, French, and German frames are covered; other languages fall back
  to external search.
- Generic-category locator frames are deliberately narrow: they require a
  where/when word and a group possessive. An ambiguous question such as
  "where is a restaurant?" remains discovery and falls through to Google.
- Matches are capped at three venue groups so a loose word ("museum" in a
  museum-heavy week) does not flood the reply.
