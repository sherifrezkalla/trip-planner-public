# Regional planning — Design

**Date:** 2026-08-01
**Status:** Approved
**Author:** Trip Planner contributors

## 1. Purpose

Today every trip is planned inside a 15km bias around one point, which suits a city break and fails a regional holiday. A twelve-day stay in Vlorë should be able to reach Dhërmi, Himarë, Llogara, Apollonia and Berat — while still producing days you can actually drive.

**Success criteria:**
- A trip can be planned over a chosen range instead of a fixed city radius.
- Candidates genuinely include outlying areas, not just more venues near the base.
- Each day is anchored to one area, with its stops close enough to visit in a day.
- Travel warnings mark real mid-day transfers rather than normal driving.
- Existing city trips behave exactly as before.

## 2. Why a bigger radius alone is not enough

Google's `locationBias` is a preference, not a boundary: widening it mostly returns more venues near the centre. The current Tiranë trip demonstrates both failure modes — it already drifted ~40km out (Qerret Beach) despite a 15km bias, and 13 of its 28 stops carry a travel warning because the 5km threshold is city-scale. Widening the circle without changing day structure produces days that criss-cross the country, and a warning on nearly every stop.

Three changes therefore land together: area-seeded retrieval, day coherence enforced by validation, and a recalibrated warning threshold.

## 3. Trip range

New column `trips.explore_radius_km integer not null default 15`. The default preserves today's behaviour for every existing trip.

Chosen at creation:

| Label | Radius | Suits |
|---|---|---|
| Just the city | 15 km | City breaks (current behaviour) |
| Day trips | 60 km | A base with excursions — the Vlorë case |
| Wide region | 100 km | Touring a whole region |

Straight-line kilometres are used throughout. On mountain roads this understates driving time, so the bands are deliberately conservative: 60km straight-line corresponds to roughly 1.5 hours' driving in mountainous terrain. The UI states this ("about 1½ hours' drive"), and no routing API is introduced — an accurate road-time model is out of scope.

## 4. Area-seeded retrieval

For trips with `explore_radius_km > 15`, retrieval gains a step before searching:

1. **Propose areas.** One model call returns up to 8 named areas worth visiting within the radius of the base, each with a one-line reason. Prompt states the base, radius and the group's interests. Output is strict JSON, validated by Zod.
2. **Search per area.** For each proposed area, run the existing category searches with `"{query} in {area}, {country}"` and the area's own coordinates as bias, plus the base itself as one area. This is what surfaces Himarë and Berat instead of more Vlorë cafés.
3. **Label and measure.** Each candidate stores its `area` and its `distance_km` from the base.

The model only proposes *where to look*. Every venue still comes from Google Places, so the grounding guarantee is unchanged: a hallucinated area simply yields no results.

City trips (15km) skip step 1 entirely and behave exactly as today.

## 5. Day coherence

**In the prompt.** Each candidate line carries its area and distance from base. The plan must assign every day a single `area`, and all of that day's stops must belong to it.

**In validation.** `validatePlan` gains a geographic rule: within any day, no two stops may be more than `MAX_DAY_SPREAD_KM` (30) apart. Violations are returned as errors, which the existing retry loop feeds back to the model — the same mechanism that already prevents invented venues. A day whose stops sprawl is rejected before it ever reaches the board.

**In the output.** Each day carries its area through to storage (`itinerary_items.area`), and the board labels the day — "Day 4 · Himarë" — so a regional plan reads like an itinerary rather than a list.

## 6. Travel warnings

`WARN_KM` moves from 5 to 25. On a regional trip the old threshold fires on ordinary driving and trains people to ignore it; 25km marks a genuine mid-day transfer. City trips rarely exceed it, so warnings there become rarer and more meaningful rather than disappearing.

## 7. Architecture

| Unit | Change |
|---|---|
| `supabase/migrations/0002_regional.sql` | `trips.explore_radius_km`, `venue_candidates.area`, `venue_candidates.distance_km`, `itinerary_items.area` |
| `lib/areas.ts` | **new** — `buildAreaPrompt`, `parseAreas`, `proposeAreas(callers, …)` |
| `lib/places.ts` | `searchPlaces` takes a `radiusKm`; candidates carry `area` |
| `lib/generate.ts` | Candidate lines include area + distance; `validatePlan` gains the day-spread rule; `WARN_KM` 5 → 25; plan schema gains per-day `area` |
| `lib/schema.ts` | `createTripSchema` gains `exploreRadiusKm`; itinerary plan gains `area` per day |
| `app/api/trips/route.ts` | Persists the chosen radius |
| `app/api/trips/[slug]/generate/route.ts` | Seeds areas when radius > 15; stores area and distance |
| `components/CreateTripForm.tsx` | Range selector |
| `components/TripBoard.tsx` | Day area label |

## 8. Error handling

| Failure | Behavior |
|---|---|
| Area proposal fails or returns invalid JSON | Fall back to a single area (the base) and continue. A regional trip degrades to today's behaviour rather than failing. |
| An area yields no venues | Skipped; other areas still contribute. |
| Every area yields nothing | Existing "Not enough venues found" error (502). |
| Day-spread violation | Returned as a validation error; the existing retry and model-fallback chain handles it. |
| Plan omits a day's `area` | Schema rejects it; same retry path. |

## 9. Testing

- `lib/__tests__/areas.test.ts` — parses a valid area list; rejects malformed JSON; caps at 8; returns the base alone when the model fails.
- `lib/__tests__/generate.test.ts` (extended) — a day whose stops span more than 30km is rejected with an error naming the day; a compact day passes; `travelWarnings` uses the 25km threshold.
- `lib/__tests__/places.test.ts` (extended) — the supplied radius reaches the request; candidates carry their area.
- Full suite (68 tests) plus types and production build stay green.

## 10. Generation budget

Regional planning made two existing limits bite, both found by measuring rather than reasoning:

- **Candidate volume.** Eight areas produced 468 venues, and a prompt that large left the model unable to finish. `shortlistCandidates` keeps the best `PER_AREA_CATEGORY` (3) per area *and* category, capped at `PROMPT_CANDIDATE_CAP` (180) — preserving geographic and thematic spread while bounding prompt size. Measured: 468 → 135.
- **Model time.** A 13-day plan is 52 blocks of JSON and took ~166s against GLM 5.2, well past the old fixed 60s timeout. `planTimeoutMs(days)` scales the budget (20s + 14s/day, capped at 240s), and the route only starts a retry if a whole attempt still fits inside the function's remaining time. Verified in production at 173s end-to-end.

## 11. Out of scope

Road-time routing; multi-base trips where you sleep in different towns; editing an existing trip's destination (creating a new trip covers it); overnight excursions.
