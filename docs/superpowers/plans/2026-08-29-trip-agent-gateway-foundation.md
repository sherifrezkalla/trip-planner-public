# Trip Agent Gateway and Authority Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a secure, provider-neutral MCP gateway that lets one organizer-supplied agent read, research, preview, propose, vote, confirm, and perform bounded trip actions through the existing Trip Planner rules.

**Architecture:** A trip-scoped bearer credential authenticates `/api/mcp`. A fresh MCP server is created per request, resolves one active connection, and passes typed tool calls to pure authority and action services. Durable action rows provide idempotency, preview expiry, confirmation, result, and announcement audit. Existing `createPlanProposal`, `settleProposal`, reservation assistance, itinerary lookup, Places search, and atomic database RPCs remain authoritative.

**Tech Stack:** Next.js 16 Route Handlers, TypeScript 5, Zod 4, Supabase/PostgreSQL, `@modelcontextprotocol/server@2.0.0`, Vitest, PGlite, Google Places and Routes APIs.

**Spec:** `docs/superpowers/specs/2026-08-29-whatsapp-first-trip-agent-v2-design.md`

## Global Constraints

- Read `docs/superpowers/plans/2026-08-29-whatsapp-first-v2-plan-index.md` first; its shared contracts are normative.
- Start from verified GitHub `master` on branch `codex/trip-agent-gateway-foundation`; check open PRs before editing.
- Read `node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md` and `node_modules/next/dist/docs/01-app/02-guides/environment-variables.md` before changing routes or environment configuration.
- Never accept a connector-supplied claim that the sender is organizer. Authority comes only from the connection and confirmed mapping rows.
- Never return reservation proof, booking contact, private notes, tokens, credential digests, pairing digests, or full action request payloads in a group-safe result.
- Reuse protected domain paths. Do not duplicate majority arithmetic, proposal staleness, reservation locks, or itinerary-write invariants inside the MCP layer.
- Follow red-green-refactor for every task and commit only after the focused tests pass.
- Before the pull request run `npm test`, `npm run lint`, and `npm run build`; then update docs and the roadmap without claiming production shipment.

---

## File responsibility map

| File | Responsibility |
|---|---|
| `lib/trip-agent-contracts.ts` | Zod inputs, result envelope, operation/action/provider/status types; no I/O |
| `lib/trip-agent-auth.ts` | Pairing/bearer generation, SHA-256 credential digests, HMAC external-identity digests, header parsing, connection authentication |
| `lib/trip-agent-policy.ts` | Pure authority decision table and preauthorization validation |
| `lib/trip-agent-actions.ts` | Idempotent action creation/replay, preview expiry, execution/result transitions, redaction |
| `lib/trip-agent-read-model.ts` | Group-safe trip/today/pending-decision projections |
| `lib/trip-agent-tools.ts` | MCP tool registration and thin adapters to services |
| `lib/trip-agent-change-service.ts` | Preview, proposal creation, voting, organizer settlement, reservation preparation handoff |
| `lib/routes.ts` | Pure response parser plus Google Routes client for route research |
| `app/api/mcp/route.ts` | Bearer check before delegating to the SDK's Streamable HTTP handler |
| `app/api/trip-agent/pair/route.ts` | Public, rate-limited, single-use pairing exchange |
| `app/api/trips/[slug]/agent-connection/route.ts` | Organizer lifecycle and policy REST API |
| `app/api/trips/[slug]/agent-participants/[mappingId]/route.ts` | Organizer mapping confirmation/revocation |
| `app/api/trips/[slug]/agent-actions/[actionId]/confirm/route.ts` | Organizer-only confirmation/rejection |
| `supabase/migrations/20260829120000_trip_agent_gateway.sql` | Connection, mapping, action tables, constraints, indexes, RLS, atomic helpers |

## Task 1: Install the MCP server and define the contract

**Files:**

- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `lib/trip-agent-contracts.ts`
- Create: `lib/__tests__/trip-agent-contracts.test.ts`

