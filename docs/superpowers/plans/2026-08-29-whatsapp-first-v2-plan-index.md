# WhatsApp-First Trip Agent V2 — Implementation Plan Index

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement each linked plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved WhatsApp-first V2 as four reviewable releases without rewriting the existing Trip Planner core.

**Architecture:** OpenClaw or Hermes owns WhatsApp and calls one provider-neutral Streamable HTTP MCP gateway. The gateway authenticates one organizer-supplied connector per trip, maps WhatsApp participants to travelers, evaluates authority, and delegates to the existing trip, proposal, reservation, weather, and itinerary code. A proactive engine emits structured alerts, while `/t/[slug]` becomes a small traveler companion and the existing board remains available to the organizer at `/t/[slug]/manage`.

**Tech Stack:** Next.js 16 App Router and Route Handlers, React 19, TypeScript 5, Zod 4, Supabase/PostgreSQL, `@modelcontextprotocol/server` 2.x, Vitest, PGlite, Google Places/Routes, Open-Meteo, Ticketmaster Discovery API, Vercel Cron or an external scheduler.

**Spec:** `docs/superpowers/specs/2026-08-29-whatsapp-first-trip-agent-v2-design.md`

## Global Constraints

- GitHub is the source of truth. Start every plan by fetching `origin`, fast-forwarding `master`, verifying `HEAD == origin/master`, and checking open pull requests.
- Implement each plan on its own `codex/` branch and merge it through a documented GitHub pull request. Never implement two plans concurrently because their database and shared contracts are deliberately sequenced.
- Before editing a Next.js route or page, read the relevant file under `node_modules/next/dist/docs/`; this repository uses Next.js 16 behavior rather than remembered conventions.
- The Trip Planner remains the source of truth. An agent tool must call existing domain operations or a new shared domain operation, never update protected itinerary or reservation rows ad hoc.
- Store only SHA-256 credential digests. Plaintext connector credentials and pairing codes are returned once and never logged, stored in action payloads, or written to audit events.
- Persist structured trip facts and minimal source references only. Do not store unrelated WhatsApp conversation.
- Every shared-state mutation requires a durable idempotency key, an authority decision, a current-state check, and an audit result before the connector may announce success.
- Unmatched participants have group-safe read and research access only. Only confirmed, non-automated travelers may vote. Consequential actions always require the verified organizer.
- Add regression tests for every behavior, keep `README.md`, `ROADMAP.md`, and `docs/architecture/` current, and run `npm test`, `npm run lint`, and `npm run build` before every pull request.
- Do not mark a roadmap item shipped until its PR is merged, required migrations are applied, the production deployment is healthy, and the behavior is verified in production.

---

## Delivery sequence

| Order | Plan | Outcome | Depends on |
|---|---|---|---|
| 1 | [Gateway and authority foundation](2026-08-29-trip-agent-gateway-foundation.md) | Secure trip-scoped MCP endpoint, safe reads/research, itinerary previews and mutations, votes, confirmations, mappings, audit, and lifecycle APIs | Current V1 core |
| 2 | [OpenClaw/Hermes connector onboarding](2026-08-29-openclaw-hermes-connector-onboarding.md) | Organizer setup flow, provider instructions, conversation contract, activation notice, readiness checks, and end-to-end connector tests | Plan 1 |
| 3 | [Proactive trip monitoring](2026-08-29-proactive-trip-monitoring.md) | Timing, weather, venue-hour, reservation, live-traffic, and local-event triggers with quiet hours and deduplicated connector delivery | Plans 1–2 |
| 4 | [Mobile companion and organizer controls](2026-08-29-mobile-trip-companion.md) | Compact traveler UI at the shared link, contextual decisions and confirmations, WhatsApp handoff, and protected advanced organizer board | Plans 1–3 |

Each plan ends in a deployable state. Plan 1 can be tested with an MCP client before any connector configuration exists. Plan 2 makes WhatsApp usable. Plan 3 adds proactive behavior. Plan 4 changes the default web experience only after the agent path is available.

## Shared interface contract

### Connection lifecycle

The organizer-facing API is authenticated with the existing `x-trip-token` header:

