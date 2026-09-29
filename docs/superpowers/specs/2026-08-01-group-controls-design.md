# Group controls — Design

**Date:** 2026-08-01
**Status:** Approved
**Author:** Trip Planner contributors

## 1. Purpose

Three changes that make a shared plan hold together once more than one person is editing it:

1. **Thin-group warning** — stop the most likely first-use mistake: generating a plan before anyone else has joined, producing an itinerary tuned to one person.
2. **Vote-gated swaps** — a venue can only be replaced after the group has rejected it, so no one can unilaterally overwrite a choice others liked.
3. **Remove a traveller** — let the organiser clean up duplicates (the same person joining twice from two devices), which otherwise skew every preference the generator balances.

**Success criteria:**
- Generating alone is still possible, but never accidental.
- A traveller cannot swap a block the group is happy with; the organiser still can.
- The swap button and the server agree in every case.
- The organiser can remove a duplicate, and cannot remove themselves.

## 2. Permission rules

Both rules live in `lib/permissions.ts` as pure functions, imported by the API routes **and** the board so the UI and the server can never diverge. The API is public, so the server enforces independently — a disabled button is a courtesy, not a control.

### `canSwap({ voteSum, isOrganizer, travelerCount })`

Returns `{ allowed: boolean; reason: string }`. Allowed when **any** holds:

| Condition | Why |
|---|---|
| `isOrganizer` | They can already regenerate the whole plan; gating one block would be theatre. |
| `travelerCount < 2` | Nobody to disagree with. Avoids forcing a solo planner to downvote their own trip. |
| `voteSum < 0` | The group has rejected it: more 👎 than 👍. |

Otherwise blocked, with `reason` — `"Needs the group to vote it down first"` — shown in the UI and returned by the API.

`voteSum` is the sum of `votes.value` (+1/−1) for that item. A tie (0) and an unvoted block (0) are both locked: absence of objection is not rejection.

### `canRemoveTraveler({ actorIsOrganizer, actorId, targetId })`

Allowed only when the actor is the organiser **and** `actorId !== targetId`. Self-removal is refused: it would leave the trip with nobody able to regenerate. (Leaving a trip yourself is a separate feature, out of scope.)

## 3. Feature detail

### Thin-group warning

Purely client-side, in `TripBoard`. When `travelers.length < 2`:
- A muted line under the Generate button: *"Only you so far — share the link so the plan reflects everyone."*
- Pressing Generate shows one `confirm()`; cancelling aborts, confirming proceeds unchanged.

No server change. A solo trip is legitimate, so this is advisory only.

### Vote-gated swaps

**Server** (`POST /api/items/[id]/swap`): after authenticating and loading the item, fetch that item's votes and the trip's traveller count, then call `canSwap`. If blocked, return `403 { error: reason }` before any model call — cheaper and clearer than failing later.

**Client** (`TripBoard`): each card computes `canSwap` from data the board already returns (`voteSum`, `me.isOrganizer`, `travelers.length`). When blocked, the Swap button is `disabled` and the reason appears beside it in muted text.

### Remove a traveller

**Server:** `DELETE /api/trips/[slug]/travelers/[travelerId]`, body `{ token }`. Authenticates the caller, applies `canRemoveTraveler`, verifies the target belongs to this trip (404 otherwise), deletes the row, then broadcasts.

**Client:** the header lists travellers individually instead of as a joined string; the organiser sees an ✕ beside every name except their own, with a confirmation naming the person.

**Consequence, by design:** `votes.traveler_id` cascades, so removing someone deletes their votes and recounts every affected block. A block their 👎 had unlocked can re-lock. This is correct — the objection left with the person — and the broadcast means everyone's board reflects it immediately.

## 4. Architecture

| Unit | Responsibility | Status |
|---|---|---|
| `lib/permissions.ts` | `canSwap`, `canRemoveTraveler` — pure, no I/O | new |
| `app/api/items/[id]/swap/route.ts` | Add vote lookup + `canSwap` gate | modified |
| `app/api/trips/[slug]/travelers/[travelerId]/route.ts` | DELETE a traveller | new |
| `components/TripBoard.tsx` | Warning, disabled swap + reason, traveller list with ✕ | modified |

No database migration: `votes.traveler_id` already declares `on delete cascade`.

## 5. Error handling

| Failure | Behavior |
|---|---|
| Swap on a locked block | `403` with the reason; the board surfaces it inline. Reached only by a direct API call, since the button is disabled. |
| Non-organiser attempts removal | `403`. |
| Organiser removes themselves | `400` with an explanation. |
| Target traveller not on this trip | `404`. |
| Delete fails at the database | `500`; no broadcast fires, so no client shows a false success. |
| Traveller removed while another device has the board open | That device's next action returns 401 and it falls back to the join form (existing path). |

## 6. Testing

`lib/__tests__/permissions.test.ts`:
- `canSwap`: organiser bypasses a positive tally; solo trip bypasses; `voteSum < 0` unlocks; tie (0) locks; unvoted (0) locks; blocked results carry a non-empty reason.
- `canRemoveTraveler`: organiser removing another is allowed; non-organiser is refused; organiser removing themselves is refused.

The full suite (59 tests) plus types and production build must stay green.

## 7. Out of scope

Leaving a trip yourself; transferring the organiser role; merging a duplicate's votes and preferences into the surviving traveller; any change to how voting itself works.
