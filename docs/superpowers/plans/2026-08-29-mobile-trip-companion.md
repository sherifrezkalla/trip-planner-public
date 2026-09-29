# Mobile Trip Companion and Organizer Controls Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the default traveler dashboard with a fast, contextual mobile companion centered on today, the next stop, one pending decision, and WhatsApp, while preserving the existing advanced board for verified organizers.

**Architecture:** `/t/[slug]` loads a new privacy-minimized companion API and renders the smallest useful current-trip view. Deep-link focus selects a canonical item, proposal, or organizer action without adding navigation menus. A dominant WhatsApp action opens a direct chat with the configured trip-agent number when available, or opens WhatsApp generically with the group label and a copied prompt. `/t/[slug]/manage` retains `TripBoard` but displays it only after the current traveler is verified as organizer; all writes remain protected server-side.

**Tech Stack:** Next.js 16 App Router, React 19 client components, TypeScript, Tailwind 4, existing device-trip token storage, Today Mode helpers, proposal/reservation APIs, Supabase Realtime, Vitest, React server rendering for presentational tests, manual mobile browser/accessibility verification.

**Spec:** `docs/superpowers/specs/2026-08-29-whatsapp-first-trip-agent-v2-design.md`

## Global Constraints

- Complete and production-verify the gateway, connector, and proactive plans first so the WhatsApp-first path exists before the dashboard is demoted.
- Start from verified GitHub `master` on `codex/mobile-trip-companion`; inspect open PRs before editing.
- Read the Next.js 16 local docs for pages/layouts, server/client components, metadata, and Route Handlers before changing routes.
- The companion is a responsive mobile web surface for the first release, not a native iOS/Android build and not an offline PWA. Do not silently expand scope.
- Ordinary travelers see no menus, connector configuration, authority policy, action history, advanced itinerary editing, private reservation identity, or raw participant mappings.
- Keep the existing trip link, metadata card, traveler token, join flow, and API authorization compatible. Existing shared links must continue to work.
- Every focused object comes from the authenticated canonical response. A query-string ID never authorizes or supplies data.
- Preserve the advanced board until every organizer operation has a safe agent/mobile replacement; do not delete V1 components in this plan.

---

## File responsibility map

| File | Responsibility |
|---|---|
| `lib/trip-companion.ts` | Companion types, data mapping, priority/focus selection, WhatsApp URL/prompt helpers |
| `app/api/trips/[slug]/companion/route.ts` | Authenticated minimized traveler/organizer payload |
| `components/TripCompanion.tsx` | Token attach/load/realtime shell and overall mobile layout |
| `components/CompanionToday.tsx` | Trip phase, next stop, leave-by, weather/hours warning, compact timeline |
| `components/CompanionDecision.tsx` | One highest-priority proposal/vote/organizer confirmation |
| `components/AskTripAgentButton.tsx` | Dominant WhatsApp handoff with direct/generic fallback |
| `components/OrganizerTripControls.tsx` | Connection state, pending confirmation, pause/revoke, manage-board link |
| `app/t/[slug]/page.tsx` | Shared link now renders `TripCompanion` and preserves metadata |
| `app/t/[slug]/manage/page.tsx` | Advanced organizer route rendering guarded `TripBoard` |
| `docs/architecture/mobile-trip-companion.md` | Product/UI boundary, deep links, privacy, fallback, retained limitations |

## Companion payload contract

`GET /api/trips/[slug]/companion` uses `x-trip-token` and returns:

```ts
type TripCompanionPayload = {
  trip: {
    slug: string;
    title: string;
    destinationName: string;
    startDate: string;
    endDate: string;
    dayCount: number;
    phase: "before" | "during" | "after";
    dayIndex: number;
    dateLabel: string;
  };
  me: { id: string; isOrganizer: boolean };
  today: {
    progress: { done: number; skipped: number; remaining: number };
    next: CompanionItem | null;
    items: CompanionItem[];
    weather: GroupSafeWeatherState;
    hoursRisk: GroupSafeHoursRisk | null;
    leaveBy: GroupSafeLeaveBy | null;
  };
  decision: CompanionDecision | null;
  agent: {
    available: boolean;
    status: "unconfigured" | "paired" | "active" | "paused" | "offline" | "revoked" | "archived";
    phoneE164: string | null;
    groupLabel: string | null;
    lastSeenAt: string | null;
  };
  organizer?: {
    pendingConfirmation: OrganizerConfirmationSummary | null;
    recentActionCount: number;
    proactivePaused: boolean;
  };
};
```

