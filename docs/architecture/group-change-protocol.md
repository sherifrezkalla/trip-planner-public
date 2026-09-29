# Group Change Protocol Architecture

## Goal

Let travelers change a shared plan without letting them overwrite each other,
and without making the organizer a single point of failure.

Travelers need to adjust the plan, while the organizer needs visibility and
protection against unannounced concurrent rewrites. A proposal queue with a group vote
serves both: nothing changes without a decision, but the organizer is not the
only one who can make it.

## The rule

A traveler proposes; the plan changes when **either**:

- the organizer approves, which needs no votes; or
- **more than half** the travelers vote for it.

It dies when the organizer rejects it, or more than half vote against.

More than half, never exactly half. `canSwap` already settled this for the
group — a tie and an unvoted block both stay locked, because absence of
objection is not agreement. Four of eight is not a decision.

The denominator is **human travelers who joined**, including those who never open
the app again. That is deliberately strict, and it is safe because the
organizer's own approval is always available: a threshold nobody reaches costs
the group nothing. If a stray or test traveler distorts the count, the organizer
removes them with the existing roster control and the threshold recomputes.

## Where the rules live

| Concern | Home |
|---|---|
| Vote arithmetic, staleness rules | `lib/proposals.ts` — pure, no I/O |
| Reading the plan and acting on a verdict | `lib/proposal-actions.ts` |
| Atomicity and invariants | `supabase/migrations/20260814224500_group_change_protocol.sql` |
| Consistent tally inputs | `supabase/migrations/20260818100000_proposal_tally_single_snapshot.sql` |

The vote maths is not duplicated in SQL. What the database owns is what only it
can guarantee: the status flip and the plan write happen in one transaction, so
two people casting the deciding vote at the same moment cannot apply a proposal
twice, and a partial unique index enforces one open proposal per activity.

## One snapshot for the tally

A majority is a ratio, and its two halves have to describe the same instant.

They did not. The votes and the roster were two separate statements, and
PostgreSQL gives every statement in READ COMMITTED its own snapshot. A traveller
joining between the two produced a majority that never existed: four votes
counted against a roster of seven, needing four, while the roster was already
eight and needed five. The reverse skew — a traveller leaving — could hold back
a proposal that had genuinely passed.

`read_proposal_tally` returns both from one statement. It is deliberately one
statement rather than a `plpgsql` body with two selects, which would take two
snapshots again and change nothing. The vote arithmetic is still not duplicated
in SQL: the function returns the raw votes and the raw denominator, and
`lib/proposals.ts` remains the only place that knows what a majority is.

The same skew reached the organiser's Telegram alert, which counted the roster a
third time and could announce "4 of 8" for a decision made as "4 of 7".
`SettleResult` now carries the denominator the verdict used, so the alert quotes
the decision rather than re-deriving it.

**What this does not close.** Votes can still change between the tally and the
write. That window is not a defect: for a request to see a majority, the majority
existed in a committed snapshot, so every outcome it produces matches a valid
serial ordering — the deciding vote landed, and the retraction arrived after.
Re-checking the majority inside `apply_plan_proposal` would close it only by
duplicating the vote arithmetic in SQL, which is the boundary this design keeps.
What the database does guarantee at apply time is unchanged: the proposal is
locked, its status re-checked, and the activity re-validated, so a proposal
cannot apply twice or against a plan that moved.

## Staleness

A proposal waits for votes while the trip moves on around it, so what was
sensible on Tuesday can be nonsense by Thursday: the destination slot fills, the
group visits the activity anyway, the organizer books it, or the target day
passes.

Rather than discovering that at apply time — failing in front of whoever cast
the deciding vote — a proposal is checked against the live plan first and
cancelled the moment it stops making sense, with the reason shown to the group
so the proposer knows to ask again.

**Staleness outranks the organizer.** Approving a move onto a slot that filled
yesterday cancels the request and says why, rather than forcing it through. The
organizer can still make the change directly afterwards; what they cannot do is
turn a stale request into a silent bad write.

