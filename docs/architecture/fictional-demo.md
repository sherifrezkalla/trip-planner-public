# Fictional interactive demo

## Decision and constraint

New visitors need to try a group decision without installing providers or joining a maintainer's trip. `/demo` uses authored fictional stops and a small in-memory reducer. It has no trip ID, bearer credential, database client, API call, browser storage or agent connection. Reload or Reset restores the fixture; visitors cannot affect one another. Normal page/asset requests still reach the host.

A public link to a writable production trip was rejected: it would expose join/edit access and allow provider spending. Mocking production API routes was also rejected because it would introduce demo exceptions into authorization paths. Instead, the demonstration is isolated from the real trip board. It reuses the pure production vote tally so one-person-one-vote and the majority threshold agree with the app.

## Behavior and limits

The visitor switches among three fictional travelers, previews a removal, explicitly opens a request, and tries group voting or organizer approval/rejection. The itinerary changes only on acceptance. Completing the target while its request is pending cancels that request. The example's completed breakfast and dinner reservation stay protected. Other completion advances the next planned stop. Reset clears role, votes, proposal and progress.

This is a teaching surface, not the production dashboard or the planned V2 mobile companion. Its authored itinerary, scenario, weather premise and reservation are illustrative. Role switching is a demo affordance, never a production identity mechanism. It does not demonstrate real generation, collaboration across devices, venue availability, persistence, bookings, current-day timing, maps or provider behavior. The demo's fixed protected stops and single removal scenario do not represent the full API's authorization/state machine.

README, the documentation index, project tour and homepage link to the demo. The source can run `/demo` after `npm ci` and `npm run dev` without `.env.local`; normal application features still require the documented infrastructure. The maintained demo URL is an example deployment, not a hosted-service commitment.

## Validation and release

Reducer tests cover preview/discard isolation, duplicate and changed votes, majority acceptance/rejection, organizer-only decisions, completed-target invalidation, protected stops and reset. Run the full test suite, lint and build. Check the rendered demo through both decision paths, reload/reset, keyboard controls and narrow layout. The build must prerender `/demo` without credentials.

Release status is recorded in ROADMAP after production verification. No schema, environment or agent configuration changes. Roll back by reverting this feature PR and restoring the previous deployment; no data cleanup is needed.

### Local acceptance record — 2026-10-01

- 1,254 Vitest tests (including ten demo cases) and 16 script tests passed; lint and production build passed.
- Browser checks passed for preview without mutation, duplicate vote handling, two-traveler acceptance, keyboard-driven organizer approval, organizer rejection, completed-target cancellation, progress, Reset and reload.
- Desktop and 390px-wide layouts inspected; the narrow viewport had no horizontal overflow.
- Synthetic screenshots: [desktop preview](images/fictional-demo/desktop-preview.png), [mobile preview](images/fictional-demo/mobile-preview.png).
- No live agent, real trip, model, venue or booking operation was exercised.


### Production acceptance record — 2026-10-01

Public [PR #10](https://github.com/sherifrezkalla/trip-planner-public/pull/10) merged at `fd7fc719df14fb952d48e5ce1a13d45d2b7c85de`. Vercel production deployment `dpl_7iatNacssQioHpeFX74Xi91hFfzB` reached READY for that exact source and the canonical domain.

The public `/demo` loaded without joining a trip or providing credentials. Browser checks passed for preview, two-traveler acceptance, organizer approval, reset and reload. Only the in-page sample changed. No live-provider acceptance is implied by this release.
