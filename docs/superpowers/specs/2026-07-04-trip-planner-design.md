# Group Trip Planner — v1 Design

**Date:** 2026-07-04
**Status:** Approved pending user review
**Author:** Trip Planner contributors

## 1. Purpose

A destination-agnostic web app for planning trips with friends and family. Anyone in the group creates a trip (destination, dates, budget/vibe), everyone joins via a shared link and sets personal preferences, and the app generates a realistic, grounded day-by-day itinerary from **real venues** that the whole group can see live, vote on, and refine.

**Core value (the thing that must be great):** the AI-generated itinerary. Enter a place and dates, get a plan you'd actually follow — real places, real opening hours, sensible travel times, balanced against everyone's preferences.

**Success criteria:**
- A group of 4–8 people can go from "new trip" to a full day-by-day plan in under 10 minutes.
- Every itinerary item is a real, currently-operating venue with name, rating, opening hours, and map link. No hallucinated places.
- All travelers see plan changes live without refreshing.
- Joining requires no account — open link, enter name + preferences, done.

## 2. Stack

| Layer | Choice | Notes |
|---|---|---|
| Web app | Next.js (App Router) on Vercel | SSR, API routes, free tier |
| Database + realtime | Supabase (Postgres + Realtime) | Trip state, live board updates |
| LLM (primary) | **GLM 5.2 via Ollama Cloud** | OpenAI-compatible endpoint; requires a separately funded model-provider account |
| LLM (fallback) | **Claude Sonnet 5** (Anthropic API) | Used when Ollama errors/rate-limits or when `LLM_PROVIDER` env is switched |
| LLM abstraction | Vercel AI SDK | Provider + model are env-configurable; swap is a config change, not a code change |
| Places data | **Google Places API (New)** | Real venues, ratings, opening hours, coords. $200/mo free credit covers family-scale use. Requires Google Cloud billing card. |
| Maps | Google Maps JavaScript API | Same key; itinerary pins |

**Env configuration (model swap = env change only):**
```
LLM_PROVIDER=ollama | anthropic
OLLAMA_API_KEY=...
OLLAMA_MODEL=glm-5.2:cloud
ANTHROPIC_API_KEY=...
ANTHROPIC_MODEL=claude-sonnet-5
GOOGLE_MAPS_API_KEY=...   # server-side Places calls
NEXT_PUBLIC_GOOGLE_MAPS_BROWSER_KEY=...  # map rendering, HTTP-referrer restricted
```

## 3. Core flow

1. **Create trip** — organizer enters destination (Places autocomplete), start/end dates, budget level (€/€€/€€€), optional trip vibe note. App creates the trip and returns a **share link** with an unguessable slug (e.g. `/t/x7Kf9qLmB2`).
2. **Join via magic link** — each traveler opens the link, enters display name + personal preferences. A per-traveler token is stored in `localStorage` so returning visitors are recognized on that device. No accounts, no email.
3. **Generate** — once the organizer hits "Generate plan" (allowed any time; warns if fewer than 2 travelers have joined), the two-stage pipeline (§5) produces the itinerary.
4. **Shared live board** — everyone sees the day-by-day plan update in real time (Supabase Realtime). Each item: venue name, category, time block, rating, opening hours, why-picked note, map link.
5. **Refine** — travelers 👍/👎 items; anyone can "swap" an item (regenerate that block from remaining candidates, excluding 👎-heavy picks).

## 4. Per-person preferences

Collected on join (editable later):
- **Interests** (multi-select): food & markets, history & museums, nature & parks, nightlife, shopping, art & culture, beaches/water, sports & active
- **Pace:** chill / balanced / packed
- **Dietary:** none / vegetarian / vegan / halal / other (free text)
- **Constraints** (free text): e.g. "traveling with a toddler", "no early mornings", "limited walking"

The generation prompt receives all travelers' preferences and must balance them (e.g. include vegetarian-friendly restaurants when any traveler is vegetarian; avoid museum-heavy days when a majority dislikes museums, but include one for the fan).

## 5. Generation pipeline (the heart of the app)

Two stages, so plans are grounded — the LLM never invents a place.

**Stage 1 — Retrieve (Google Places):**
- Derive search categories from the union of traveler interests + meal slots (breakfast/lunch/dinner per day).
- Query Places API Text Search / Nearby Search per category around the destination (e.g. "vegetarian-friendly restaurant near {area}", "museum in {city}").
- Collect ~15–25 candidates per category with: place_id, name, category, rating, review count, price level, opening hours, lat/lng, Maps URL.
- Filter: rating ≥ 4.0 (relax to 3.5 if a category is thin), currently operational.
- Cache candidates per trip in Postgres (`venue_candidates`) so swaps and regenerations don't re-query Places.

**Stage 2 — Arrange (LLM):**
- Input: trip metadata, all traveler preferences, and the candidate list (IDs + attributes only).
- Output: **strict JSON** — for each day, morning/afternoon/evening blocks plus lunch and dinner, each referencing a `candidate_id` from the provided list, with a one-line "why" and estimated time-at-venue.
- Validation: server rejects any `candidate_id` not in the candidate set and any block violating the venue's opening hours; on violation, one automatic retry with the validation errors appended to the prompt; if still invalid, fall back to Sonnet 5; if that fails, surface a friendly error.
- Travel-time sanity: after arrangement, compute rough distances between consecutive stops (haversine on lat/lng); flag legs > 30 min apart with a warning badge on the board (v1 does not auto-reorder).