- [ ] From synced `master`, run `git switch -c codex/trip-agent-gateway-foundation` and `npm install @modelcontextprotocol/server@2.0.0`.
- [ ] In `lib/__tests__/trip-agent-contracts.test.ts`, add failing cases proving that providers accept only `openclaw | hermes`, every tool requires a UUID `requestId` and nonempty `externalGroupId`, participant-aware tools validate `externalParticipantId`, change inputs accept only `move | remove | replace | suggest | reservation_prepare`, text fields reject more than 240 characters, and unknown keys are rejected.
- [ ] Run `npm test -- lib/__tests__/trip-agent-contracts.test.ts`; expect failure because the module does not exist.
- [ ] Create strict Zod schemas and inferred types for `TripAgentProvider`, `TripAgentScope`, `TripAgentOperation`, `TripAgentActionStatus`, `TripAgentAuthorityDecision`, `authorityPolicySchema`, the ten MCP inputs listed in the index, and `toolSuccess`/`toolFailure` helpers.
- [ ] Use these exact initial scopes: `connector.setup`, `trip.read`, `trip.research`, `trip.propose`, `trip.modify`, `trip.vote`, `proactive.read`, `announcement.write`. Use these exact bounded policy fields: `{ travelerCanAddSuggestion: boolean, travelerCanProposeChange: boolean }`, both defaulting to `true`.
- [ ] Run the focused test and `npx tsc --noEmit`; expect both to pass.
- [ ] Commit: `git add package.json package-lock.json lib/trip-agent-contracts.ts lib/__tests__/trip-agent-contracts.test.ts && git commit -m "feat: define trip agent MCP contracts"`.

## Task 2: Add durable connection, mapping, and action records

**Files:**

- Create: `supabase/migrations/20260829120000_trip_agent_gateway.sql`
- Create: `lib/__tests__/trip-agent-gateway-migration.test.ts`

- [ ] Copy the PGlite migration harness from `lib/__tests__/adjust-today-migration.test.ts` into the new test and add failing assertions for the schema below.
- [ ] Test that only one connection row can exist per trip; only one confirmed mapping can point to a traveler; the same `(connection_id, idempotency_key)` cannot be inserted twice; a reused key with a different operation cannot be silently overwritten; rate-window increments are atomic; and public, anon, and authenticated roles have no table access.
- [ ] Run `npm test -- lib/__tests__/trip-agent-gateway-migration.test.ts`; expect missing-table failures.
- [ ] Create `trip_agent_connections` with: `id`, unique `trip_id`, `provider`, `status`, nullable unique `credential_digest`, nullable unique `pairing_code_digest`, `pairing_expires_at`, `granted_scopes`, `authority_policy`, nullable `agent_phone_e164`, nullable `whatsapp_group_digest`, nullable `whatsapp_group_label`, nullable `privacy_notice_version`, nullable `privacy_notice_message_digest`, `last_seen_at`, `paired_at`, `activated_at`, `paused_at`, `revoked_at`, `archived_at`, `created_at`, and `updated_at`. Check provider against `openclaw|hermes`, status against `pending|paired|active|paused|revoked|archived`, and require the digest fields to match the appropriate lifecycle state.
- [ ] Create `trip_agent_participant_mappings` with: `id`, `connection_id`, `external_participant_digest`, nullable `display_name_hint`, nullable `traveler_id`, `status` (`suggested|confirmed|revoked`), nullable `confirmed_by`, `confirmed_at`, `revoked_at`, and timestamps. Add unique `(connection_id, external_participant_digest)` and a partial unique `(connection_id, traveler_id)` where status is confirmed. Never persist the provider's raw participant identifier.
- [ ] Create `trip_agent_actions` with: `id`, `connection_id`, `trip_id`, `idempotency_key`, `external_actor_digest`, nullable `mapped_traveler_id`, `operation`, `normalized_request`, nullable `preview`, `authority_decision`, `status`, nullable `plan_fingerprint`, nullable `confirmation_expires_at`, nullable `proposal_id`, nullable `canonical_reference`, nullable `result`, nullable `error_code`, `announcement_status`, nullable `announced_at`, `created_at`, `updated_at`, and `executed_at`. Check all enums against the index and make `(connection_id, idempotency_key)` unique. Persist only the HMAC digest of the external actor identifier.
- [ ] Create `trip_agent_rate_windows` with `connection_id`, `bucket`, `window_started_at`, `request_count`, and `updated_at`; primary key `(connection_id, bucket, window_started_at)`. Add `consume_trip_agent_rate_limit(connection, bucket, limit, now)` that atomically increments the current minute and returns allowed/count/retry-after.
- [ ] Add foreign keys with `on delete cascade` from trip-owned records, deny-all RLS, service-role grants, lookup indexes for active connections, confirmed mappings, pending confirmations, trip action history, and unannounced succeeded actions.
- [ ] Add an atomic SQL function `consume_trip_agent_pairing(p_pairing_digest, p_provider, p_credential_digest, p_now)` that locks the pending row, rejects expired/used/provider-mismatched codes, sets the credential digest, clears pairing fields, activates the row, and returns connection/trip identifiers.
- [ ] Add comments explaining one-connector-per-trip, digest-only secrets, unmatched mapping behavior, idempotency, and why action payloads must stay structured.
- [ ] Run the focused migration test twice from a fresh PGlite database; expect it to pass both times.
- [ ] Commit the migration and test.