| Method and path | Purpose | Success body |
|---|---|---|
| `GET /api/trips/[slug]/agent-connection` | Read connection, scopes, policy, mappings, and recent action summaries | `{ connection, mappings, recentActions }` with no digests or private payloads |
| `POST /api/trips/[slug]/agent-connection` | Issue or replace a ten-minute, single-use pairing code | `{ pairingCode, pairingExpiresAt }` |
| `PATCH /api/trips/[slug]/agent-connection` | `pause`, `resume`, `rotate`, `archive`, or update authority/proactivity policy | Updated redacted connection; `rotate` returns a new one-time credential only after organizer confirmation |
| `DELETE /api/trips/[slug]/agent-connection` | Revoke immediately | `{ status: "revoked" }` |
| `POST /api/trip-agent/pair` | Exchange `{ pairingCode, provider }` for the one-time bearer credential | `{ credential, mcpUrl, trip, status: "paired" }` |
| `PATCH /api/trips/[slug]/agent-participants/[mappingId]` | Organizer confirms, remaps, or revokes a participant mapping | Redacted mapping |
| `POST /api/trips/[slug]/agent-actions/[actionId]/confirm` | Authenticated organizer confirms or rejects an expiring consequential action | Redacted action result |

`POST /api/trip-agent/pair` is public but rate-limited by IP and pairing-code digest. Every other connection-management route is organizer-only.

### MCP transport and authentication

- Endpoint: `POST`, `GET`, and `DELETE /api/mcp` as supported by the SDK's stateless Streamable HTTP handler.
- Authentication: `Authorization: Bearer <trip-agent-credential>` before the MCP handler sees the request.
- Transport integrity uses HTTPS plus the revocable bearer. OpenClaw/Hermes remote MCP configuration does not expose a portable per-request signing hook, so the first release does not invent a provider-specific body signature; mutation replay protection comes from the required idempotency key and stored normalized request. This limitation and the later OAuth/mTLS option must be recorded in the architecture document.
- The route creates a fresh `McpServer` per request and never exposes a database client, traveler token, credential digest, reservation contact, artifact, or private note as a tool result.
- Tool results use `{ ok: true, data }` or `{ ok: false, error: { code, message, retryable } }`. Tool-level refusal is data, not a transport crash.
- Every tool input contains `requestId: string.uuid()`. Durable mutations use it as the idempotency key; duplicate reads may be recalculated but retain it in diagnostics.
- The gateway enforces per-connection fixed-window limits before tool execution: 30 setup calls/minute, 120 read/research/poll calls/minute, and 30 mutation/announcement calls/minute. A refusal returns `rate_limited` and a retry-after value without invoking domain code.
- Every operational tool accepts the provider's stable `externalGroupId`; its connection-scoped HMAC must match the group bound during `register_trip_group` or the call is refused. Every participant-aware tool also accepts `externalParticipantId`. Omitted or unknown participant IDs are treated as unmatched, never as the organizer.
- Before an action request is persisted, remove `requestId`, `externalGroupId`, and `externalParticipantId`; store the request ID in the idempotency column, the actor HMAC separately, and only operation-specific structured fields in `normalized_request`.

### MCP tool inventory

| Tool | Purpose | Authority |
|---|---|---|
| `register_trip_group` | Bind one privacy-preserving group digest and submit participant mapping suggestions | Paired connector with `connector.setup` scope |
| `get_trip_agent_readiness` | Report missing organizer mapping, policy, metadata, or activation notice | Paired connector with `connector.setup` scope |
| `activate_trip_agent` | Record the delivered identity/privacy notice and change `paired` to `active` | Ready paired connector with `connector.setup` scope |
| `get_trip_context` | Group-safe trip summary, roster labels, dates, current plan status | Any connected group participant |
| `get_today_plan` | Current day, next stop, leave-by estimate, group-safe reservation status, pending decisions | Any connected group participant |
| `search_trip_options` | Stored-plan lookup first; verified place, restaurant, parking, or route research second | Any connected group participant |
| `get_pending_trip_decisions` | Open proposals and the caller's vote/organizer decision ability | Any connected group participant; capabilities vary by mapping |
| `preview_trip_change` | Validate a move, remove, replacement, suggestion, or reservation preparation without mutation | Confirmed traveler or organizer |
| `commit_trip_change` | Apply organizer-authorized reversible change, create a traveler proposal, or open an organizer confirmation | Per policy result |
| `vote_on_trip_change` | Cast one human traveler's vote and run the existing settlement path | Confirmed non-bot traveler |
| `decide_trip_change` | Approve or reject through the existing settlement path | Confirmed organizer |
| `report_group_announcement` | Link the connector's delivery receipt to a completed action | Active connector; action must belong to its trip |
| `poll_proactive_events` | Retrieve undelivered structured proactive events and acknowledge delivery | Active connector with `proactive.read` scope |

