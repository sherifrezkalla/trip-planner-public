# WhatsApp-First Trip Agent V2 — Design

Date: 2026-08-29
Status: approved for planning

## Problem

The planner provides itinerary context, recommendations, group decisions,
reservations, and live adaptation. A group may prefer its existing chat to a
separate website. The design makes the organizer's agent a controlled interface
to the canonical planner while keeping human ownership explicit.

V2 accepts that observed behavior as the product model:

> The organizer supplies one trip agent to the WhatsApp group. The agent is the
> main operating interface; the app is the trusted trip engine and a small
> visual companion.

The initial route uses an organizer-owned OpenClaw or Hermes connector so it can
work with the group's existing WhatsApp conversation. A first-party WhatsApp
agent remains a later product path, not a dependency for the first release.

## Product principles

1. **Conversation first.** Ordinary trip operation happens in the WhatsApp
   group where the travelers already are.
2. **One organizer-supplied agent.** Travelers do not bring their own agents in
   the first release.
3. **Human ownership.** The organizer owns the trip, permissions, consequential
   decisions, and the right to pause or revoke the agent.
4. **Planner as source of truth.** The model interprets and communicates; the
   Trip Planner validates and records.
5. **Minimal visual surface.** The mobile companion shows current truth and
   contextual decisions instead of reproducing the V1 dashboard.
6. **Proactive but restrained.** The agent may monitor agreed trip signals but
   should not interrupt ordinary family conversation.
7. **Structured trip memory only.** The planner records trip facts, decisions,
   approvals, and actions, not unrelated group chat.

## Chosen approach

### Organizer agent with a controlled Trip Agent Gateway

OpenClaw or Hermes owns the WhatsApp session and the conversational loop. It
calls a new Trip Agent Gateway using a revocable, trip-scoped credential. The
gateway exposes explicit read, proposal, action, and administration operations
over the existing Trip Planner core.

This preserves the personal agent's conversational strengths without giving it
database credentials or asking it to operate the web UI. It also keeps the
planner's existing validation and atomic write paths authoritative.

### Alternatives rejected for the first release

| Alternative | Why it is not the first release |
|---|---|
| Planner-hosted first-party WhatsApp agent | Cleaner long-term ownership, but it does not solve the immediate requirement to work through the organizer's existing OpenClaw or Hermes setup and existing group conversation. |
| Agent drives the current web interface | Fast to demonstrate but brittle, hard to authorize, difficult to audit, and coupled to every UI change. |
| Every traveler connects a personal agent | Multiplies setup, identity, conflicting-authority, and privacy problems before the single shared-agent model is proven. |

## Roles and trust model

### Organizer

- Creates or owns the trip.
- Connects one OpenClaw or Hermes agent.
- Confirms WhatsApp-to-traveler identity mappings.
- Grants and revokes bounded permissions.
- Confirms consequential actions.
- May pause, rotate, or disconnect the agent immediately.

### Trip agent

- Is a delegated trip administrator and the group's conversational interface.
- Reads group-appropriate trip state.
- Answers, researches, proposes, monitors, and performs permitted actions.
- Identifies itself as an AI assistant supplied by the organizer.
- Cannot expand its own authority or become the trip owner.

The agent is an automated participant, not a traveler. It never contributes a
vote, enters the human vote denominator, or adds preferences to group coverage.

### Travelers

- Ask questions and make requests naturally in WhatsApp.
- Vote or approve where trip policy allows.
- Use the mobile companion only when a visual plan, map, or decision is useful.

An unmatched WhatsApp participant may ask group-safe questions but cannot vote
or change shared trip state.

## System architecture

```text
WhatsApp group
      ⇅
Organizer's OpenClaw / Hermes connector
      ⇅
Controlled Trip Agent Gateway
      ⇅
Trip Planner Core  ⇄  Proactive Event Engine
      ⇅
Simple mobile companion
```

### OpenClaw or Hermes connector

- Receives WhatsApp group messages.
- Supplies only the relevant conversational context to its model.
- Resolves the trip and external participant identity.
- Calls typed gateway operations.
- Communicates previews, approval requests, results, and proactive alerts.
- Retains responsibility for the WhatsApp session; the planner never receives
  the organizer's WhatsApp or personal-agent login.

### Trip Agent Gateway

- Authenticates a trip-scoped connector credential.
- Maps external participants to confirmed traveler identities.
- Exposes explicit operations instead of database access.
- Applies role, trip, action, and confirmation policy.
- Produces a preview before a material write.
- Issues and validates short-lived confirmation challenges.
- Records the request, decision, execution, and result.
- Rate-limits and deduplicates connector traffic.

The gateway is not allowed to rely on the model's claim that somebody is the
organizer. Identity and authority come from the confirmed connection and roster
records.

### Trip Planner Core

The existing planner remains canonical for trips, travelers, itinerary state,
reservations, suggestions, votes, locks, and audit history. Existing protected
write paths and staleness checks are reused rather than reimplemented in the
connector.