## Task 3: Implement credential and pairing authentication

**Files:**

- Create: `lib/trip-agent-auth.ts`
- Create: `lib/__tests__/trip-agent-auth.test.ts`
- Create: `app/api/trip-agent/pair/route.ts`
- Create: `app/api/__tests__/trip-agent-pair.test.ts`
- Modify: `lib/public-request-limit.ts`

- [ ] Add failing unit tests for 32-byte base64url secret generation, SHA-256 digest stability, HMAC identity digest separation by connection, missing identity pepper, case-sensitive bearer parsing, missing/malformed authorization, active success, setup-only paired success, and paused/revoked/archived refusal.
- [ ] Implement `generateTripAgentSecret()`, `digestTripAgentSecret()`, `digestExternalIdentity(connectionId, rawIdentifier)`, `bearerCredentialFrom()`, and `authTripAgent(db, request)`. The identity helper uses HMAC-SHA-256 with `TRIP_AGENT_IDENTITY_PEPPER`. `authTripAgent` must select by credential digest, join the trip, permit `paired` only for setup tools, update `last_seen_at` best-effort, and return a typed error without exposing whether a digest exists.
- [ ] Add failing route tests for invalid JSON, expired code, provider mismatch, rate limit, successful one-time exchange, and replay refusal. Mock `consume_trip_agent_pairing`; assert the plaintext credential appears only in the success response and never in a database call.
- [ ] Extend `lib/public-request-limit.ts` with a `trip-agent-pair` bucket capped at 20 attempts per IP per hour. Pairing digest lookup is a second, database-enforced replay boundary.
- [ ] Implement `POST /api/trip-agent/pair` using strict `{ pairingCode, provider }`, a new generated credential, the atomic RPC, and `NEXT_PUBLIC_SITE_URL`/`VERCEL_PROJECT_PRODUCTION_URL` to return `${site}/api/mcp`. Pairing ends in `paired`, not `active`; group registration, organizer mapping, and the privacy notice still have to pass.
- [ ] Run both focused tests and `npx tsc --noEmit`; expect pass.
- [ ] Commit the task.

## Task 4: Add organizer connection lifecycle APIs

**Files:**

- Create: `app/api/trips/[slug]/agent-connection/route.ts`
- Create: `app/api/__tests__/trip-agent-connection.test.ts`
- Modify: `lib/schema.ts`
- Modify: `lib/permissions.ts`
- Modify: `lib/__tests__/permissions.test.ts`

- [ ] Add `canManageTripAgent({ actorIsOrganizer })` to `lib/permissions.ts` and failing tests that travelers cannot issue, pause, resume, rotate, archive, or revoke a connector.
- [ ] Add strict schemas for create and lifecycle actions. `POST` needs `{ provider }`; `PATCH` is a discriminated union for `pause`, `resume`, `rotate`, `archive`, `update_policy`, and `update_metadata`. Validate E.164 as `+` followed by 7–15 digits and group label at 1–100 characters.
- [ ] Add route tests for organizer-only access, ten-minute pairing expiry, replacement of an old pending code, refusal to resume revoked/archived connections, immediate pause/revoke, digest rotation, redacted reads, and database failure responses.
- [ ] Implement `GET`, `POST`, `PATCH`, and `DELETE`. `GET` returns no secret or payload columns. `POST` stores only the pairing-code digest. `pause` and `revoke` take effect before returning. `rotate` invalidates the existing credential and returns a new one once, with a `trip_events` audit record. `archive` also disables future proactive polling.
- [ ] `update_policy` may modify only the two bounded policy booleans and granted scopes from the defined enum; it may never grant an unknown scope.
- [ ] Run route, permission, and schema tests; expect pass.
- [ ] Commit the task.

## Task 5: Implement group registration, organizer-confirmed mappings, and authority policy

**Files:**

