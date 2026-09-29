# Trip Planner Product Strategy

Last updated: 2026-08-14. Competitive research current as of 2026-08-11; see [Research basis](#research-basis).

## Decision summary

Trip Planner will not compete as a generic AI itinerary generator. That category is crowded and its core capabilities—prompt-based recommendations, maps, shared boards, and booking links—are becoming commodities.

Trip Planner will focus on **fair, adaptive group execution**:

> Everyone gets a voice. The group gets one realistic plan. When reality changes, the plan adapts without breaking what is already agreed.

The product should help a group:

1. capture each traveler's constraints and preferences;
2. understand how the shared plan balances them;
3. make decisions on proposed changes;
4. operate the itinerary while traveling; and
5. safely replan only what remains flexible.

## Market conclusion

The original concept is validated but not unique. Several products now combine AI itinerary generation with group collaboration:

- [Voyage Crew](https://www.voyagecrew.com/) publicly describes separate traveler preferences, real-venue recommendations, group voting, and day regeneration.
- [Vote-n-Venture](https://votenventure.com/) uses weighted individual preferences and AI group-itinerary synthesis.
- [PlanTogether](https://www.makeplantogether.com/) turns group votes into an AI schedule using opening hours, proximity, and weather.
- [Junto](https://junto.pro/) combines AI itineraries, shared editing, voting, bookings, and expenses.
- [Mindtrip](https://mindtrip.ai/) and [Pilot](https://www.pilotplans.com/) are broader AI-assisted collaborative planners.
- [Wanderlog](https://wanderlog.com/) is a mature collaborative itinerary incumbent, even though its AI is not clearly designed around explicit multi-person preference reconciliation.

Large platforms are also moving closer. Google can generate and share travel canvases, Airbnb is expanding shared trip planning, and Expedia has demonstrated an experimental group-chat travel assistant.

The resulting strategic conclusion is:

- **AI generation is not a moat.**
- **A shared itinerary is not a moat.**
- **Voting alone is not a moat.**
- **Trustworthy compromise plus safe adaptation during the trip is the wedge.**

Public competitor claims should be treated as directional until tested hands-on. The strategy should be reviewed quarterly because this category is moving quickly.

## Target customer and moment

### Primary group

Friends and families of roughly 3–8 people taking a multi-day city or regional trip, where:

- travelers have different interests, pace, dietary needs, mobility limits, or must-do activities;
- one organizer otherwise carries most of the planning burden;
- the group needs to make decisions before and during the trip; and
- real conditions regularly invalidate the original plan.

### Critical moment

The highest-value moment is not receiving the first generated itinerary. It is answering:

> What should this group do next, given what we agreed, what has already happened, and what changed?

Examples include rain, a delayed start, low energy, a closed venue, a missed activity, a reservation that cannot move, or a group that wants a nearby alternative.

## Product positioning

### Category

Adaptive group trip planner

### Product promise

Trip Planner builds a realistic shared plan from everyone's needs, explains the compromises, and safely adjusts the flexible remainder when the day changes.

### Reasons to choose Trip Planner

- Join from a private link without creating an account.
- Capture preferences and constraints separately for every traveler.
- Generate plans from verified real places rather than invented venues.
- See who and what each choice serves.
- Vote and suggest changes on the itinerary itself.
- Protect completed, skipped, booked, and organizer-locked activities.
- Preview changes before the shared plan is modified.
- Use the same product to run the trip, not only prepare it.

## Product principles

### 1. The plan is shared state

There is one canonical group plan. Suggestions, votes, previews, and applied changes must be distinguishable from that plan.

### 2. Hard constraints outrank preferences

Dietary safety, accessibility, reservations, dates, and other declared non-negotiables must not be averaged away by majority taste.

### 3. Fair does not mean identical

A good itinerary need not satisfy everyone in every slot. It should distribute meaningful wins across the trip and make the trade-offs visible.

### 4. AI proposes; the group remains in control

Condition monitoring may be proactive, but a recommendation must become a visible proposal before it changes shared state. Applying material schedule changes remains an explicit group or organizer action.

### 5. Change the smallest safe surface

Replanning should affect only the flexible remainder necessary to resolve the problem. Completed, skipped, booked, and locked activities are protected by default.

### 6. Grounding and reliability are product features

Named places must come from verified sources. Opening hours, travel time, weather, and reservation state should carry freshness and confidence where possible.

### 7. Explainability builds trust

Every generated plan and change proposal should explain which preferences, constraints, votes, conditions, and commitments shaped it.

## The group decision loop

The intended product loop is:

1. **Capture** — every traveler supplies interests, pace, dietary needs, constraints, must-dos, and vetoes.
2. **Synthesize** — the planner identifies shared interests, hard conflicts, and trade-offs.
3. **Propose** — AI produces a grounded itinerary or a minimal change proposal.
4. **Explain** — the group sees preference coverage, risks, protected commitments, and who is affected.
5. **Decide** — travelers vote, comment, or suggest an alternative under clear decision rules.
6. **Apply** — an authorized user confirms the accepted version.
7. **Execute** — Today Mode tracks the current activity, progress, conditions, and next decision.
8. **Learn** — done, skipped, rejected, and replaced activities improve later proposals without silently rewriting traveler preferences.

## Sequenced delivery plan

The product-level source of truth for status is [ROADMAP.md](../ROADMAP.md). The sequence below explains why each priority exists. The status notes are a convenience summary as of 2026-08-14; where they and the roadmap disagree, the roadmap wins.

### Priority 1 — Today Mode and partial-day replanning

Finish current-day orientation, progress, next activity, Done/Skip controls, weather and venue risks, travel-time estimates, and leave-by guidance. Then allow an organizer to preview and apply a minimal repair of only the unfinished, flexible remainder of today. Opening the trip must never regenerate or overwrite data, and replanning must preserve completed, skipped, booked, and locked activities.

This is an intentionally narrow first decision path: it uses the existing organizer confirmation so the product can validate live-trip value before the complete voting protocol is available.

**Status: shipped.** Today Mode, calendar date labels, live conditions, and organizer-confirmed partial-day repair are in production.

### Priority 2 — Transparent group fit and conflict resolution

Make the planning model inspectable and give the group explicit ways to resolve conflicts:

- distinguish hard constraints, soft preferences, must-dos, and vetoes;
- show preference coverage by traveler and across the group;
- identify unresolved conflicts and missing traveler input;
- explain why an activity or alternative was selected;
- expose the least-served traveler as well as the group average; and
- resolve conflicts by protecting a constraint, alternating wins, choosing a compromise, splitting temporarily, or deferring.

**Status: partially shipped.** The inspection half is in production — activity-level explanations from deterministic venue-category evidence, uncovered-interest visibility, constraint trade-offs, and group-balance summaries. The resolution half is not built: the group can now see a conflict but still has no structured way to settle one beyond voting a venue down.

### Priority 3 — Reservation reliability

Store booking status, time, references, links, attachments, and cancellation deadlines. Confirmed reservations lock automatically, cancellation consequences stay visible, and both become protected inputs to all later planning.

**Status: v1 shipped.** Booking status and time, confirmation details, cancellation-deadline awareness, automatic protection of active reservations, and safe lock release on cancellation are in production. Attachments, cancellation reminders, missing-information warnings, and reservation impact inside every schedule-change preview remain open as v2.

### Priority 4 — Standard adjustment workflow

Route every material adjustment—including Today Mode replans, swaps, suggestions, concierge recommendations, and organizer changes—through one workflow:

> proposal → impact preview → vote → apply

The preview combines current progress, live conditions, group fit, votes, and protected reservations. A proposal can change canonical itinerary data only after a valid group decision and authorized atomic application.

**Status: not started.** Each adjustment path — swap, reshuffle, partial-day repair, reservation change — still carries its own bespoke permission and confirmation rules.

### Priority 5 — Acceptance and follow-through measurement

Instrument whether the group previews, votes on, accepts, applies, follows, skips, or reverses a proposed revision. The key proof is not proposal volume; it is whether revised activities are actually followed and whether non-organizers participate in the decision.

**Status: not started.** The event names are named in the roadmap; nothing emits them yet.

### Next — Offline resilience

Cache the active itinerary and essential reservation information, display freshness, queue safe updates, and reconcile them after reconnecting.

**Status: not started.**

## Success measures

### North-star metric

**Percentage of active trip days on which at least one traveler uses Today Mode.**

This measures whether Trip Planner becomes useful during the trip rather than being abandoned after generation.

### Supporting measures

- Percentage of created trips with at least two joined travelers.
- Preference completion rate before first generation.
- Percentage of generated plans reviewed or voted on by at least two travelers.
- Time from detected disruption to accepted revised plan.
- Change-proposal vote completion and acceptance rates.
- Revised-plan follow-through: changed activities completed versus resolved as completed or skipped.
- Manual reversal rate within 24 hours of applying a proposal.
- Minimum and average traveler preference coverage.
- Number of protected-state violations; the target is zero.
- Repeat trips per organizer.

### Guardrails

- No completed, skipped, confirmed, or locked activity is moved without an explicit override.
- No material plan change is applied without a preview and authorization.
- No named venue is introduced without verified place data.
- Hard constraints are never silently relaxed.
- A group can always understand what changed and why.

## Validation plan

Each phase should be tested with real group trips before expanding scope.

1. Observe where the organizer still leaves Trip Planner for WhatsApp, Maps, weather, or notes.
2. Record the disruption, proposed response, decision time, and final action.
3. Interview at least the organizer and one non-organizer after the trip.
4. Check whether quieter members felt represented, not merely whether the organizer liked the plan.
5. Compare the planned itinerary with done, skipped, replaced, and abandoned activities.
6. Use the evidence to change decision rules and workflow before adding broad utilities.

## Explicit non-goals

Until the adaptive group loop is proven, Trip Planner should not prioritize:

- becoming a full flight, hotel, or package-booking engine;
- generic destination inspiration feeds;
- social-network or public-trip features;
- expense splitting and settlement;
- feature parity with every itinerary organizer;
- automatic schedule changes without group awareness;
- broad calendar and travel-document utilities that do not improve live execution.

These may become integrations or later paid utilities, but they are not the current reason to choose the product.

## Monetization hypothesis

Keep creating, joining, and basic planning free. Test a per-trip organizer upgrade for the capabilities most closely tied to live value:

- adaptive replanning;
- reservation reliability;
- proactive risk and morning briefs;
- offline access; and
- premium concierge usage.

A €5–10 per-trip test is a reasonable starting hypothesis based on public competitor pricing, but it is not yet evidence of willingness to pay. Validate it only after groups repeatedly use Today Mode.

## Research basis

This strategy is based on publicly available product material reviewed on 2026-08-11. In addition to the competitor pages linked above, the review used:

- [Google's travel-planning guidance for Canvas in AI Mode](https://blog.google/products-and-platforms/products/search/tips-prompts-ai-mode-canvas-travel-planning/)
- [Airbnb's 2026 shared-itinerary announcement](https://news.airbnb.com/airbnb-2026-summer-release/)
- [Expedia Group's Romie announcement](https://ir.expediagroup.com/news-and-events/news/news-details/2024/Put-Your-Trip-on-Autopilot-Expedia-Group-Introduces-New-Innovations-at-EXPLORE-to-Take-the-Stress-out-of-Travel-and-Enhance-Partner-Experience/default.aspx)
- [GroupTravelBench](https://arxiv.org/abs/2605.25200), which frames multi-person planning around preference elicitation, conflict coordination, utility, fairness, and feasibility
- [AlterAtlas](https://arxiv.org/abs/2607.16565), which supports iterative, persona-aware validation rather than one-shot itinerary generation

Public pages show positioning and claimed functionality, not proven product quality or adoption. Authenticated competitor workflows, customer interviews, pricing conversion, and retention were not independently verified.

## Review cadence

Review this strategy quarterly or after five meaningfully used group trips, whichever comes first. Reassess:

- whether travelers use the product during active trip days;
- whether fairness explanations change decisions or trust;
- which competitors have demonstrated real adoption rather than only marketing claims;
- whether the adaptive loop improves outcomes; and
- whether any deferred utility has become necessary to support the core loop.
