# Traveller Arrival and Departure Dates

## Purpose

A trip has one start and one end date. The people do not. Someone landing on day 2
should not have day 1 planned around them, and someone who flies home on Wednesday
should not be counted when Thursday is arranged.

Until now the group was modelled as uniformly present for the whole trip, which is
the one case that is rarely true.

## The model

Two nullable date columns on `travelers`: `arrives_on` and `departs_on`. Both bounds
are inclusive.

**Null means "there for the whole trip".** It is deliberately *not* backfilled to the
trip's own dates. A null records that nobody asked; a date equal to the trip start
records that someone answered and the answer was "from the beginning". Backfilling
would erase that difference permanently, and it is the difference between a roster
that is known and one that is merely assumed.

**The departure day is a day present.** "Leaves on the 27th" means there on the 27th
and gone on the 28th. This is the bound that invites an off-by-one, so it has its own
test: it is easy to read a departure date as the first day of absence and quietly
delete someone's last day.

**Automated travellers are excluded from both lists** rather than reported absent.
They are not people, and listing a bot as missing would be noise in the one place a
group checks who is actually around. This matches how bots are already excluded from
the vote denominator and preference coverage.

## Where the validation lives

The check constraint only orders the two dates against each other. Bounding them to
the trip would mean reaching into `trips` from a check constraint, which Postgres
does not allow. The API validates the range instead; a traveller whose dates fall
outside the trip is simply absent for all of it, which is coherent rather than
corrupt.

## What the board does with it

`attendanceForDay` splits the roster for the selected day, and the day view names
anyone who is not there. `coverageGaps` reports two shapes of problem across the
whole trip: days where some travellers are missing, and — the sharp case — days
where *nobody* is present, meaning the plan holds activities every single traveller
would miss.

The helper is pure and I/O-free, like `proposals.ts` and `permissions.ts`, so the
board and any future planner agree on who is present without a round trip.

## Known limitations

- **Granularity is a day, not a time.** A traveller who arrives at 23:00 is recorded
  as present for that entire day, including its morning and dinner blocks. This is a
  limitation: a group arriving late after a long drive may be unable to use
  day 0 while the model reports everyone present. Deciding whether a late arrival should
  shift `arrives_on` to the following day is a judgement about that trip, not
  something the schema should make on everyone's behalf.
- Nothing yet *acts* on attendance. Generation, reshuffling and preference coverage
  still treat the group as uniformly present; this records the truth and shows it,
  but does not yet plan around it.
- There is no self-service UI. Dates are set by the organiser or directly; the join
  form does not ask.
- Preference coverage counts every traveller's interests regardless of whether they
  are present on the day the interest is served. An interest belonging only to people
  who leave on Wednesday can still be "covered" by a Friday activity.
