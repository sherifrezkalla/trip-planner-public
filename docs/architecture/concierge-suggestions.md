# Concierge results as group suggestions

## Decision

A verified, named Google Places result from the concierge enters the group's
pending proposal queue. The action is labelled **Suggest to group** and the
proposer's yes vote is recorded with the request. A majority vote or organizer
approval promotes it to the shared suggestion list for the next regeneration;
it never writes directly to the itinerary.

Only a non-empty, non-placeholder name of at most 240 characters is eligible.
The conversion normalizes whitespace but does not invent a date, time, slot,
category, rationale, or other detail. The server remains the authority for
authentication and validation. Accepted suggestions retain their actual author,
can be removed by that author or the organiser, and become planner input only
when the organiser deliberately regenerates the itinerary.

## Why this is its own proposal kind

The group-change protocol's `replace` proposal requires both an existing
itinerary item (the slot being changed) and a stored venue-candidate UUID. A
concierge result has neither a user-selected target slot nor a persisted
candidate identity. Choosing either on the user's behalf would silently turn
general advice into a specific schedule change and bypass the constraints the
proposal model protects.

`kind = 'suggest'` deliberately applies only to the suggestion list. It does not
pretend the group selected a slot. Directly adding the place to the itinerary
would bypass scheduling, reservation, distance, and opening-hours checks.

## Feedback and concurrency

Each eligible result has its own action. While its request is in flight the
button reports **Suggesting…** and is disabled; an immediate in-memory guard also
prevents two clicks before React renders that state. Success changes the action
to **Suggested to group** and announces a status message. API and network errors
are shown without marking the result as added, so it can be retried.

## Limitations

The suggestion stores the verified place name, not the concierge prose or a
Google Maps URL. Regeneration performs its existing place lookup and safety
checks; it may omit a suggestion that cannot fit opening hours, dietary needs,
distance, uniqueness, or the trip's pacing. Until accepted, the place exists
only in the pending proposal queue.