- Create: `lib/trip-agent-policy.ts`
- Create: `lib/__tests__/trip-agent-policy.test.ts`
- Create: `lib/trip-agent-tools.ts`
- Create: `lib/__tests__/trip-agent-tools.test.ts`
- Create: `app/api/trips/[slug]/agent-participants/[mappingId]/route.ts`
- Create: `app/api/__tests__/trip-agent-participants.test.ts`

- [ ] Write table-driven failing policy tests covering every row in the plan index's default authority table, plus paused connections, missing scopes, automated travelers, organizer identity, and the two bounded preauthorizations.
- [ ] Implement a pure `evaluateTripAgentAuthority(input)` returning `{ decision, reason, requiredScope }`. It must be exhaustive over operations and must never infer organizer from an external display name.
- [ ] Add route tests for organizer-only mapping confirmation, traveler ownership validation within the trip, duplicate mapping conflicts, remapping, revocation, and redacted output.
- [ ] Implement `PATCH` actions `confirm`, `remap`, and `revoke`. Confirmation writes `confirmed_by` and timestamp. Mapping a connector participant to a traveler marked `is_bot` is allowed for display but the policy must still refuse their vote.
- [ ] Register setup-only MCP tools `register_trip_group`, `get_trip_agent_readiness`, and `activate_trip_agent`. `register_trip_group` HMAC-digests the group and participant identifiers, stores only the group label and participant display hints, and upserts suggested mappings. `get_trip_agent_readiness` requires a confirmed mapping to the trip organizer plus saved policy and group metadata. `activate_trip_agent` requires readiness, privacy notice version `v1`, and a delivered provider message receipt; it stores only the receipt digest and changes `paired` to `active`.
- [ ] Add tests proving ordinary trip tools refuse a `paired` connection, setup tools refuse another trip/group, activation cannot precede organizer mapping or notice delivery, and a new participant remains suggested/unmatched until organizer confirmation.
- [ ] Record `agent_participant_mapping_confirmed`, `agent_participant_mapping_changed`, and `agent_participant_mapping_revoked` in `trip_events` with mapping/traveler IDs only.
- [ ] Run focused tests and commit.

## Task 6: Build one group-safe read model

**Files:**

- Create: `lib/trip-agent-read-model.ts`
- Create: `lib/__tests__/trip-agent-read-model.test.ts`
- Modify: `app/api/trips/[slug]/route.ts`

- [ ] Create fixtures containing reservation contact, confirmation number, proof artifact, private attempt route, organizer note, traveler preferences, and public schedule fields. Write failing tests proving the group-safe projection excludes every private field while retaining `reservationStatus`, `reservationAt`, public booking status, venue/map data, vote tallies, and pending decision descriptions.
- [ ] Extract reusable trip/item/proposal row mappers from the current board route. Keep the existing board response byte-for-byte compatible; add `loadGroupSafeTripContext(db, tripId, viewer)` and `loadGroupSafeToday(db, tripId, at)` for tools.
- [ ] Today output must include phase, day index/date, ordered current-day items, the next planned item, leave-by estimate, opening-hours risk, group-safe reservation summary, and pending decisions. Reuse `getTripTiming`, `itemsForToday`, `nextTodayItem`, `leaveByEstimate`, `venueHoursRisk`, and `tallyProposal`.
- [ ] An unmatched viewer receives no `myVote` and no participant identity. A confirmed viewer receives only their own vote and capability booleans.
- [ ] Add a board-route regression assertion showing its old response contract still passes.
- [ ] Run `npm test -- lib/__tests__/trip-agent-read-model.test.ts app/api/__tests__/trip-board-auth.test.ts app/api/__tests__/trip-board-read-errors.test.ts` and commit.

## Task 7: Expose the MCP endpoint and safe read tools

**Files:**

- Modify: `lib/trip-agent-tools.ts`
- Modify: `lib/__tests__/trip-agent-tools.test.ts`
- Create: `app/api/mcp/route.ts`
- Create: `app/api/__tests__/mcp-route.test.ts`

