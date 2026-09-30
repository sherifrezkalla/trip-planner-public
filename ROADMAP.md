# Trip Planner Roadmap

Last updated: 2026-09-30

This roadmap is the product-level source of truth. A feature is marked **shipped** only after it is merged, migrated when necessary, deployed, and verified in production.

## Product direction

Trip Planner should win through **collaborative, adaptive trip execution**: helping a group decide what to do and safely adjust while the trip is underway. It should not become a broad booking engine or duplicate every standalone travel utility.

The approved V2 direction makes the organizer's shared WhatsApp agent the primary in-trip interface. One organizer-supplied OpenClaw or Hermes agent will operate the planner through a controlled gateway, while a simplified mobile companion shows today's plan, the next stop, maps, and contextual decisions. The Trip Planner remains the source of truth and the organizer remains the human owner. The gateway foundation shipped on 2026-09-22; the overall V2 and WhatsApp release are not shipped. See [the WhatsApp-first Trip Agent V2 design](docs/superpowers/specs/2026-08-29-whatsapp-first-trip-agent-v2-design.md).

The reasoning behind this direction — market analysis, positioning, product principles, non-goals, and why the priorities below are sequenced as they are — is in [docs/product-strategy.md](docs/product-strategy.md). This roadmap remains the source of truth for status.

## Shipped

- Collaborative trip creation and private-link joining
- Traveler preferences, constraints, dietary needs, and pace
- AI itinerary generation grounded in Google Places
- Regional planning and per-day map views
- Voting, vote-gated swaps, and organizer controls
- Member place suggestions included in itinerary regeneration
- Trip-aware AI concierge using DeepSeek V4 Flash
- Activity states: planned, done, skipped, and organizer-locked
- Preview-first smart reshuffling that preserves history and locked plans
- Today Mode with calendar date labels, live weather, venue-hours risk, leave-by guidance, current-day progress, and explicit unavailable states
- Organizer-confirmed partial-day running-late repair using group votes, regular hours, protected activity state, atomic apply, and audit history
- Transparent preference coverage with activity-level explanations, uncovered-interest visibility, constraint trade-offs, and group-balance summaries
- Reservation Reliability v1 with booking status and time, confirmation details, cancellation-deadline awareness, automatic protection of active reservations, safe lock release on cancellation, and exact reservation-time guidance in Today Mode
- Mid-trip editing: organizer-picked single-activity moves, remove and put back, removed stops collapsed out of the day, and lighter generated days that require only dinner
- Group change protocol: any traveler proposes a move or removal, the organizer approves or turns it down instantly, a proposal also applies once more than half the travelers agree, stale proposals cancel themselves with a stated reason, and everyone sees the queue
- Organizer Telegram alerts: the organizer links a Telegram chat and is messaged when a request opens, when the group applies one without them, and when a request cancels itself, with Approve and Turn down as buttons; no email or phone number is stored
- Automated travelers are flagged and excluded from the vote denominator, from the count of people who could disagree in a vote-gated swap, and from preference coverage, so an assistant that rejoins daily cannot push a group majority out of reach
- Generation that holds up against real venue data: venue lookup and model arrangement split across two requests, day-trip areas budgeted to trip length, towns the group asked for promoted into that area list, per-day options pre-filtered for area, opening hours and slot before the model chooses, a day whose area cannot serve dinner reverting to the base, one shared venue-alias map so a correct answer cannot be mistranslated, a reserved attempt slot so the stronger model is always tried, and an honest failure when no model can produce a valid plan. Production generation behavior was verified; private trip details are intentionally omitted. See [docs/architecture/itinerary-generation.md](docs/architecture/itinerary-generation.md).
- Traveller arrival and departure dates, inclusive at both ends, with the day view naming anyone who is not there. Unset means present throughout and is deliberately not backfilled. Nothing plans around them yet. See [docs/architecture/traveller-dates.md](docs/architecture/traveller-dates.md).
- Weather-adaptive planning, built to run on the cheap model rather than a frontier one: venue exposure classified once per venue and cached, a multi-day forecast taken per area, a deterministic scan that ranks indoor replacements by what is worth going to rather than what is open, and a `replace` proposal kind so a substitution reaches the group with its reason attached. The organiser previews; nothing is raised without a second, deliberate press. Verified in production 19 Aug 2026. See [docs/architecture/weather-adaptation.md](docs/architecture/weather-adaptation.md).
- The public destination search is bounded: a same-host origin is required and each caller is capped, because it proxies a billed Google Places call and cannot require a trip token. See [docs/architecture/public-endpoint-limits.md](docs/architecture/public-endpoint-limits.md).

## Open product decisions

- **How should a week be paced?** Day trips are assigned nearest-first to alternate days, so a 7-day trip takes at most three however many areas exist. Requested towns beyond the third nearest sit in the venue pool, available for swaps, without a day of their own. This is now the largest remaining gap between what a group asks for and what it gets.

## Decided and shipped