`CompanionItem` includes only ID, day/block/position, status, name, area, duration, Maps URL, coordinates, public reason, reservation status/time/deadline, and locked/travel-warning flags. It excludes confirmation number, booking contact, artifacts, private assistance routes, traveler preferences, vote identities, and action payloads. The optional `organizer` block is returned only when `me.isOrganizer` is true.

## Decision priority

Only one decision is expanded:

1. Organizer consequential confirmation expiring in under 30 minutes.
2. The current viewer's open vote on a proposal affecting today.
3. Organizer decision on an open proposal affecting today.
4. Any open proposal affecting today.
5. Current viewer's open vote on another day.
6. Organizer decision on another open proposal.

Other decisions appear only as “N more waiting” linking to the advanced organizer board for organizers; ordinary travelers can move through them with Previous/Next inside the same decision card, not a menu.

## Task 1: Extract stable board/companion types and selection rules

**Files:**

- Create: `lib/trip-companion.ts`
- Create: `lib/__tests__/trip-companion.test.ts`
- Modify: `components/TripBoard.tsx`
- Modify: `components/TodayMode.tsx`
- Modify: `components/PendingRequests.tsx`

- [ ] Write failing tests for before/during/after phase, ordered timeline, next item, progress, exact decision priority, deep-link focus (`item:uuid`, `proposal:uuid`, `action:uuid`), invalid/cross-payload focus ignored, and organizer-only fields.
- [ ] Move shared board item/proposal/trip types out of the 1,500-line `TripBoard.tsx` into the new module without changing V1 runtime behavior. Re-export/adapt `PendingProposal` temporarily if needed to keep imports stable.
- [ ] Implement pure `selectCompanionDecision`, `selectFocusedCompanionObject`, `toCompanionItem`, and `companionProgress`. Reuse `today.ts` functions rather than reimplementing block/date logic.
- [ ] Run the new tests plus `lib/__tests__/today.test.ts`; commit the no-behavior-change extraction.

## Task 2: Add the minimized companion API

**Files:**

- Create: `app/api/trips/[slug]/companion/route.ts`
- Create: `app/api/__tests__/trip-companion-route.test.ts`
- Modify: `lib/trip-agent-read-model.ts`

- [ ] Create route fixtures containing every sensitive reservation/connection/mapping/action field and write failing assertions for the payload contract and exclusions above.
- [ ] Add failure tests for missing/invalid token, missing trip, database outage for each required read, weather provider unavailable, and traveler/organizer response differences.
- [ ] Reuse the Plan 1 group-safe read model for trip/today/proposals. Add organizer-only queries for one redacted pending confirmation and redacted connection health; do not reuse the full board payload and filter it after serialization.
- [ ] Fetch current weather server-side with the existing Open-Meteo parser and a short timeout. Represent `unavailable` explicitly and do not fail the whole companion when weather fails.
- [ ] Set `Cache-Control: private, no-store`. The response contains traveler-specific vote/capability state and must not be shared by a cache.
- [ ] Run focused route/read-model tests and commit.

## Task 3: Build the Today/next-stop presentation

**Files:**

- Create: `components/CompanionToday.tsx`
- Create: `lib/__tests__/companion-presenters.test.tsx`

- [ ] Render presentational fixtures with `react-dom/server` and assert one `<main>`, one page `<h1>`, date/day status, next venue, leave-by, Maps link, timeline, reservation status/time, weather/hours warnings, and accessible labels.
- [ ] Implement mobile-first states:
  - before trip: countdown, first-day preview, Ask WhatsApp;
  - during trip: next stop dominates, then leave-by/route, warning strip, compact timeline;
  - after trip: completion summary and final-day timeline.
- [ ] Timeline rows show status, block label, venue, area, reservation time when group-safe, and Maps. They do not expose edit controls; Done/Skip remains available only if the approved companion scope explicitly retains it through existing protected APIs. Default this plan to read-only timeline because the agent is the operating interface.
- [ ] Weather/hours data states must say live/regular-hours source and retrieval time or `unavailable`; never show a reassuring blank.
- [ ] Keep primary content usable at 320 px width, 200% zoom, and with long German/French names.
- [ ] Run presenter tests and commit.

