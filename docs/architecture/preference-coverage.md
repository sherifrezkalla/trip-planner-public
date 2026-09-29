# Preference Coverage Architecture

## Goal

Make group-plan trade-offs inspectable without asking another model to explain its own output. Travelers should be able to answer:

- Who is this activity for?
- Which selected interests are represented or still missing?
- Is representation distributed reasonably evenly across the group?
- Which pace, dietary, or free-text constraints still need human judgment?

## Evidence model

Google Places results are saved with every search category that discovered them in `venue_candidate_categories`. The trip board returns those categories with each itinerary item. `lib/preference-coverage.ts` maps known categories to the same interest vocabulary travelers choose when joining.

- Direct categories such as `history`, `nature`, and `water` keep their meaning.
- `restaurant`, `breakfast`, and `cafe` map to the `food` interest.
- Unknown or suggestion-only categories are not guessed. Those activities remain unscored.
- AI-written `why_note` text is displayed as context but is never parsed as coverage evidence.

This works for existing trips because the category join table was backfilled when it was introduced. No new database migration or AI request is required.

## Current-plan rules

- Planned and completed activities count toward coverage.
- Skipped activities are history and do not count toward the current plan.
- A traveler supports an activity when at least one saved category matches one of their selected interests.
- Each traveler receives a matched-stop count plus covered and uncovered interest lists.
- Balance compares the lowest and highest matched-stop counts:
  - `balanced`: minimum is at least 75% of maximum
  - `mixed`: minimum is at least 50% of maximum
  - `uneven`: minimum is below 50% of maximum
  - `unavailable`: no traveler or no classifiable activity evidence

The UI always shows the underlying counts, so the status label is a summary rather than a hidden score.

## Conflict transparency

- Mixed pace choices are listed by traveler alongside the current average number of active stops per day.
- Non-`none` dietary needs are listed as meal constraints. The UI states that the generator was instructed to honor them and explicitly asks travelers to verify menus before booking.
- Free-text constraint notes are repeated for human verification; the system does not claim to understand or resolve them automatically.
- Activity details list the travelers and interests directly supported by that stop, plus the travelers whose selected interests it does not directly match.

## Boundaries

- Category matches show why a venue entered the candidate pool, not guaranteed subjective enjoyment.
- Dietary suitability is not independently verified from structured menu data.
- A general member suggestion may be valuable even when it cannot be scored.
- Coverage is descriptive. It does not override votes, organizer controls, locks, or schedule safety.