**Swap a block:** re-run Stage 2 for a single block only, with the current plan as context, excluding the swapped-out venue and any venue with net-negative votes.

**Fallback logic:** Ollama Cloud request fails (error, timeout > 60s, or rate limit) → same request replayed against Sonnet 5 via the AI SDK. Both paths use the same prompt and JSON schema.

## 6. Data model (Supabase)

```
trips            id (pk), slug (unique, 10-char random), destination_name,
                 destination_place_id, lat, lng, start_date, end_date,
                 budget_level, vibe_note, created_at

travelers        id (pk), trip_id (fk), display_name, token (unique, for
                 localStorage re-auth), interests text[], pace, dietary,
                 constraints_note, is_organizer bool, created_at

venue_candidates id (pk), trip_id (fk), place_id, name, category, rating,
                 review_count, price_level, opening_hours jsonb, lat, lng,
                 maps_url, fetched_at

itinerary_items  id (pk), trip_id (fk), day_index int, block
                 (morning|lunch|afternoon|dinner|evening),
                 candidate_id (fk venue_candidates), why_note,
                 duration_min, position int, created_at

votes            id (pk), item_id (fk), traveler_id (fk), value (+1|-1),
                 unique(item_id, traveler_id)
```

**Access model:** all reads/writes go through Next.js API routes using the Supabase service role; the browser never talks to Supabase tables directly. API routes authorize by `(trip slug, traveler token)`. Supabase Realtime is used read-only from the browser, subscribed to the trip's `itinerary_items` and `votes` changes, scoped by trip_id channel. RLS enabled with deny-all policies on all tables (defense in depth, since only the service role connects).

**Security note:** the unguessable slug is the trip's secret — anyone with the link can join and edit. Acceptable for friends & family v1; documented in the UI ("anyone with this link can join").

## 7. Components

| Unit | Responsibility | Depends on |
|---|---|---|
| `app/` routes | `/` (create trip), `/t/[slug]` (join + board) | UI components, API routes |
| `lib/places.ts` | All Google Places calls: autocomplete, candidate retrieval, caching | Google Places API, Supabase |
| `lib/llm.ts` | AI SDK client factory (Ollama/Anthropic per env), fallback wrapper | Vercel AI SDK |
| `lib/generate.ts` | Pipeline orchestration: retrieve → arrange → validate → persist | places.ts, llm.ts, schema.ts, Supabase |
| `lib/schema.ts` | Zod schemas: itinerary JSON output, API payloads | — |
| API routes | `POST /api/trips`, `POST /api/trips/[slug]/join`, `POST /api/trips/[slug]/generate`, `POST /api/items/[id]/vote`, `POST /api/items/[id]/swap` | lib/* |
| Board UI | Day tabs, block cards, vote buttons, swap button, map panel, live updates | Supabase Realtime (read-only), API routes |

Each `lib/` module is independently testable; `generate.ts` accepts injected `places` and `llm` interfaces so tests run without network calls.

## 8. Error handling

| Failure | Behavior |
|---|---|
| Places API error/quota | Generation aborts with a clear message; organizer can retry. Candidates cached from a previous attempt are reused. |
| Thin candidate pool (small destination) | Relax rating filter; if a category still has < 3 candidates, LLM is told the category is limited and may leave blocks lighter ("free time / explore"). |
| LLM invalid JSON or invalid candidate_id | One retry with validation errors; then Sonnet 5 fallback; then user-facing error. |
| Ollama rate-limit/quota (shared with Hermes/OpenClaw) | Automatic Sonnet 5 fallback, transparent to users. |
| Duplicate join (same person, new device) | New traveler row; organizer can remove duplicates (v1: no merge). |
| Concurrent swaps on the same block | Last write wins; Realtime keeps everyone's view converged. |

## 9. Testing

- **Unit:** `schema.ts` validation, `generate.ts` orchestration with mocked places/llm (valid plan, invalid candidate_id retry path, fallback path, thin-category path), vote toggling logic.
- **Integration (manual, first trip):** one real end-to-end generation against a real destination; verify every venue exists in Google Maps, opening hours respected, JSON valid.
- **Model quality check:** run the same trip through GLM 5.2 and Sonnet 5 once; compare plan quality by eye. Keeps the fallback honest and informs whether the default should flip.

## 10. Scope

| ✅ v1 | ⏳ Later (explicitly out) |
|---|---|
| Create trip, magic-link join, per-person preferences | Real accounts / saved traveler profiles |
| Grounded two-stage generation (Places + LLM) | Expense splitting |
| Live shared board (Realtime) + map pins | Packing lists |
| 👍/👎 votes + swap-a-block | Flights/hotel info storage |
| GLM 5.2 primary / Sonnet 5 fallback via env | Drag-and-drop reordering, auto route optimization |
| Travel-time warning badges | Notifications (email/Slack), countdowns |
|  | Multi-city trips |

## 11. Costs

| Component | Monthly cost |
|---|---|
| LLM (GLM 5.2, Ollama Cloud) | $0 marginal (existing subscription) |
| Sonnet 5 fallback | ~$0.04/plan, only on fallback |
| Vercel + Supabase | $0 (free tiers) |
| Google Places + Maps | $0 within $200 free credit (requires billing card on file) |
