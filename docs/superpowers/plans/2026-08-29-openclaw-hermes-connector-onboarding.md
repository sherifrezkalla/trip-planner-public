# OpenClaw and Hermes Connector Onboarding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the gateway from Plan 1 safely usable by an organizer's existing OpenClaw or Hermes WhatsApp bot, including setup, group binding, identity mapping, restrained conversational behavior, privacy notice, activation, pause, and recovery.

**Architecture:** The Trip Planner remains provider-neutral. It supplies an organizer setup surface, pairing exchange, readiness state, canonical prompt/notice artifacts, and MCP smoke tests. OpenClaw or Hermes retains the WhatsApp session and is configured to admit one explicit group, send stable external participant identifiers to the gateway, use only the V2 tool allowlist, and acknowledge actual message delivery before the planner records an announcement or activates the connector.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript, existing traveler-token authentication, OpenClaw remote MCP/WhatsApp configuration, Hermes remote MCP/WhatsApp bot mode, MCP in-process and deployed smoke tests.

**Spec:** `docs/superpowers/specs/2026-08-29-whatsapp-first-trip-agent-v2-design.md`

## Global Constraints

- Complete and production-verify `2026-08-29-trip-agent-gateway-foundation.md` first.
- Start from verified GitHub `master` on `codex/openclaw-hermes-connector-onboarding`; inspect open PRs before editing.
- The Trip Planner does not receive or manage WhatsApp QR sessions, Baileys credentials, personal-agent credentials, or raw chat history.
- Never put a production bearer credential in tracked files, generated screenshots, logs, PR text, or shell history examples. Examples use `<TRIP_AGENT_CREDENTIAL>` and tell the operator where to store it with owner-only permissions.
- The setup flow must not label the connector active until the organizer mapping is confirmed and the identity/privacy notice has a provider delivery receipt.
- OpenClaw and Hermes docs are version-sensitive. Recheck their official MCP and WhatsApp pages during implementation and update exact config keys when the installed version differs.
- Follow red-green-refactor for helpers/routes and verify the actual provider end-to-end before claiming that provider supported.

---

## File responsibility map

| File | Responsibility |
|---|---|
| `components/AgentConnectionSetup.tsx` | Organizer-only setup, pairing, readiness, policy, pause/rotate/revoke |
| `components/AgentParticipantMappings.tsx` | Confirm/revoke suggested WhatsApp-to-traveler mappings |
| `lib/trip-agent-setup.ts` | Pure setup-step/readiness presentation and provider-safe config generation |
| `docs/connectors/trip-agent-group-prompt.md` | Canonical provider-neutral behavior contract copied into group configuration |
| `docs/connectors/trip-agent-privacy-notice.md` | Exact `v1` activation notice and explanation |
| `docs/connectors/openclaw-whatsapp.md` | OpenClaw install, MCP, group allowlist, prompt, probe, recovery |
| `docs/connectors/hermes-whatsapp.md` | Hermes bot, access control, MCP, prompt, batching, recovery |
| `scripts/smoke-trip-agent-mcp.mjs` | Credential-safe MCP initialize/list/read smoke test |
| `scripts/verify-trip-agent-setup.mjs` | Provider-neutral readiness and activation-state check |

## Task 1: Add pure setup and readiness presentation

**Files:**

- Create: `lib/trip-agent-setup.ts`
- Create: `lib/__tests__/trip-agent-setup.test.ts`

- [ ] Write failing table tests for the ordered steps `not_connected`, `pairing`, `paired`, `group_registered`, `organizer_mapping_needed`, `ready_for_notice`, `active`, `paused`, `revoked`, and `archived`.
- [ ] Add provider config-generator tests proving URLs and non-secret fields are escaped, bearer values are always rendered as `<TRIP_AGENT_CREDENTIAL>`, the exact MCP tool allowlist is present, and no wildcard group instruction is generated.
- [ ] Implement `connectionSetupStep(connection, readiness)` and provider snippets. The OpenClaw snippet must use a Streamable HTTP server named `trip-planner`, static `Authorization: Bearer <TRIP_AGENT_CREDENTIAL>`, the exact tool include list, `openclaw mcp doctor trip-planner --probe`, and one explicit `channels.whatsapp.groups["<GROUP_JID>"]` entry with the canonical system prompt.
- [ ] The Hermes snippet must use `~/.hermes/config.yaml` `mcp_servers.trip_planner.url`, an Authorization header, `tools.include`, bot mode, access control, `unauthorized_dm_behavior: ignore`, and the default five-second WhatsApp batching. It must recommend a dedicated bot number.
- [ ] Run the focused test and commit.

## Task 2: Build the organizer connection setup surface

**Files:**

- Create: `components/AgentConnectionSetup.tsx`
- Create: `components/AgentParticipantMappings.tsx`
- Modify: `components/TripBoard.tsx`
- Modify: `lib/trip-agent-setup.ts`