- **A place the group asks for is somewhere they go.** Decided 17 Aug 2026: a suggestion naming a town goes to the area proposal instead of being searched as a venue near the base, which could return a local business whose name matched the requested town instead of planning a visit to that town. The area budget now caps only the areas the model adds of its own accord.
- **Generation is allowed to fail.** Decided 17 Aug 2026: the deterministic assembly is removed. It produced a valid plan when both models failed, but ranked on rating alone and returned 200 exactly like a real success, so a group could be handed a mechanical itinerary without being told. Failures now report why, next to the button that was pressed.

## Gateway foundation — shipped 2026-09-22

### Trip-agent gateway and authority foundation (Plan 1)

- Implemented: one trip-scoped connector, organizer lifecycle and participant-mapping APIs, modern POST-only MCP, group-safe reads, structured research, expiring previews, idempotent protected changes, human votes/decisions, private reservation-draft confirmation, and announcement receipts. See [gateway architecture](docs/architecture/trip-agent-gateway.md).
- Shipped through PR #87 (private development record): review, 1,156 tests, lint/build, PostgreSQL concurrency CI, both production migrations, access-control checks, and deployment verified. A disposable production trip passed pairing, exact twelve-tool inventory, group-safe reads, unmatched-write refusal, one organizer move with exact replay, and immediate revocation. Guarded cleanup verified zero trip-owned remnants. See [release evidence](docs/architecture/trip-agent-gateway-release.md).
- The dedicated Routes key is unavailable; live driving research explicitly reports `unavailable`. Today uses UTC until a destination time zone can be persisted and passed through the tool.
- Plan 2 adds the organizer setup surface described below; live WhatsApp/OpenClaw/Hermes verification remains open. Proactive monitoring is Plan 3; the mobile companion is Plan 4.

### Connector onboarding (Plan 2) — operator preview shipped 2026-09-26; live providers open