- [ ] Add route tests proving allowed-host/origin validation and bearer authentication happen before MCP parsing, missing/invalid credentials return 401, paused returns 403, database outage returns 503, and the handler is never called on a boundary failure.
- [ ] Build `createTripAgentMcpHandler(auth)` with `createMcpHandler` and a fresh `McpServer` per request. Before every tool adapter, consume the appropriate connection rate bucket from the index and return `rate_limited` without domain calls when exhausted. Register `get_trip_context`, `get_today_plan`, `get_pending_trip_decisions`, and `report_group_announcement` first.
- [ ] Use the SDK's in-process `StreamableHTTPClientTransport` with a custom `fetch` calling `handler.fetch(request)` to test initialization, tool listing, valid calls, invalid schemas, unmatched reads, scope refusal, and cross-trip action-announcement refusal.
- [ ] Export `POST`, `GET`, and `DELETE` route handlers that first require the request host to match `TRIP_AGENT_ALLOWED_HOSTS` and, when an `Origin` header exists, require the same origin; then authenticate and delegate the original Request to the MCP handler. Accept hostnames only, comma-separated, and include the production domain explicitly. Do not cache any method.
- [ ] `report_group_announcement` accepts `{ requestId, actionId, deliveryStatus: "delivered"|"failed", providerMessageId? }`; persist only the connection-scoped HMAC digest of the provider message ID, not the WhatsApp identifier itself.
- [ ] Run focused tests and commit.

## Task 8: Add structured place, parking, and route research

**Files:**

- Create: `lib/routes.ts`
- Create: `lib/__tests__/routes.test.ts`
- Modify: `lib/trip-agent-tools.ts`
- Modify: `lib/__tests__/trip-agent-tools.test.ts`
- Modify: `.env.example`
- Modify: `README.md`

- [ ] Add failing parser tests for Google Routes `{ duration, staticDuration, distanceMeters }`, missing routes, malformed durations, traffic-delay minutes, and explicit `unavailable` when no key exists.
- [ ] Implement `computeTrafficAwareRoute` using `POST https://routes.googleapis.com/directions/v2:computeRoutes`, `TRAFFIC_AWARE`, and field mask `routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline`. Use `GOOGLE_ROUTES_API_KEY`; never fall back silently to the Places-only key.
- [ ] Register `search_trip_options` with `kind: place|restaurant|parking|route`. For place and restaurant, run `findItineraryMatches` before Google Places. For parking, call `searchPlaces` with `parking near <location>` and category `parking`. For route, accept origin/destination as an itinerary item ID or lat/lng and return traffic-aware duration plus a Google Maps navigation URL.
- [ ] Keep results structured and verified: name, rating, review count, regular hours, coordinates, Maps URL, data source, and `verifyLiveAvailability: true`. Do not use an LLM in this tool.
- [ ] Add `GOOGLE_ROUTES_API_KEY=`, `TRIP_AGENT_IDENTITY_PEPPER=`, and `TRIP_AGENT_ALLOWED_HOSTS=` to `.env.example`; document that Routes API billing/quotas must be enabled separately, the identity pepper must be a deployment secret shared by all function instances, and allowed hosts contains only the deployed Trip Planner hostnames.
- [ ] Run route and tool tests, then commit.

## Task 9: Implement idempotent previews and itinerary actions

**Files:**

- Create: `lib/trip-agent-actions.ts`
- Create: `lib/__tests__/trip-agent-actions.test.ts`
- Create: `lib/trip-agent-change-service.ts`
- Create: `lib/__tests__/trip-agent-change-service.test.ts`
- Modify: `lib/trip-agent-tools.ts`

- [ ] Write failing tests for new action, exact replay, mismatched replay, preview expiry after ten minutes, stale plan fingerprint, policy refusal, organizer execute, traveler proposal/auto-yes vote, unmatched refusal, and database failure leaving no success result.
- [ ] Implement normalized JSON hashing with stable key order. `beginAction` HMAC-validates the group, strips `requestId`, `externalGroupId`, and `externalParticipantId`, persists the actor digest separately, and inserts only the operation-specific normalized request. On `23505` it reads and returns the existing row only when operation and normalized request match.
- [ ] Implement `preview_trip_change` for `move`, `remove`, `replace`, `suggest`, and `reservation_prepare`. Load current item, target, locks, reservation, slot occupancy, relevant venue, and current plan fingerprint. Return an exact human-readable impact and authority decision without writing canonical trip state.
- [ ] Implement `commit_trip_change({ actionId })`. Re-read the previewed action, require the same connection/trip/actor digest, unexpired preview, unchanged fingerprint, and current policy. Then:
  - organizer reversible change: call `createPlanProposal`, then `settleProposal(... force: "approve")`;
  - traveler move/remove/replace: call `createPlanProposal`, upsert their yes vote, then `settleProposal`;
  - suggestion: call `createSuggestionProposal`, upsert yes, then settle;
  - reservation preparation: set `awaiting_confirmation` with a 15-minute expiry; do not create a reservation attempt yet. The verified organizer's existing traveler token is the confirmation credential in the mobile/private web surface.