- [ ] Add pure reducer tests for request pairing, pairing expiry, refresh status, pause, resume, rotate, revoke, policy update, mapping confirm/revoke, and provider/API failures. Do not add a second client state library.
- [ ] Implement an organizer-only “Trip agent” card in the advanced board. Travelers must not see connection metadata, participant hints, action history, or controls.
- [ ] Present setup as one current action at a time: choose OpenClaw/Hermes; issue ten-minute code; enter the code in the connector; wait for group registration; confirm organizer mapping; optionally confirm travelers; review authority; copy privacy notice; wait for delivery receipt; show active.
- [ ] The pairing code is displayed once with an expiry countdown and a copy button. Never put it in a URL or local storage. A refresh after issuance shows only “pairing pending,” not the code.
- [ ] Show the generated provider snippet with placeholders, not the live credential. The live credential exists only in the connector's pairing response.
- [ ] Implement pause/resume as reversible controls, rotation with an explicit organizer confirmation, and revoke with a clear “old credential stops immediately” warning. Use the existing REST APIs; never write connection tables from the client.
- [ ] Render recent action history from the redacted API as time, actor label, operation, authority outcome, status, and announcement delivery—never raw request/result JSON.
- [ ] Run `npm test -- lib/__tests__/trip-agent-setup.test.ts`, `npm run lint`, and `npm run build`; commit.

## Task 3: Write the canonical group behavior contract

**Files:**

- Create: `docs/connectors/trip-agent-group-prompt.md`
- Create: `docs/connectors/trip-agent-privacy-notice.md`
- Create: `lib/trip-agent-wording.ts`
- Create: `lib/__tests__/trip-agent-wording.test.ts`

- [ ] Add snapshot-style tests for the exact activation notice and for concise reply frames: answer, research with verification caveat, change preview, proposal opened, confirmation needed, success, refusal, stale action, external outcome unknown, and proactive alert.
- [ ] The canonical prompt must say: identify as the organizer-supplied trip AI; Trip Planner is source of truth; answer only direct mentions/replies, clear trip requests, unambiguous shared-state questions, or approved proactive triggers; ignore unrelated family conversation; treat overheard agreements as candidates requiring confirmation; call tools before claiming current state or success; never expose private reservation identity/documents; never turn a poll response into a vote unless mapped to a confirmed traveler; announce every shared-state change.
- [ ] It must require a fresh UUID `requestId` for each logical request and reuse that same ID on retry. A new user intent gets a new ID. It must pass the provider's stable group identifier as `externalGroupId` and sender identifier as `externalParticipantId`, never their display names.
- [ ] Add the exact `v1` notice: “Hi — I’m the trip AI supplied by <organizer>. I can read the shared plan, answer trip questions, prepare or carry out permitted changes, and send important trip alerts. The organizer controls my access and can pause or remove me. I save structured trip facts, decisions, and action records—not unrelated group chat. Unmatched participants can ask questions but cannot change or vote on the plan.”
- [ ] Wording must be short enough for WhatsApp and must not claim delivery before the provider returned a visible outbound message ID.
- [ ] Run wording tests and commit.

## Task 4: Document and verify OpenClaw

**Files:**

- Create: `docs/connectors/openclaw-whatsapp.md`
- Create: `scripts/smoke-trip-agent-mcp.mjs`
- Modify: `package.json`

- [ ] Document prerequisites: current OpenClaw, linked WhatsApp account, one known group JID, a deployed HTTPS Trip Planner, pairing code, and an owner-only place for the returned credential.
- [ ] Document the exact sequence: pair; save remote Streamable HTTP MCP entry; apply the exact tool allowlist; run `openclaw mcp status --verbose`; run `openclaw mcp doctor trip-planner --probe`; add only the selected group JID under `channels.whatsapp.groups`; keep group admission and sender authorization separate; add the group-specific canonical prompt; register group/participants; confirm organizer mapping in the app; post notice; activate.
- [ ] Default `requireMention` to `false` only for the explicitly allowlisted trip group because the approved behavior also responds to clear trip questions. The prompt—not a wildcard group entry—must enforce restrained replies. Explain that setting `groups["*"]` would admit every group and is not the recommended setup.
- [ ] State that OpenClaw regards a reply delivered only after Baileys returns a visible outbound message ID; pass that receipt to `report_group_announcement`/`activate_trip_agent`.
- [ ] Implement `npm run smoke:trip-agent` using `TRIP_AGENT_MCP_URL` and `TRIP_AGENT_CREDENTIAL`. It initializes MCP, asserts the exact tool inventory, calls `get_trip_agent_readiness` when paired or `get_trip_context` when active, redacts the credential in errors, and exits nonzero on mismatch.
- [ ] Against a non-production test trip, run the smoke script and `openclaw mcp doctor trip-planner --probe`; record commands/results in the PR without secrets.
- [ ] Manually verify: unrelated family sentence gets no reply; mention gets an answer; plan question uses current canonical data; unmatched write is refused; organizer reversible change previews then applies once; duplicate delivery returns stored result; connector outage leaves web app working.
- [ ] Commit docs/script/package changes.