## Task 4: Build the contextual decision and confirmation card

**Files:**

- Create: `components/CompanionDecision.tsx`
- Modify: `lib/__tests__/companion-presenters.test.tsx`
- Modify: `lib/trip-agent-wording.ts`

- [ ] Add rendered tests for traveler vote, organizer proposal decision, expiring organizer confirmation, stale/cancelled refresh, busy state, error state, and “N more waiting.”
- [ ] Reuse `describeProposal` facts/wording so WhatsApp and companion name the same change. Show proposed change, reason, requester, yes/no/needed, reservation/travel impact when present, and expiry.
- [ ] Vote buttons call the existing proposal vote route. Organizer approve/reject calls the existing decision route. Consequential confirm/reject calls the Plan 1 confirmation endpoint with the organizer's existing `x-trip-token`; the action ID comes only from the authenticated organizer payload and never serves as authority by itself.
- [ ] After any decision, refetch the companion before announcing success in the UI. Stale/conflict responses say the plan changed and show current truth.
- [ ] Deep-linked proposal/action receives focus and a temporary highlight, but only if it exists in the authenticated payload.
- [ ] Run presenter/route tests and commit.

## Task 5: Implement the dominant WhatsApp handoff

**Files:**

- Create: `components/AskTripAgentButton.tsx`
- Modify: `lib/trip-companion.ts`
- Modify: `lib/__tests__/trip-companion.test.ts`

- [ ] Add failing URL tests for valid E.164, missing phone, invalid phone, iOS/Android generic fallback, correct URL encoding, no token/slug secret in message text, and contextual prompts for today/item/proposal/action.
- [ ] Implement direct link `https://wa.me/<digits>?text=<encoded prompt>` only when a configured agent phone exists. Strip `+` for `wa.me`; reject any other characters.
- [ ] Without a number, copy a short contextual prompt to the clipboard and open `https://wa.me/?text=<encoded prompt>`. Display “Open WhatsApp and return to <group label>” when a label exists. Do not promise to open an existing private group because WhatsApp provides no dependable public group deep link.
- [ ] Default prompts are factual and short: “What is our plan today?”, “Tell us about <venue>”, “Help us decide this trip change”, or “Show the organizer confirmation.” No traveler token, private data, or raw IDs appear.
- [ ] The button label is always “Ask the trip agent in WhatsApp”; when the agent is paused/offline/unconfigured, show status and keep a secondary “View today here” path rather than a dead button.
- [ ] Run tests and commit.

## Task 6: Build the companion shell and realtime refresh

**Files:**

- Create: `components/TripCompanion.tsx`
- Modify: `app/t/[slug]/page.tsx`
- Modify: `lib/device-trips.ts`

- [ ] Reuse the existing device-trip token lookup/attach flow. Add failing device-trip tests for the same shared link/token working after the page component changes.
- [ ] Implement loading, attach/join, authenticated, retryable outage, and invalid-token states. Do not introduce accounts or cookies in this plan.
- [ ] Fetch only `/api/trips/[slug]/companion` with `x-trip-token`; subscribe to the existing trip realtime channel and debounce refetch after canonical updates. Poll every 60 seconds only during an active trip to keep leave-by/status fresh.
- [ ] Render one column: compact trip header, `CompanionToday`, `CompanionDecision` when present, sticky `AskTripAgentButton`, and organizer controls only for organizer.
- [ ] Preserve `generateMetadata` in `app/t/[slug]/page.tsx` and its noindex/privacy behavior. Change only the rendered component from `TripBoard` to `TripCompanion`.
- [ ] Run device/route tests, lint, build, and commit.

## Task 7: Move the advanced board behind the organizer path

**Files:**

- Create: `app/t/[slug]/manage/page.tsx`
- Create: `components/OrganizerBoardGate.tsx`
- Modify: `components/TripBoard.tsx`
- Create: `lib/__tests__/organizer-board-gate.test.tsx`

