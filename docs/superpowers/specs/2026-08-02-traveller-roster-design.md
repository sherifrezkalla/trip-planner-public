# Traveller roster — Design

**Date:** 2026-08-02
**Status:** Approved
**Author:** Trip Planner contributors

## 1. Purpose

Every traveller supplies interests, pace, dietary needs and a free-text note when they join, and all of it shapes the generated plan. The board shows only their name, so nobody — including the organiser — can see *why* the plan looks the way it does, or whether someone's requirement was missed.

**Success criteria:**
- Anyone on the trip can see who joined and what each person asked for.
- The organiser can tell who has engaged with the plan and who needs nudging.
- The header stays readable with six or more travellers.
- No additional database round trips.

## 2. Visibility

Details are visible to **everyone on the trip**, not just the organiser. It is a family trip; people typed these preferences precisely so the plan would reflect them, and showing them lets someone catch an error in their own entry. Removing a traveller stays organiser-only, as today.

## 3. What each card shows

| Field | Source | Notes |
|---|---|---|
| Name, organiser badge | `display_name`, `is_organizer` | Already returned |
| Interests | `interests[]` | Rendered as chips |
| Pace, dietary | `pace`, `dietary` | Already returned |
| Personal note | `constraints_note` | **Newly returned**; line omitted when empty |
| Joined | `created_at` | **Newly returned** |
| Votes cast | derived | Count of that traveller's votes across current stops |
| ✕ remove | — | Organiser only, existing behaviour |

Presented behind a collapsible **"👥 Who's coming (N)"** control, matching the existing "Use on another device" pattern, so a large family does not push the itinerary off the screen.

## 4. Why vote counts belong here

Swaps are vote-gated: a stop only unlocks once the group votes it down. A roster that shows "0 votes" next to a name tells the organiser exactly who to chase before the plan can change. Without it, a blocked swap has no visible explanation.

**Known limitation:** votes are deleted when a stop is swapped or the plan is regenerated, so the count reflects votes on *current* stops only. Someone who voted before a regeneration reads as zero. Counting historical votes would mean retaining them beyond the item they belonged to, which is not worth it for a nudge indicator. The UI therefore labels this "votes on this plan".

## 5. Architecture

No new endpoint and no extra queries. The board response already includes every item with its votes (`votes(traveler_id, value)`) and every traveller with their preferences.

| Unit | Change |
|---|---|
| `lib/roster.ts` | **new** — `countVotesByTraveler(items)`, pure |
| `app/api/trips/[slug]/route.ts` | Add `constraints_note` and `created_at` to the travellers select; compute and return `voteCount` per traveller |
| `components/TripBoard.tsx` | Collapsible roster panel replacing the name-chip row |

**Counting happens on the server**, over vote rows the route already loads for `voteSum`. Returning the raw votes for the client to count would also hand every browser a record of *who voted what on which stop* — more than this feature agreed to expose. The client receives only a number per traveller. The count still costs no extra query, and lives in a tested pure function rather than inside the route.

## 6. Error handling

Nothing new can fail: the panel renders data the board has already loaded and validated.

| Case | Behaviour |
|---|---|
| Traveller wrote no note | Note line omitted |
| Traveller has no votes | Shows "no votes yet" rather than "0" |
| No plan generated yet | Vote counts are all zero; the panel still lists everyone and their preferences |
| Traveller removed while panel open | Existing broadcast refetches the board; the card disappears |

## 7. Testing

`lib/__tests__/roster.test.ts` — `countVotesByTraveler`:
- Counts a traveller's votes across several days.
- Counts 👍 and 👎 alike, since both are participation.
- Returns no entry for a traveller who has not voted.
- Handles items with no votes at all.
- Returns an empty map for an empty plan.

Full suite, types and production build stay green.

## 8. Out of scope

Historical vote retention; listing which specific stops a person voted down; editing another traveller's preferences; nudging or notifications.
