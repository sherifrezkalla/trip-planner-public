# Shared Rules

## The problem

Five rules had been arrived at independently, more than once each, in modules
written weeks apart:

| Rule | Copies | Where |
|---|---|---|
| Great-circle distance | 2 | `generate.ts`, `today.ts` |
| The order a day's blocks run in | 4 | `schema.ts`, `today.ts`, `reshuffle.ts`, and prose inside the generation prompt |
| When each block starts | 2 | `generate.ts`, `today.ts` |
| Reading Google's opening periods | 3 | `generate.ts`, `partial-day.ts`, `today.ts` |
| A stored venue row as a `PlaceCandidate` | 2 | the generate route, the swap route |

Every copy was correct. That is what made them worth removing rather than
tolerating: nothing was broken, so nothing would have drawn attention to the
second copy until someone corrected the first.

Two are worth naming specifically.

**Opening hours.** All three copies handle Google's undocumented-looking 24/7
shape — a lone Sunday-midnight open point with no close — and all three shift a
closing time past the end of the week when a period runs past midnight. Anyone
reading one of them sees a careful, complete implementation with no hint that
two others exist. A correction to the rule would have left two of them wrong,
and the symptom would have been a venue that is open when generation asks and
closed when replanning asks.

**Block order in the prompt.** `PLANNED_BLOCKS` is the list generation may fill.
The prompt told the model the same list in prose. Changing the constant would
have left the prompt confidently describing slots the validator no longer
accepts — and the model has no way to doubt what the prompt tells it.

## What is shared and what is not

New modules, each owning one rule:

- `lib/geo.ts` — `haversineKm`.
- `lib/opening-hours.ts` — the week-minute arithmetic, the trip-day weekday, the
  block clock, and `regularHoursCoverBlock`.
- `lib/trip-dates.ts` — `formatTripDateRange`.
- `venueRowToCandidate` in `lib/places.ts`, beside the type it produces.

`lib/schema.ts` keeps `BLOCKS` as the one order; `TODAY_BLOCK_ORDER` and
`reshuffle.ts`'s `BLOCK_ORDER` are now aliases of it rather than copies. The
Today Mode names survive because its callers read better with them, and because
renaming them would have made this a much larger diff for no gain.

Three things deliberately stayed separate:

- **`PLANNED_BLOCKS`.** Not a copy — generated days skip lunch, so it is a real
  subset with a real reason. It stays its own list, and a test asserts every
  entry is a genuine block.
- **`venueHoursRisk`** in Today Mode. It shares the primitives but not the
  judgement: it grades a visit rather than admitting it, works in the venue's
  local calendar rather than UTC, and treats a block already underway as
  starting now. Folding it into `regularHoursCoverBlock` would have meant one
  function with two behaviours and a flag.
- **`isOpenForBlock`.** Kept as a named read over the shared rule, because
  generation asks about a `PlaceCandidate` while replanning asks about bare
  periods. The wrapper is one line; merging the call sites was not worth it.

## Rejected alternatives

**A single `lib/utils.ts`.** It is where the next unrelated helper goes, and the
one after that, until the module means nothing and importing it tells a reader
nothing. Four small modules named for their rule cost four imports and are
self-describing.

**Deriving `PLANNED_BLOCKS` from `BLOCKS` by filtering out lunch.** Shorter, and
it makes an editorial decision — that generated days do not plan lunch — look
like a mechanical one. Written out, it can be read and argued with.

**Leaving the duplicates and adding a comment to each pointing at the others.**
Comments do not survive the copy being moved, and there is no way to test one.

## Known limitations

- The aliases are only aliases by convention. `TODAY_BLOCK_ORDER = BLOCKS` can
  be turned back into a literal by anyone, and nothing but the test in
  `lib/__tests__/shared-helpers.test.ts` — which asserts identity, not equality
  — would notice.
- `VenueCandidateRow` is loose (`unknown` for the JSON columns) because the
  Supabase client returns rows untyped. Narrowing it would move the casts, not
  remove them.
- `formatTripDateRange` is fixed to `en-GB`. That is deliberate — the label is
  baked into link previews rendered by whoever receives them, so a
  locale-dependent format would show the same card differently to each person in
  the group — but it does mean the app has one date format for everyone.
- This covers the duplication that was found by looking. No lint rule prevents
  the next copy.