- [ ] Write rendered tests for loading, organizer allowed, traveler refused with return link, invalid token, and service outage.
- [ ] `OrganizerBoardGate` authenticates through the companion or board API before rendering `TripBoard`. A traveler who guesses `/manage` sees “Organizer controls only” and a link back; no board data should be painted before the check.
- [ ] Keep server-side API permissions as the real boundary. The client gate is presentation/privacy defense, not authorization.
- [ ] Add “Manage full trip” only inside organizer controls. Do not add it to traveler layout or primary navigation.
- [ ] Remove duplicate top-level Today Mode from `TripBoard` only if the organizer board would otherwise fetch/render it twice; retain all advanced controls and their current tests.
- [ ] Run gate, board API, lint, and build; commit.

## Task 8: Add protected organizer controls to the companion

**Files:**

- Create: `components/OrganizerTripControls.tsx`
- Modify: `components/TripCompanion.tsx`
- Modify: `components/AgentConnectionSetup.tsx`

- [ ] Render compact organizer states for active/paired/paused/offline/revoked, next pending confirmation, proactivity paused, pause/resume, revoke, and “Manage full trip.”
- [ ] Keep pairing, rotation, participant mappings, authority editing, and full history in the advanced setup surface at `/manage`; the companion links there instead of duplicating the forms.
- [ ] Pause/resume requires one tap plus current-state refetch. Revoke requires explicit confirmation naming the trip and saying the connector stops immediately.
- [ ] A pending consequential confirmation displays exact impact/expiry but private reservation contact only to the organizer. Reject is always available. Confirm is disabled after expiry or state drift.
- [ ] Add presenter tests and commit.

## Task 9: Verify deep links, accessibility, and mobile behavior

**Files:**

- Modify: `components/TripCompanion.tsx`
- Modify: `docs/connectors/trip-agent-group-prompt.md`
- Modify: `lib/trip-agent-wording.ts`

- [ ] Ensure every gateway/proactive result deep link uses `/t/<slug>?focus=item:<id>`, `proposal:<id>`, or `action:<id>`, and connector wording includes it only when the result contains it.
- [ ] Verify with a local/deployed browser at 320×568, 390×844, and 430×932; capture before/after screenshots for traveler today, decision, organizer confirmation, agent paused, pre-trip, and completed-trip states.
- [ ] Keyboard test all actions; confirm visible focus, 44×44 px touch targets, semantic headings/landmarks, contrast, screen-reader button names, reduced-motion behavior, no horizontal scroll, and 200% zoom.
- [ ] Test slow 3G and failed weather/realtime/connector states. The canonical schedule must still render when nonessential providers fail.
- [ ] Test WhatsApp installed and not installed. Verify direct-number and generic fallback text, with no credential/token/private field in the URL or clipboard.
- [ ] Commit any corrections.

## Task 10: Document, validate, deploy, and verify the transition

**Files:**

- Create: `docs/architecture/mobile-trip-companion.md`
- Modify: `README.md`
- Modify: `ROADMAP.md`

- [ ] Document why the shared link changed, companion payload/privacy, decision priority, focus links, WhatsApp fallback, organizer gate, retained V1 board, responsive-web limitation, and why native/PWA/offline are deferred.
- [ ] Update README screenshots/copy so travelers are told WhatsApp is primary and the companion is for current truth/maps/decisions. Link organizer instructions to `/manage` without exposing it as traveler navigation.
- [ ] Update roadmap as implemented but not shipped; keep first-party WhatsApp, native apps, offline/PWA, and removal of the advanced board explicitly open.
- [ ] Run privacy/placeholder scans, `npm test`, `npm run lint`, and `npm run build`.
- [ ] Push/open a PR with user/developer impact, no migration, deployment/rollback (restore `TripBoard` in shared page), validation, accessibility, and material UI screenshots.
- [ ] Merge through GitHub, deploy, and verify an existing synthetic shared link on real phones for organizer, mapped traveler, unmatched participant, and invalid token.
- [ ] From a real WhatsApp group, open item/proposal/action links, vote, confirm as organizer, pause agent, and return to today. Verify the advanced board remains organizer-only and every legacy organizer operation still works.
- [ ] Only after production verification update `ROADMAP.md` in the same turn/PR to mark the mobile companion shipped and the V2 shared-link transition complete.
