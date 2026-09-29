# Mid-Trip Editing Architecture

## Goal

A group already travelling must be able to thin out and rearrange the plan
themselves. The design addresses two problems:

- the program is too tight; and
- it is not possible to adjust the program manually.

Both involve several independent constraints.

## Why days were too tight

Day size was constrained in three independent places. Relaxing any one of them
alone changed nothing.

| Where | Constraint | Now |
|---|---|---|
| `lib/schema.ts` | `blocks` array `.min(4).max(5)` | `.min(1).max(5)` |
| `lib/generate.ts` | `REQUIRED_BLOCKS` = morning, lunch, afternoon, dinner | dinner |
| `lib/generate.ts` prompt | "Each day has blocks in this order: morning, lunch, afternoon, dinner" | morning, afternoon, and evening are explicitly optional |

Dinner is the sole required block in the current generator. Morning, afternoon,
and evening are optional. The schema permits one to five blocks; lunch remains
a valid legacy block but is not required for new generation. See
[itinerary generation](itinerary-generation.md) for the later decision.

The prompt now also asks for at least one deliberately light day per trip unless
the pace is `packed`, and ties `chill` pace to trimmed days rather than only to
longer durations. This is guidance to the model, not an invariant — the
validator enforces only the meal blocks, ordering, and the existing distance,
dietary, uniqueness, and opening-hours rules.

## Why nobody could adjust the plan

The original diagnosis was that `canManageSchedule` being organiser-only blocked
everything. That was only partly right.

- **Marking done or skipped was never gated.** The status route gates the `lock`
  action alone, and the board has always shown Done and Skip to every traveller.
  Every traveller could already remove a stop; what they could not do was say so
  in a way the plan reflected clearly.
- **Moving one activity had no path at all.** The reshuffle route plans a whole
  sweep, is organiser-only, and rejects any move that changes block. Nothing
  offered a single hand-picked move, not even for the organiser.

So the fix is one new endpoint plus labelling, not a permission rewrite.

## The permission rule

Moving an activity runs through `canManageSchedule`, the same gate as locking,
reservations, and full reshuffles: **organiser only**.

An earlier draft of this work let any traveller move an activity once the trip
had started, on the reasoning that a group standing in the street should not be
blocked by an organiser who is asleep. That was rejected deliberately. The
organiser needs a view of the plan, and a shared plan that seven people can
rewrite without anyone agreeing is not a plan.

Travellers get their say through a group change protocol instead — propose,
vote, apply — rather than by writing to the canonical plan directly. Until that
exists, every write to the plan is the organiser's.

This keeps one rule for the whole canonical plan rather than one rule per
action, which is why `canEditPlan` was removed rather than narrowed: a second
gate that resolves identically to the first is a place for the two to drift
apart later.

## Moving one activity

`POST /api/items/[id]/move` takes the item, the slot the caller believes it is
in, and the destination slot.

It reuses the existing `apply_itinerary_reshuffle` RPC with a single move rather
than introducing a second write path. That function already refuses anything
that is not `planned`, is locked, has drifted from the slot the caller saw, or
targets an occupied slot — so completed, skipped, locked, and reservation-locked
activities are protected by the same rules the organiser's reshuffle obeys, and
a stale board cannot silently overwrite a slot someone else just filled.

The route adds only what the RPC cannot know: the permission gate, a
destination-day bound check against the trip length, and a rejection of a move
that changes nothing.

Unlike the reshuffle route, a move **may change block** — moving a stop from
afternoon to evening is the common mid-trip case. Cross-day moves are allowed
within the trip.

## Removing a stop

Remove is the existing `skipped` state relabelled, not a new state. No
migration, no new column, and the reservation guard already in the status route
still refuses to skip an activity holding a tentative or confirmed booking.

The board calls it **Remove** and offers **Put back**; Today Mode still calls it
**Skip**. This is intentional. In Today Mode the group is recording what
happened — they skipped it. On the board they are editing the plan — they are
removing it. One state, two honest labels for two different questions.

Removed stops are collapsed behind a "Show N removed from this day" toggle so
the day reads as what remains, while the history stays one tap away.

## Limitations

- **Travellers cannot move anything.** They can remove and put back a stop, but
  rearranging is the organiser's. The group change protocol — propose, vote,
  apply — is what opens this up, and it is not built yet. Until it is, a group
  whose organiser is unreachable still cannot rearrange the day, which is half
  of the original complaint.
- A move is applied directly; there is no impact preview. That is Priority 4 in
  [the product strategy](../product-strategy.md).
- There is no undo beyond moving the activity back.
- The board offers no reason or attribution for a move. Skips and completions
  record `state_changed_by`; moves do not.
- The generator is asked, not forced, to produce lighter days. Whether real
  plans actually get lighter needs checking against generated trips rather than
  assuming the prompt worked.
- Lighter days only affect newly generated plans. A trip with any completed,
  skipped, or locked activity cannot be regenerated at all — both the generate
  route and `replace_trip_itinerary` refuse it — so a trip already under way
  keeps the day sizes it was born with.
