# Trip-agent connector onboarding

Status: app-side operator preview deployed and production-verified 2026-09-26; OpenClaw and Hermes live verification remains open. See [release evidence](trip-agent-connectors-release.md). The [gateway foundation](trip-agent-gateway.md) is separately shipped. Provider guides are checked against official documentation on 2026-09-23, not certified against installed runtime versions. Do not mark either provider shipped until its deployed end-to-end checks pass.

## Ownership and design constraints

The organizer supplies one OpenClaw or Hermes connector for one trip and one WhatsApp group. The provider owns WhatsApp login, transport, stable sender metadata, model execution, and outbound delivery. Trip Planner owns canonical trip state, mapping confirmation, scopes, authority policy, mutations, and structured audit. The organizer-only board presents connection lifecycle, mapping, policy, and redacted history; it does not manage provider sessions.

A first-party WhatsApp bot is deferred because hosting account sessions, recovery, provider policy changes, and transcript retention would expand the product's operational responsibility. Native provider configuration reuses the organizer's existing runtime. A generic chat webhook and direct database access were rejected: neither preserves the existing typed tool/authority boundary. This choice leaves provider setup and credential installation as an operator step; the app is not a one-click bot installer.

Pairing exchanges a ten-minute single-use code over HTTPS for a once-returned bearer. The database stores only secret digests. Stable raw group, participant, and receipt identifiers cross the gateway boundary and become connection-and-generation-scoped HMAC values; display names never establish authority. The identity pepper stays server-only and stable. A replacement connection starts a new generation, leaving earlier mappings/actions as history without granting current access. The provider never receives organizer tokens or database credentials.

The planner stores structured trip facts and action records, not unrelated raw chat. Provider transcripts, model processing, logs, and WhatsApp session backups have separate retention and access controls that the organizer must review. The [notice](../connectors/trip-agent-privacy-notice.md) describes planner behavior, not a promise that third-party histories are erased.

## Setup and delivery semantics

The connection moves from pending code to paired, then registers one group and suggested participants. The organizer confirms a human organizer mapping, reviews scopes and policy, and resolves readiness prerequisites. The connector posts the exact `v1` notice and calls `activate_trip_agent` with a real provider message ID. Only a successfully activated connection should display active. A notice copy button or generated text cannot prove delivery.

Every shared-state change needs a group announcement and `report_group_announcement` receipt. Receipts are connector assertions: the gateway cannot independently contact WhatsApp to validate them. Live send verification is therefore a release gate. Failed/uncertain announcement delivery must not cause the canonical mutation to run again.

The [canonical prompt](../connectors/trip-agent-group-prompt.md) defines restrained replies, stable identities, current-state reads, preview/confirmation, and exact retry IDs. Prompts are behavioral guidance; server checks enforce permissions. Unknown participants cannot become organizers through names or chat claims. Native poll aggregates convey no authority: each vote must arrive with its own trusted sender and confirmed traveler mapping.

## Provider-specific choices

- [OpenClaw](../connectors/openclaw-whatsapp.md): explicitly set `transport: "streamable-http"` and `toolFilter.include`; keep group admission separate from sender authorization. Put the prompt on the single JID entry. A wildcard prompt entry also broadens group admission and is excluded from the recommended setup.
- [Hermes](../connectors/hermes-whatsapp.md): configure `mcp_servers.trip_planner`, `tools.include`, group-JID allowlisting, and trusted senders. A dedicated instance/profile holds the durable prompt without replacing a personal assistant's identity. Preserve current documented batching defaults (0.3 seconds, extended to 1 second), correcting the original plan's outdated five-second assumption.
- Both expose exactly the twelve registered gateway tools, serialize tool calls, and keep bearer storage private. Filtering limits the provider's exposed catalog; it does not replace gateway scopes. Proactive event polling and scheduled alerts remain later work; no polling tool is currently registered.

## Recovery and practical limits

Pause blocks authentication; resume is an explicit organizer action. Rotation requires visible confirmation, returns the replacement bearer once, and immediately invalidates the old bearer. Provider storage must then be updated manually and probed. Revoked/archived connections cannot resume. A group change requires revocation and fresh pairing/registration/mapping/notice, not silent rebinding of an active connection.

After an outage, re-read the trip and revalidate pending work. Do not replay queued material actions or expired confirmations. A last-contact timestamp older than ten minutes during the trip is a diagnostic hint, not a verified provider-health measurement. The board remains usable when the connector is stopped.

The gateway accepts only MCP 2026-07-28 stateless POST Streamable HTTP. Provider documentation advertising “MCP” or “HTTP” does not establish compatibility with that revision. An installed provider must initialize, discover the exact catalog, and successfully call a read tool before live activation testing. Neither provider CLI nor WhatsApp session was available for those checks in this implementation environment.

`npm run smoke:trip-agent` checks the deployed protocol, inventory, readiness and permitted read behavior. `npm run verify:trip-agent-setup` also reads organizer state and checks active status, group registration, notice receipt, and confirmed human organizer mapping. They do not send messages, register groups, or activate; ordinary request telemetry/rate limits may update. They cannot verify actual provider delivery, prompt restraint, or Hermes poll translation. Those require the manual matrices in the guides.

## Deployment, validation, and rollback

The implementation passed 1,221 Vitest tests, 15 Node verification-script tests, lint, and a production build on 2026-09-25. Independent review fixes cover cached mappings/history across connection generations and clearing a previous bearer before an uncertain rotation/revocation. [Synthetic browser screenshots and scope](images/connector-onboarding/README.md) document the organizer UI; they do not establish live provider support.

This onboarding change needs no new database migration; it uses the foundation's already-installed schema and APIs. Deploy through the standard `master` Vercel path after tests, lint, and build. Keep `TRIP_AGENT_ALLOWED_HOSTS`, `TRIP_AGENT_IDENTITY_PEPPER`, and the stable HTTPS site URL configured as described in the foundation release document.

Before labeling a provider supported, record its exact runtime version and deployed app revision, successful MCP probe, real notice/announcement receipts, behavioral matrix, and pause/revoke enforcement. Hermes additionally needs individual poll-vote evidence for poll support. Source-reviewed snippets, repository tests, and a successful web deployment alone do not satisfy those gates.

Rollback by pausing/revoking the connector, disabling its provider MCP entry, and reverting the onboarding application commit through a PR if necessary. No database rollback is needed. Credential revocation is immediately effective; historical structured audit remains. Update the roadmap only for providers whose production checks actually pass.