- Organizer-only setup card: expiring pairing code, participant confirmation, explicit permission review, privacy-notice guidance, pause/resume, one-time credential rotation, revoke, redacted action history, and recovery guidance.
- Current-source OpenClaw/Hermes configuration templates, canonical group behavior/notice, and credential-safe read-only MCP/setup verification commands. No new migration. See [connector architecture](docs/architecture/trip-agent-connectors.md).
- PR #89 (private development record) merged and deployed. Production checks on an exact disposable trip passed pairing, registration/mapping, synthetic activation, active reads without setup scope, pause/resume, immediate old-credential rejection after rotation, preserved readiness evidence, and immediate revocation. Guarded cleanup verified no trip-owned remnants. Deployed UI role visibility was checked with synthetic browser responses. See [release evidence](docs/architecture/trip-agent-connectors-release.md).
- Hermes activation milestone verified 2026-09-27: installed 0.21.5 transport discovered the twelve tools and passed readiness; a trusted provider event supplied group/sender identity, the organizer confirmed mapping, and the real privacy-notice receipt was used for production activation and a canonical read. A dedicated profile uses the existing WhatsApp bridge; unrelated standalone services were preserved. See [operator evidence and limitations](docs/architecture/trip-agent-connectors-release.md#hermes-activation-checkpoint--2026-09-27).
- **Not shipped as a working WhatsApp integration.** One real Hermes read-only group conversation was verified on 2026-09-30 after model access recovered. Remaining live-trip acceptance checks are deferred until a live trip; they are not recorded as passed. Both providers still need the live group matrix: restrained replies, further sender mapping, change delivery receipts, exact action retries, pause/revoke, and provider outage recovery; OpenClaw also needs installed-runtime protocol verification. Hermes native polls require individual-sender vote evidence; poll totals alone cannot vote.
- Provider credentials and WhatsApp sessions remain organizer-operated. Proactive monitoring and the simplified mobile companion are not included in this preview.

## Next

### WhatsApp-first Trip Agent V2

- Expose the existing trip engine to one organizer-supplied OpenClaw or Hermes agent through a trip-scoped, permissioned, audited gateway
- Make the WhatsApp group the primary traveler interface for trip questions, recommendations, changes, votes, confirmations, and restrained proactive alerts
- Replace the complex traveler dashboard with a contextual mobile companion for today, the next stop, maps, and pending decisions
- Preserve explicit organizer confirmation for bookings, payments, cancellations, private data, and permission changes
- Status: design approved on 2026-08-29; Plan 1 shipped on 2026-09-22 as recorded above. Plans 2–4 and the full WhatsApp-first V2 remain unshipped.

### Concierge itinerary lookup

- Answer named-stop and EN/FR/DE group locator questions from the stored itinerary before external search, while keeping generic restaurant and boat-trip discovery prompts on Google Places *(shipped 2026-08-27 via PR #76; post-merge CI, production deployment, and homepage verified)*

### Adjust today reconciliation

- **Adjust today reconciliation:** organizer-only current-day natural-language constraints are parsed into deterministic bounded rules; activity categories prevent a request such as museums from disturbing meals or already-matching stops, unchanged planned stops reserve their slots, and same-preview vacancies can be reused. Replacements come only from the trip's verified venue pool and stored regular hours, and apply their venue-derived reason, duration, area, and recomputed travel warnings together. Preview/apply/abandon events are recorded atomically with the plan revision; the first later done/skip/change on a revision-marked item is attributed to that accepted revision, while ordinary edits produce no follow-through event. Stale snapshots, duplicate apply, authorization, protected rows, occupied destinations, and tampered payloads are server-validated. Accepted revisions are group-visible with reason and actor. *(shipped 2026-08-27 via PR #77; migration, post-merge CI, production deployment, and homepage verified)*

### Concierge outcomes into group planning

- Let travelers send an eligible named concierge result to the shared suggestion list
- Keep concrete itinerary replacements in the existing slot-targeted proposal and vote flow; concierge results do not yet carry enough data to create one safely

### Reservation Reliability v2

- Private proof attachments with organizer-only signed transfer, filename-safe traveler provenance, organizer verification, server-validated duplicate protection, and durable replacement/removal cleanup *(shipped 2026-08-26 via PR #73; migration and production deployment verified)*
- Automated cancellation reminders
- Missing reservation-information warnings
- Organizer-approved reservation assistance MVP: private request details, explicit approval, route/fallback progression, acceptable-time selection, precise handoff, and reference-gated atomic confirmation *(shipped 2026-08-27 via PR #72; both migrations, post-merge CI, production deployment, and homepage verified)*
- Reservation impact in every schedule-change preview

### Proposal → impact preview → vote → apply

- Make every group adjustment a named proposal with a visible owner and reason
- Preview schedule, preference, reservation, and cancellation impact before voting
- Record votes and apply only the accepted reviewed version

### Revised-plan outcome measurement

- Measure preview-to-acceptance rate and time to an accepted revision
- Measure whether the group completes, skips, or changes the revised activities
- Compare accepted revisions with actual follow-through without claiming causation

### Group change protocol follow-ups

- Show the impact of a proposed change: reservations, travel time, and preference coverage
- Show settled requests, which are recorded with their resolution but not yet surfaced

### Acting on who is actually there

- Generation, reshuffling and preference coverage still treat the group as uniformly present
- A weather substitution can serve a preference belonging to someone who has already flown home
- Decide how a late arrival should be treated when it lands after the last block of the day

### Weather adaptation follow-ups

- Nothing re-runs the scan; a proposal raised a week out keeps its original reasoning
- Re-validate anything raised beyond three days, where forecast skill drops sharply
- Venue categories are unreliable — a Picasso museum is filed under `history`, so art
  coverage reads zero even when art is on the plan

### Morning brief

- Morning brief summarizing timing, weather, reservations, and backup options

### Offline resilience

- Cache the active itinerary and essential reservation details
- Clearly label stale data
- Queue safe user updates and reconcile them after reconnection

## Later / validate first

- Flight and hotel import
- Shared trip expenses and multi-currency settlement
- Calendar export and subscription

## Product measurement

Before expanding the roadmap, instrument these lifecycle events:

- `trip_created`
- `member_joined`
- `suggestion_added`
- `plan_generated`
- `today_mode_viewed`
- `concierge_asked`
- `activity_done`
- `activity_skipped`
- `reshuffle_previewed`
- `reshuffle_applied`
- `partial_day_replan_previewed`
- `partial_day_replan_applied`

Primary success metric: **percentage of active trip days on which a traveler uses Today Mode**.

Supporting metrics: time from disruption to an accepted revised plan, reshuffle acceptance rate, trips with at least two active members, and repeat trips per organizer.

## Public-release preparation

Beginner, hosting, contribution, security, and optional-agent guides separate ordinary app use from technical installation. Source fixtures use fictional identities, private operational notes are excluded, and the MIT license is included. Hosting and agent installation still need technical help; a no-code installer is not shipped.

Source cleanup does not sanitize previous commits, PRs, issues, or account metadata. Publication remains a separate owner decision following the [release checklist](docs/public-release.md). See [architecture and limitations](docs/architecture/public-release-readiness.md).

## Public source distribution

The public repository begins with a reviewed source snapshot and fresh history. Beginner, self-hosting, contribution, and optional agent guides are included. Hosting still requires technical setup, and real-group agent verification remains incomplete. See [public-source readiness](docs/architecture/public-release-readiness.md).

## Guided agent onboarding — deployed preview

The organizer card presents five setup stages, plain-language next steps, a credential-free brief for a capable existing assistant/operator, and a path for organizers who do not yet have an agent. Advanced configuration remains available on demand. Pairing secrets stay separate from the copied brief; identity, access and actual notice delivery remain required. A first-question prompt is optional, and deferred live-trip checks do not become passing checks. See [guided onboarding architecture](docs/architecture/guided-agent-onboarding.md).

This is an app-side implementation, not a no-code installer or hosted-agent service. Public PR #5 was deployed to the existing production installation on 2026-09-30. Homepage and existing-trip join-page checks passed. A fictional trip then verified the authenticated organizer card, its five stages, and the canonical setup brief on 2026-09-30. The app-side guided preview is shipped; provider pairing and broader live-trip acceptance remain separate checks. A capable local assistant or technical operator still performs secure provider setup.