## Task 5: Document and verify Hermes

**Files:**

- Create: `docs/connectors/hermes-whatsapp.md`
- Modify: `scripts/verify-trip-agent-setup.mjs`
- Modify: `package.json`

- [ ] Document prerequisites and `hermes whatsapp` QR setup in bot mode. Require a dedicated WhatsApp number for the shared agent and owner-only protection of `~/.hermes/platforms/whatsapp/session`.
- [ ] Provide the exact `mcp_servers.trip_planner` YAML: deployed URL, Authorization bearer placeholder, 20-second request/connect timeouts, `enabled: true`, `supports_parallel_tool_calls: false`, and `tools.include` containing only the V2 inventory.
- [ ] Document WhatsApp access control with explicit trusted numbers when practical; if the whole trip group must participate, explain the risk of `WHATSAPP_ALLOWED_USERS=*` and rely on the gateway's unmatched read-only policy for writes. Set `whatsapp.unauthorized_dm_behavior: ignore`, `send_read_receipts: false`, and retain five-second batching.
- [ ] Explain native polls are presentation only. The connector must translate each vote through `vote_on_trip_change` with that sender's external identifier; it must not count the poll summary itself.
- [ ] Implement `npm run verify:trip-agent-setup` to call the deployed MCP smoke plus the organizer connection GET (with `TRIP_TOKEN` kept in an environment variable), verify group registration/organizer mapping/notice receipt/active state, and redact both credentials on every error path.
- [ ] Manually run the same behavioral matrix as OpenClaw, including a Hermes native poll whose two mapped voters become two distinct canonical votes.
- [ ] Commit.

## Task 6: Add readiness, reconnection, and failure guidance

**Files:**

- Modify: `components/AgentConnectionSetup.tsx`
- Modify: `docs/connectors/openclaw-whatsapp.md`
- Modify: `docs/connectors/hermes-whatsapp.md`
- Create: `docs/architecture/trip-agent-connectors.md`

- [ ] Add UI states for paired-but-not-ready, agent offline (`last_seen_at` older than ten minutes during an active trip), delivery failure, paused, credential rotated but provider not updated, revoked, and archived.
- [ ] Never auto-resume or replay queued material actions after an outage. The UI says pending previews/confirmations must be revalidated; expired ones remain expired.
- [ ] Document recovery: provider probe; verify selected group; replace credential after organizer rotation; re-register group if intentionally changed; confirm new mappings; repost notice only when group changes; resume from planner.
- [ ] Add an organizer checklist for the provider's own transcript/log retention, credential storage, and WhatsApp session backups. State explicitly that the planner's structured-only retention cannot control OpenClaw/Hermes local history.
- [ ] Architecture docs must record provider ownership, raw-identifier HMAC boundary, why a first-party WhatsApp bot is deferred, how actual delivery is acknowledged, and the limitation that provider configuration remains an operator step.
- [ ] Commit.

## Task 7: Validate, publish, deploy, and update status

**Files:**

- Modify: `README.md`
- Modify: `ROADMAP.md`

- [ ] Link the connector guides from README and add a non-technical “Connect your trip agent” overview. Keep provider secrets and command examples out of screenshots.
- [ ] Update the roadmap to show OpenClaw/Hermes onboarding implemented but not shipped until both providers pass deployed verification. Keep proactive monitoring and mobile companion open.
- [ ] Run `rg -n "TODO|TBD|FIXME|<actual|Bearer [A-Za-z0-9_-]{20}" docs/connectors docs/architecture/trip-agent-connectors.md components/AgentConnectionSetup.tsx scripts`; expect no secret-like material or unresolved placeholder other than the documented literal `<TRIP_AGENT_CREDENTIAL>`.
- [ ] Run `npm test`, `npm run lint`, `npm run build`, `npm run smoke:trip-agent`, and `npm run verify:trip-agent-setup` against a test trip.
- [ ] Push and open a PR documenting purpose, user/developer impact, no new migration, deployment/configuration, rollback, validation for both providers, privacy, and screenshots of every setup state with secrets masked.
- [ ] Merge through GitHub, fast-forward local `master`, deploy, and repeat the behavioral matrix with one real allowlisted WhatsApp group for OpenClaw and Hermes.
- [ ] Verify pause and revoke from the production app take effect on the next tool call, and that the web board remains usable while each provider gateway is stopped.
- [ ] After production verification, update `ROADMAP.md` in the same turn/PR to mark the verified connector(s) shipped. If only one provider passes, mark only that provider shipped and leave the other explicitly open.