- [ ] Store `proposal_id`, canonical reference, redacted result, and announcement status. A completed shared-state action is `succeeded` only after the core operation succeeds.
- [ ] Catch stale/lock/conflict errors into stable codes (`preview_expired`, `plan_changed`, `reservation_locked`, `destination_occupied`, `proposal_stale`) and never convert them to success.
- [ ] Run action/change-service/tool tests and commit.

## Task 10: Add votes, organizer decisions, and private confirmation

**Files:**

- Modify: `lib/trip-agent-change-service.ts`
- Modify: `lib/trip-agent-tools.ts`
- Create: `app/api/trips/[slug]/agent-actions/[actionId]/confirm/route.ts`
- Create: `app/api/__tests__/trip-agent-confirmation.test.ts`
- Modify: `lib/__tests__/trip-agent-change-service.test.ts`

- [ ] Add failing tests that only a confirmed non-bot traveler can vote, one vote is upserted, organizer decisions reuse `settleProposal`, staleness outranks approval, and actions/proposals cannot cross trip boundaries.
- [ ] Implement `vote_on_trip_change` and `decide_trip_change` as thin adapters around the existing proposal lookup, vote upsert, and `settleProposal`; return the exact tally used by settlement.
- [ ] Add confirmation-route tests for organizer-only access, wrong trip, expired/used challenge, reject, concurrent double-confirm, and reservation preparation success with private fields never returned to non-organizer data.
- [ ] Implement the confirmation route with strict body `{ decision: "confirm"|"reject" }` and the existing organizer `x-trip-token` header. Lock the still-pending action atomically, re-evaluate policy and current state, and for `reservation_prepare` create the existing `reservation_attempts` row in `awaiting_approval` using the previewed structured request. No external booking occurs.
- [ ] On rejection set `rejected`; on expiry set `expired`; on an external outcome that cannot be established set `unknown` and require human review. Never retry an `unknown` action.
- [ ] Run focused tests and commit.

## Task 11: Document, validate, publish, and verify the foundation

**Files:**

- Create: `docs/architecture/trip-agent-gateway.md`
- Modify: `README.md`
- Modify: `ROADMAP.md`
- Modify: `.env.example`

- [ ] Document the chosen MCP boundary, why UI-driving and database credentials were rejected, connection/action/rate-window tables, credential rotation, authority table, privacy projection, idempotency, confirmation expiry, failure states, and limitations. Explain that HTTPS bearer auth is used because the supported generic MCP clients lack a portable dynamic body-signing hook; replay safety is enforced at the action layer, with OAuth or mTLS left as later transport hardening. Link the official MCP SDK server and 2026 protocol-support documents.
- [ ] Update README setup for `NEXT_PUBLIC_SITE_URL`, `GOOGLE_ROUTES_API_KEY`, connection API behavior, MCP URL, and curl-free organizer instructions. State clearly that WhatsApp is not connected until Plan 2.
- [ ] Move the gateway foundation into “in progress/implemented but not production-verified” wording in `ROADMAP.md`; do not mark the full V2 or WhatsApp release shipped.
- [ ] Scan for leaks and placeholders: `rg -n "credential_digest|pairing_code_digest|external_actor_digest|normalized_request" app components` must show no client serialization; `rg -n "TODO|TBD|FIXME|placeholder" lib app docs/architecture/trip-agent-gateway.md` must return no unresolved implementation placeholder.
- [ ] Run `npm test`, `npm run lint`, and `npm run build`; all must pass.
- [ ] Push the branch and open a PR whose description covers purpose, user/developer impact, migration, environment/deployment, rollback, validation, privacy/security, and “screenshots: not applicable; no material UI change.”
- [ ] Review the PR diff and checks, merge through GitHub, fetch, fast-forward local `master`, and verify `HEAD == origin/master`.
- [ ] Apply the migration and environment variable in the deployment environment, verify a test trip can pair, list tools, read group-safe state, reject an unmatched write, apply an organizer-approved reversible change once under a retry, and revoke access immediately.
- [ ] Only after production verification update `ROADMAP.md` in a follow-up documentation PR to mark the foundation shipped.