The first release does not expose connection permission changes, credential rotation, payment, cancellation, document retrieval, or raw reservation contact through MCP tools. Those remain in the verified organizer web surface. Provider group IDs, participant IDs, and message IDs are HMAC-SHA-256 digested with `TRIP_AGENT_IDENTITY_PEPPER` before persistence; only display hints and labels remain readable. The connector provider may retain its own conversation history, so its retention and log settings are an explicit organizer setup check outside the planner's storage boundary.

### Action states

All material requests use the same state machine:

```text
received → previewed → executing → succeeded
                    ↘ awaiting_vote → succeeded | rejected | cancelled
                    ↘ awaiting_confirmation → executing → succeeded | failed | unknown
                    ↘ refused
                    ↘ expired
```

`unknown` is reserved for an external consequence whose outcome cannot be proved. It is never retried automatically. A duplicate `requestId` returns the stored action when the operation and normalized request match, and returns `idempotency_conflict` when they differ.

### Default authority policy

| Actor and operation | Decision |
|---|---|
| Unmatched participant reads or researches | Execute with group-safe data |
| Unmatched participant requests a write or vote | Refuse and ask for organizer mapping |
| Confirmed traveler previews a change | Execute preview |
| Confirmed traveler commits a reversible itinerary change | Create or reuse a proposal and record the traveler's yes vote |
| Confirmed human traveler votes | Upsert their vote and run `settleProposal` |
| Confirmed organizer commits a reversible itinerary change | Execute after preview using the same protected proposal/apply path |
| Any actor requests booking, payment, cancellation, private data, permission change, or connector replacement | Open an expiring organizer confirmation or refuse if the operation is outside the first release |

The organizer may enable only the explicit bounded preauthorizations represented by the schema. The initial schema supports `travelerCanAddSuggestion` and `travelerCanProposeChange`; both default to `true`, and neither changes the consequential-action rule.

## Deployment decisions already made

- OpenClaw and Hermes both consume the same remote Streamable HTTP MCP server; the Trip Planner does not implement the WhatsApp session.
- OpenClaw configuration uses a remote MCP URL, bearer header, tool allowlist, WhatsApp group allowlist, group-specific system prompt, and restrained mention/reply rules.
- Hermes configuration uses `mcp_servers` with `${ENV_VAR}` bearer substitution, an explicit tool include list, WhatsApp access control, batching, and a dedicated bot number.
- The web app can reliably open WhatsApp, but there is no dependable public deep link to an existing private group. The companion uses a configured direct agent `wa.me` link when an agent phone number is supplied; otherwise it opens WhatsApp generically and says which group to return to.
- Ticketmaster Discovery API v2 is the first local-event source. Missing API configuration is reported as `unavailable`, never as “no events”. Coverage limitations are visible in the architecture document.
- Google Routes `TRAFFIC_AWARE` compares `duration` with `staticDuration` for live driving delay. It does not claim public-transit incident coverage.
- Vercel Hobby cron is once daily and cannot support during-trip alerts. The monitoring route therefore accepts a protected external scheduler, while `vercel.json` may use a 15-minute schedule only on Pro or above.

## Definition of V2 complete

- One organizer can connect, pause, rotate, and revoke one OpenClaw or Hermes connector for a trip.
- The agent answers from canonical trip state, performs structured research, previews changes, follows existing votes and staleness rules, and never silently mutates the plan.
- Participant identity is organizer-confirmed and unmatched users cannot act.
- Consequential actions expire unless confirmed by the organizer in a private surface.
- Proactive alerts are structured, deduplicated, quiet-hour-aware, and delivered only after the activation notice.
- The shared trip link opens the simple companion; the organizer can still reach the advanced board.
- Connector outage leaves the app usable; planner outage produces a clear failure and no false success.
- README, roadmap, architecture, setup instructions, migrations, tests, production deployment, and production verification agree.
