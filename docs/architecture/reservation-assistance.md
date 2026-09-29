# Reservation assistance

## Decision

The first version is an organizer-controlled booking state machine, not a claim that arbitrary restaurant forms can be automated. The organizer supplies party size, requested date/time, booking name, an email or phone number, up to three acceptable alternative times, and up to three HTTPS booking routes. Preparing this request writes `awaiting_approval`; it does not contact a venue. Approval is a separate authenticated action and opens the current route in the organizer's browser.

If a route fails, the attempt advances to the next configured route. When routes are exhausted, the organizer chooses only from the alternatives approved in advance. If none exist, the workflow gives a route-specific handoff containing venue, time, party size, and the requirement to bring back a confirmation reference. The state becomes `confirmed` only when such a reference is stored; that same action writes the canonical reservation and locks the itinerary item. Opening a page is never evidence of success. The organizer can end any active attempt, including a handoff, and immediately start over; the failed row remains as private audit history.

## Tenant and privacy boundary

`reservation_attempts` is separate from canonical reservation fields on `itinerary_items`. It records state, current route, timestamps, alternatives, confirmation evidence, and organizer-only booking/contact data. Row-level access is revoked; only server code using the service role accesses it.

The create route first selects the path item by both `id` and the authenticated `trip_id`; a missing or foreign item returns the same 404 and is never inserted. Composite foreign keys then enforce `(itinerary_item_id, trip_id)` against `itinerary_items` and `(created_by, trip_id)` against `travelers`, so an application regression still cannot create a cross-trip attempt. PATCH reads are likewise scoped by attempt id and authenticated trip, and canonical confirmation repeats the same organizer, attempt, and item checks inside the database transaction.

Travelers receive exactly the workflow state and verified confirmation reference. Attempt id, party size, requested and alternative times, route provider/index/URLs, confirmation URL, handoff text, booking name, email, phone, and workflow timestamps are organizer-only. Failed attempts serialize as no current attempt so the organizer can retry, while the database retains the row.

## Transactions, concurrency, and retry

`confirm_reservation_attempt` locks the trip and attempt, revalidates the organizer and same-trip item, then calls the canonical reservation RPC and marks the audit row confirmed in one PostgreSQL transaction. An error in either write rolls both back, preventing both inconsistent outcomes: a confirmed audit with an unlocked item, and a confirmed/locked item whose attempt remains active and blocks retry.

A partial unique index prevents two active attempts for one itinerary item. Regular transitions compare both the state and route index read with the values being replaced. The route index matters because advancing between two routes leaves the state `in_progress`; comparing state alone allowed two stale route-failure clicks to both report success. `failed` and `confirmed` are outside the active index. A handoff remains active because a confirmation may still arrive; the organizer must either confirm it or explicitly end it before retrying.

The confirmation transaction makes no provider or network call and holds locks only for database validation and updates. Browser navigation remains outside the transaction.

## Alternatives rejected

- Server-side POST to arbitrary booking URLs: venue forms have incompatible contracts, anti-bot controls, payment/consent steps, and this would create an SSRF and credential-handling surface.
- Mark confirmed when the organizer opens a route: navigation is not booking evidence.
- Reuse itinerary reservation columns: attempts can fail and contain private contact data, while canonical reservations are group-visible and protect the schedule.
- Expose contact details for collaboration: unnecessary disclosure when only the organizer may authorize the booking.
- Keep canonical confirmation first and the audit update second: either order can leave contradictory durable state when the second call fails; one database transaction is the smaller reliable boundary.
- Treat handoff as terminal failure: it would allow a second active workflow while the organizer may still return with valid evidence. Handoff stays active but now has an explicit end-and-retry action.

## PR #73 integration

PR #73 merged and deployed first, then PR #72 merged onto that master and deployed. The inherited TypeScript persistence wrapper sends the expanded `detailsSource` / `organizerVerified` contract, and `confirm_reservation_attempt` calls that ten-argument RPC explicitly with `detailsSource: "organizer"` and `organizerVerified: false`. Assistance already requires a provider reference, so that reference, not an unchecked verification box, grounds confirmation. PR #73's eight-argument wrapper remains only for rollback compatibility; assistance does not depend on it.

## Deployment and rollback

Production received PR #73's `20260824212000_reservation_proof_artifacts.sql`, PR #72's `20260826103000_reservation_assistance.sql`, and the follow-up `20260827081500_reservation_assistance_fk_indexes.sql` in that order before PR #72 deployed. The first assistance timestamp is deliberately later than PR #73's migration and guarantees that the ten-argument reservation RPC exists before assistance creates its transactional confirmation function. The follow-up keeps the trip-first indexes used by application reads while adding item-first and creator-first indexes that cover the composite foreign keys efficiently. Both assistance migrations, post-merge CI, the Vercel production deployment, and the production homepage were verified on 27 August 2026.

Roll back application code first. A dedicated rollback migration should then drop `confirm_reservation_attempt`, drop `reservation_attempts`, and remove `itinerary_items_id_trip_id_key` and `travelers_id_trip_id_key` if no later migration depends on them. Canonical reservation rows already confirmed by the feature remain valid and must not be deleted as part of rollback.

## Limitations

This MVP orchestrates browser-based booking routes; it does not submit provider APIs or forms itself. A future provider adapter may perform a true external submission only with a documented provider contract, idempotency key, explicit organizer approval, auditable response, and secure handling of payment or identity fields. Confirmation URLs are supported by the API but the initial UI asks only for the reference. Date display uses the browser locale; stored timestamps remain absolute instants.