### Proactive Event Engine

The engine evaluates itinerary timing, weather, venue hours, transport or route
disruption, reservations, local events near planned locations, and conflicts
between those signals. It emits a structured trigger; it does not itself write
free-form messages or mutate the plan.

### Mobile companion

The companion is a contextual view over the same canonical state. It is not a
second operating system for the trip.

## End-to-end action flow

For a request such as “Can we move lunch later?”:

1. The connector receives the message and identifies the trip and sender.
2. The model interprets the intent and calls a gateway preview operation.
3. The gateway loads current state, validates identity and authority, and
   calculates the action's effects.
4. The policy returns one of: execute, request organizer confirmation, start or
   continue a vote, or refuse.
5. If confirmation is needed, the organizer receives an exact, expiring
   challenge in a private organizer path or the mobile companion.
6. At execution time the core revalidates state and applies the change
   atomically.
7. The result and audit record are persisted before the connector tells the
   group what happened.

The connector never reports success merely because the model intended an
action or an external page opened.

## Authority model

| Level | Examples | Default policy |
|---|---|---|
| Inform | Answer trip questions; show today's plan; search places, routes, parking, weather, or hours | Agent acts autonomously. |
| Prepare | Draft a revised day; compare restaurants; prepare a reservation route; preview a change | Agent acts autonomously but does not commit. |
| Modify trip | Add, move, replace, or remove an activity; update a meeting time; start a vote | Execute when the verified organizer explicitly requests a reversible action. Ordinary traveler requests require an organizer decision, a group vote, or a bounded preauthorization. |
| Consequential | Book, pay, cancel, expose private data, change permissions, or replace the connected agent | Explicit organizer confirmation every time. |

The organizer may preauthorize bounded categories for one trip, for example
allowing any mapped traveler to add a suggestion. Preauthorization is visible,
revocable, and never silently extends to payments, cancellations, private data,
or permission changes.

All shared-state changes are announced. There are no silent plan mutations.

## WhatsApp behavior

### When the agent speaks

The agent responds to:

- a direct mention or reply;
- a clear trip-related request;
- an unambiguous question about shared trip state; or
- an approved proactive trigger.

It does not answer every place name or interrupt unrelated family conversation.
If ordinary discussion appears to contain a new fact — for example, “we agreed
to meet at nine” — the agent creates a candidate interpretation and asks for
confirmation. It does not treat overheard wording as authority.

### Identity

The organizer owns the roster. The agent may suggest a mapping from a WhatsApp
participant to a traveler using connector identifiers and display information,
but only the organizer confirms it. A mapping is scoped to the trip and can be
revoked.

Votes count only confirmed, non-automated travelers, one vote per traveler. The
existing trip policy decides the outcome; the conversational layer does not
invent a second majority rule.

### Privacy and retention

- The group receives only group-appropriate trip information.
- Payment details, documents, private notes, and private reservation identity
  are never repeated in the group.
- Consequential or private confirmations move to a verified organizer-only
  path.
- The planner persists structured trip facts, action records, approvals, and
  only the minimal message excerpt or reference needed for audit.
- Unrelated conversation is not added to Trip Planner memory.
- The setup notice explains the agent's role, listening behavior, memory, and
  organizer ownership before activation.

## Proactive behavior

Allowed trigger families are:

- imminent departure, meeting, and reservation reminders;
- weather likely to disrupt a planned activity;
- transport delays, traffic, or route disruption;
- unexpected closures or venue-hour conflicts;
- reservation conflicts or missing confirmation risk;
- relevant local events or disruptions near itinerary locations; and
- detected timing conflicts within the canonical plan.

By default the engine uses itinerary and venue locations, not continuous
traveler tracking. Lower-priority alerts are deduplicated or grouped. Urgent
alerts may override quiet hours only when the organizer has enabled that trigger
class. The organizer can pause proactivity without disconnecting read access.

## Mobile companion

The ordinary traveler sees one contextual surface:

- today's date and overall trip status;
- the next stop, leave-by time, route, and map;
- the compact current-day timeline;
- a pending vote or confirmation when action is required; and
- one dominant **Ask the trip agent in WhatsApp** action.

The companion deep-links to the exact plan, map, proposal, or approval named in
the WhatsApp message. It does not require menu navigation to find context.

The organizer sees the same simple experience plus a protected control surface
for connection status, current authority, pending consequential confirmations,
activity history, pause, and revoke. Advanced controls do not appear in the
traveler view.

## Setup and lifecycle

1. The organizer creates or opens a trip and selects **Connect trip agent**.
2. The planner issues a short-lived, single-use pairing code or link.
3. The organizer enters it in OpenClaw or Hermes.
4. The connector binds one WhatsApp group and verifies the organizer's
   WhatsApp identity and private confirmation path.
