# Connector onboarding operator-preview release

Verified 2026-09-26. This is the app-side setup/recovery milestone, **not certification of live OpenClaw or Hermes WhatsApp behavior**.

## Release identity

- Merged PR #89 (private development record), application revision `532c4ec539839a9ee4dad8d1f8bc1dcfe3e583e2`.
- The production deployment was READY on the operator’s private deployment with that revision; its hostname is omitted.
- No new database migration or provider configuration was applied.
- CI (private development record) and PostgreSQL concurrency checks (private development record) passed. Local validation: 1,221 Vitest tests, 15 Node script tests, lint, production build.
- Independent review approved after fixing cross-generation cached participant/history data and stale bearer display after uncertain repeated rotation.

## Production verification

A fresh, explicitly synthetic trip was created with exact UUID/slug/title/creation-time guards. The official modern MCP client and the shipped smoke/setup verifier exercised the deployed REST and MCP APIs. Tokens and credentials remained in process memory and were not printed or saved.

| Check | Result |
| --- | --- |
| Pairing exchange and exact twelve-tool inventory | Passed |
| Group registration and human organizer mapping | Passed |
| Redacted group/notice flags before activation | Registered, notice false |
| Paired readiness via smoke command | Passed |
| Synthetic activation and full setup verifier | Passed |
| Active read verification after removing setup scope | Passed |
| Pause denies the next MCP request | HTTP 403 |
| Web board remains readable while connector paused | Passed |
| Explicit resume restores canonical reads | Passed |
| Rotation immediately rejects the previous bearer | HTTP 401 |
| New bearer works; mapping generation/group/notice evidence retained | Passed |
| Revoke denies the next MCP request | HTTP 401 |
| Guarded fixture deletion and cascade checks | `fixture_cleanup_verified` |

The activation receipt was explicitly synthetic and used only on this disposable trip. No WhatsApp message was sent or claimed delivered. This proves the application state machine and verification tools, not provider receipt authenticity.

The production JavaScript bundle also rendered the organizer card and omitted it for travelers using intercepted synthetic browser responses. Local production-build browser checks covered mobile setup/recovery states, 1280px desktop layout, masked rotation, dismissal, access-loss redaction, and 20-second request-timeout recovery without automatic mutation retry. [Screenshots](images/connector-onboarding/README.md) contain only synthetic data.

The fixture was deleted with exact identity guards; SQL verified zero remaining trip-owned travelers, itinerary/candidates, proposals, suggestions, connections, actions, mappings, rate windows, and events. No real trip or WhatsApp group was modified.

## Hermes activation checkpoint — 2026-09-27

One organizer-approved installation was connected to the existing production deployment. This is partial provider evidence, not completion of the live group matrix. Credentials, group/sender identifiers, receipt IDs, invite links, and transcripts remain outside the repository.

| Check | Result |
| --- | --- |
| Installed Hermes runtime | 0.21.5 |
| Actual Hermes stateless MCP transport | Exact twelve-tool discovery and live readiness passed |
| Group and sender identity | Trusted incoming event plus provider group metadata; organizer mapping confirmed in the app |
| Existing WhatsApp session | Preserved; one bridge reused |
| Dedicated profile | Selected group route, canonical instructions, restricted Trip Planner toolset |
| Privacy notice | Exact v1 notice delivered once; real successful provider receipt retained privately |
| Production activation | Passed using that receipt; canonical context read matched the selected trip |
| Gateway liveness | Live control socket confirmed default and trip profiles served |
| Read-only assistant check | Blocked by model-provider HTTP 429 weekly usage limit |
| Incoming group question → canonical read → WhatsApp reply | Pending |

The shared gateway was necessary to reuse an already paired WhatsApp account while separating the trip's instructions, configuration, and sessions. A second WhatsApp bridge and replacement of the shared assistant identity were rejected. Five unrelated profile services retained their standalone configuration; private backups preceded additive changes. Profile separation is not a filesystem sandbox. No new application deployment, database migration, or itinerary mutation was needed.

The installed migration command applied shared-gateway mode but returned a confirmation warning: its PID helper did not recognize the process. Runtime liveness and the local control socket independently confirmed the expected gateway and served profiles. The migration manifest remains for operator follow-up; rerunning migration blindly could cause another restart. The model quota failure is a separate blocker; activation does not prove that the model can answer.

To stop canonical access, pause the connector in the organizer card. To roll back routing, disable only the new trip route and remove its group admission, applying configuration after inspecting the current state. Restore backed-up keys only after checking for subsequent unrelated edits; preserve the existing WhatsApp session and other services. Do not resend the notice or repeat activation when resuming verification.

## Remaining provider gate

For each provider, the organizer must supply an accessible runtime and approve one explicit test group. Record installed version/protocol compatibility, restrained replies, confirmed sender identity, real notice/change receipt evidence, duplicate-action handling, and outage/pause/revoke behavior. Hermes native polls additionally require individual mapped votes. Neither provider is marked shipped; proactive monitoring and the simplified mobile companion remain later phases.

Ownership, alternatives, constraints, and rollback are documented in [connector architecture](trip-agent-connectors.md). Provider installation and credentials remain outside the web app.
