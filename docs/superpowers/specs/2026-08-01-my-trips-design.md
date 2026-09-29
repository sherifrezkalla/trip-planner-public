# "Your trips" — Design

**Date:** 2026-08-01
**Status:** Approved
**Author:** Trip Planner contributors

## 1. Purpose

Today a trip exists only as a link. Lose the link and the trip is unreachable, because the app has no accounts and no list of what you've joined. This feature gives each person a list of their own trips — without introducing logins.

**Success criteria:**
- Someone who has joined trips on a device sees them listed on the homepage, with no sign-in.
- A first-time visitor sees the homepage exactly as it is today (no empty-state clutter).
- A trip that was deleted, or whose stored token no longer works, is visibly marked rather than silently disappearing.
- No new way to read someone else's trip.

## 2. Identity model

**A trip is "mine" if this browser holds a valid traveler token for it.** Joining already writes `localStorage["tp:{slug}"] = token`; this feature reads those entries back. No new identity concept, no server-side link between a person's trips, nothing new to leak.

Accepted limitation: the list is per-browser. A new phone starts empty, and clearing browser data clears the list. The UI states this plainly ("Saved on this device only"). Cross-device portability is explicitly out of scope — it would require a personal bearer link that acts as a master key over every trip, which is a larger security trade-off than this feature warrants.

## 3. User experience

A "Your trips" section renders under the create form on the homepage, and **only when this device has at least one stored entry**.

Each trip is a card in the existing Sunset Voyage style (surface `#FFFDF8`, border `#EADFCC`, `rounded-2xl`), showing:
- Destination in the display serif
- Date range
- Traveler count
- Plan status: `Plan ready · N stops` or `No plan yet`
- An `✕` to remove it from this device

Cards are sorted by start date, soonest first. Clicking a card opens `/t/{slug}`.

**Unavailable trips** (deleted, or token rejected) render greyed with the label "No longer available" and keep their `✕`. They are not hidden: a vanishing trip reads as a bug, a labelled one reads as an explanation.

**Removal** deletes only the `tp:{slug}` key from this browser. It never deletes the trip or the traveler server-side, so other members are unaffected. Removing a live trip asks for confirmation first; removing an unavailable one does not.

**Failure to load** shows a short inline message with a retry inside the section. It must never block or obscure the create form.

## 4. Architecture

Three small units, each independently testable, matching the existing thin-route/tested-lib layout.

| Unit | Responsibility | Depends on |
|---|---|---|
| `lib/device-trips.ts` | Pure functions over a `Storage`-like object: read all `tp:*` entries, remove one | — |
| `lib/my-trips.ts` | `summarizeTrips(db, entries)` — validate each slug+token pair, build summaries | Supabase service client |
| `app/api/my-trips/route.ts` | Thin HTTP wrapper: validate body, call summarizer | `lib/my-trips`, `lib/db`, `lib/schema` |
| `components/MyTrips.tsx` | Client component: read device entries, fetch summaries, render | `lib/device-trips` |
| `app/page.tsx` | Renders `<CreateTripForm />` then `<MyTrips />` | above |

### Endpoint

`POST /api/my-trips`

Request: `{ entries: [{ slug: string, token: string }] }` — max 50 entries, validated with Zod.

Response `200`:
```json
{
  "trips": [{
    "slug": "x7Kf9qLmB2", "destinationName": "Tiranë",
    "startDate": "2026-08-10", "endDate": "2026-08-16",
    "travelerCount": 3, "itemCount": 28, "isOrganizer": true
  }],
  "unavailable": ["deadSlug1"]
}
```

A slug appears in `unavailable` when no trip matches it **or** the supplied token does not belong to that trip. Both cases are reported identically, so the endpoint cannot be used to discover whether a slug exists. `itemCount: 0` means no plan yet.

POST (not GET) because tokens must travel in the body, never in a URL that lands in server logs.

## 5. Data flow

1. `MyTrips` mounts, calls `readDeviceTrips(localStorage)` → `[{slug, token}]`.
2. If empty, it renders nothing and makes no request.
3. Otherwise it POSTs the entries to `/api/my-trips`.
4. `summarizeTrips` looks up each trip by slug, confirms a traveler row matches `(trip_id, token)`, and counts travelers and itinerary items.
5. The component renders available trips sorted by `startDate`, then any unavailable ones.

## 6. Error handling

| Failure | Behavior |
|---|---|
| Database unreachable | Endpoint returns 503; the section shows "Couldn't load your trips" with a Retry button. The create form stays usable. |
| Network error / non-JSON response | Same inline error path; no unhandled rejection. |
| Malformed `localStorage` entry (empty slug or token) | Skipped while reading; never sent. |
| More than 50 stored entries | Only the first 50 are sent; realistic ceiling for family use. |
| Individual invalid pair | Reported in `unavailable`, never as an error for the whole batch. |

## 7. Testing

- `lib/__tests__/device-trips.test.ts` — reads only `tp:` keys and ignores others; skips blank values; removal deletes exactly one key.
- `lib/__tests__/my-trips.test.ts` — with a stubbed database: a valid pair returns a summary; a wrong token lands in `unavailable`; a missing trip lands in `unavailable`; a mixed batch splits correctly; an empty request returns empty results without touching the database.
- Full existing suite (47 tests) must stay green; types and production build clean.

## 8. Out of scope

Cross-device sync or a portable personal link; archiving or hiding past trips; renaming trips; leaving a trip server-side; any change to how joining works.