A proposal is cancelled when the activity is completed, removed, locked, or
booked; when it has drifted from the slot the proposer saw; when the
destination is occupied; or when the destination day has passed.

## What is proposed and what is not

| Action | Traveler | Organizer |
|---|---|---|
| Move an activity | proposes | direct |
| Remove from the plan (board) | proposes | direct |
| Accept a concierge idea for regeneration | proposes | approves or votes |
| Skip (Today Mode) | **direct** | direct |
| Lock, reservations, full reshuffle | not available | direct |

Today Mode's Skip stays instant on purpose. There the group is recording what
actually happened — they skipped it — and a record of the past is not a decision
to vote on. The board's Remove is editing the plan, which is. One state,
`skipped`, reached two ways for two different questions.

## Deliberate limitations

- **Nothing notifies the organizer.** No push, no email; a waiting request is
  found by opening the app. On a trip where the organizer is an approval path
  this is a real gap, softened only by the vote route working without them.
- **No impact preview.** A proposal says what it changes, not what that breaks —
  no reservation, travel-time, or preference-coverage consequences are shown.
  That is Priority 4 in [the product strategy](../product-strategy.md); this is
  the narrow version that ships first.
- **Proposals do not expire on a timer.** They are cancelled by facts changing,
  not by age, so a request nobody votes on sits until its day passes.
- **The threshold recomputes live.** A traveler joining mid-trip raises the bar
  for every open proposal. Each decision now measures its votes against the
  roster from the same read, so the bar moves between decisions rather than
  inside one.
- **No history view.** Settled proposals are kept in `plan_proposals` with their
  resolution, but nothing in the UI shows them yet.

## Replacing a venue

`kind = 'replace'` carries `to_candidate_id`: the venue proposed to stand in the
slot instead. Day, block and duration are untouched; only the venue changes, and
the area follows it, since a replacement can sit in a different town.

Substitutions previously had to use the swap route — organiser-only, replacement
chosen by a model, no recorded reason. A replace proposal is votable and names
both the reason and the replacement before anyone votes. For a weather swap that
is the substance of the decision: "71% rain, indoors instead" is the argument.

Staleness has a second source here. A substitution can rot from the replacement's
end as well as the slot's — the venue can leave the trip's candidates, or another
slot can take it while voting is still open. Both are checked in the pure rules and
again inside the apply transaction, because only the database can settle the second
one against a concurrent apply.

### Describing a proposal to the people deciding it

A proposal is approved from one sentence — the heading in the pending queue, or
the line above the Approve button on the organiser's phone. That sentence is
therefore part of the protocol, not presentation: if it is wrong, consent given
against it is worth nothing.

`replace` shipped with both describers still written for two kinds. Each ended in
an unconditional move sentence, so a replacement — which carries no destination
day or block by design — rendered as `Move beach to Day 1 null`, and the venue
being proposed was named nowhere. The board could not have named it regardless:
`GET /api/trips/[slug]` did not select `to_candidate_id`, so the replacement never
reached the client at all.

Three things follow, and are now in place:

- **Both describers switch exhaustively on kind.** A fallthrough is what let a
  new kind silently borrow the wording of an old one. With no `default`, adding
  a fourth kind fails to compile until it says what it means in both places.
- **The replacement name travels with the proposal.** The board resolves it in a
  separate read, because a `replace` names a venue that is deliberately *not* in
  the plan and so appears on none of the itinerary rows already fetched.
- **A missing name degrades, it does not lie.** If the stand-in has left the
  trip's candidates, the sentence becomes "for another venue" rather than
  omitting the substitution or naming a stale venue. The proposal is stale in
  that case and `proposalStaleReason` says so separately.

Rejected: describing proposals from a single shared function. The board heads a
card with a sentence-cased fragment, Telegram runs the same fact mid-sentence
after "asked to". Merging them would trade a real duplication for a casing flag
and make each call site harder to read than the sentence it produces. They are
instead pinned to each other by a test asserting the two agree up to case.

Limitation: the wording is not localised, and day numbers are positions in the
trip rather than dates. Both match the rest of the board.

See [Weather adaptation](weather-adaptation.md) for what this kind exists to serve.