5. The organizer confirms traveler mappings, authority, proactive triggers,
   and quiet hours.
6. A readiness check verifies the connector, trip scope, and permissions.
7. The agent posts its identity and privacy notice before activation.

The first release permits one active connector per trip. A newly joined group
member remains unmatched until confirmed.

The organizer may pause the agent without changing trip state. Revoking or
rotating the connector invalidates the old credential immediately. A connector
outage leaves the planner usable and does not execute queued material actions
silently.

Archiving a trip stops proactive monitoring, expires the credential, and
removes agent access while retaining the trip, decisions, reservations, and
audit history.

## Logical records

The implementation needs durable concepts for:

- one active trip-agent connection, its provider, status, credential digest,
  granted scopes, and revocation time;
- proposed and organizer-confirmed external-participant mappings;
- action requests with an idempotency key, actor, operation, preview, authority
  decision, confirmation expiry, execution status, and result;
- per-trip proactive trigger and quiet-hour policy; and
- audit events that link request, approval, canonical mutation, and group
  announcement.

Exact tables and migrations belong in the implementation plan. Secrets and
raw connector credentials must not be stored in action payloads or audit logs.

## Reliability and failure handling

- Every connector request carries an idempotency key; retrying it returns the
  existing result rather than applying it again.
- A preview is tied to the current plan revision and expires. Confirmation
  cannot force a stale operation through the core's safety checks.
- The canonical write and its audit result commit together where the existing
  domain operation permits it.
- The group is told an action succeeded only after persistence succeeds.
- A failed write leaves previous state intact and returns a clear, actionable
  failure to the connector.
- An external booking or payment with an uncertain outcome is marked unknown
  and requires human verification; it is never retried automatically.
- Connector failure does not take down the planner or the mobile companion.
- Rate limiting, signed connector requests, short-lived challenges, secret
  rotation, and replay rejection protect the gateway boundary.

## V1-to-V2 transition

V2 is not a rewrite of the trip engine.

1. Wrap existing reliable reads and mutations in the controlled gateway.
2. Add connector identity, permissions, confirmation, idempotency, and audit.
3. Expose capabilities incrementally, using existing domain rules underneath.
4. Add the proactive trigger layer over canonical trip state.
5. Replace traveler dashboard complexity with the contextual mobile companion.
6. Retain advanced V1 screens temporarily where the organizer still needs
   administration that has not received an agent operation.

Unsupported third-party automation remains a researched recommendation or
precise handoff. It must not be presented as completed merely because the agent
found a booking page.

## First usable release

The OpenClaw/Hermes-connected release includes:

- questions and answers about the trip and today's plan;
- place, restaurant, route, and parking recommendations;
- preview and application of authorized itinerary changes;
- votes and organizer confirmations;
- proactive weather, timing, closure, transport, reservation, and local-event
  alerts;
- traveler identity mapping and group-safe privacy filtering;
- the simplified traveler companion;
- organizer connection, permissions, pause, revoke, and activity history; and
- reservation preparation, with execution only through a reliable integration
  after explicit organizer confirmation.

## Explicit non-goals for the first release

- Requiring a first-party Meta WhatsApp agent.
- Multiple traveler-owned or competing agents in one trip.
- Automatic payments or cancellations without confirmation.
- Continuous traveler location tracking.
- Storing unrelated WhatsApp conversation in the planner.
- Rebuilding every existing organizer screen before the connector is useful.
- Letting the model bypass existing reservation, vote, lock, staleness, or
  organizer-authorization rules.

## Verification

Automated tests must cover:

- the complete organizer, traveler, unmatched participant, and automated-agent
  permission matrix;
- duplicate connector deliveries and concurrent decisions;
- expired, repeated, tampered, and stale confirmations;
- roster mapping, remapping, revocation, and group-safe privacy filtering;
- connector disconnects and retries;
- proactive trigger eligibility, deduplication, quiet hours, and opt-out;
- uncertain third-party outcomes; and
- regression of the existing domain validations used below the gateway.

End-to-end connector scenarios must prove that:

1. “What is next?” returns current canonical trip state.
2. An organizer's reversible change updates once and is announced.
3. The same request from a traveler opens the configured approval or vote path.
4. A consequential action cannot execute without an unexpired organizer
   confirmation.
5. A relevant disruption creates one useful proactive alert.
6. An ambiguous identity or message leaves the trip unchanged.
7. An offline connector cannot corrupt or silently mutate trip state.

## Known limitations

- Initial WhatsApp reliability depends on the organizer's OpenClaw or Hermes
  connector and its access to the selected group.
- One-agent-per-trip keeps authority clear but provides no automatic connector
  failover.
- Proactive local-event quality depends on available external data and must be
  conservative when confidence is low.
- Some V1 capabilities will remain app-only until they have a safe typed action
  and confirmation model.
- A simple mobile companion reduces traveler friction but does not remove the
  need for a protected organizer administration surface.
