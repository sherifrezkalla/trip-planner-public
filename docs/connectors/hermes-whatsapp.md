# Hermes WhatsApp connector

Status: operator preview. Official references checked on 2026-09-23. On 2026-09-27, installed Hermes **0.21.5** passed actual MCP transport discovery/readiness and production activation using a real WhatsApp privacy-notice receipt. A real read-only group question completed on 2026-09-30 after model access recovered. Remaining live-trip checks and native polls are deferred and remain unverified. See [checkpoint evidence](../architecture/trip-agent-connectors-release.md#hermes-activation-checkpoint--2026-09-27). The gateway requires MCP **2026-07-28**, stateless POST Streamable HTTP; verify each installed version rather than assuming compatibility.

## Prepare and pair

Use a dedicated bot number and a dedicated trip-agent profile/instance. Hermes profiles separate configuration, sessions, and memory; they do not sandbox filesystem access. Follow the official [profile guide](https://hermes-agent.nousresearch.com/docs/user-guide/profiles). All paths below refer to that selected profile's home (the default is `~/.hermes`).

For a new WhatsApp installation, run `hermes whatsapp` in that profile, select bot mode, and scan the QR using the intended bot account. If the account is already connected to a shared gateway, preserve its session and route only the selected group to a dedicated trip profile; do not re-pair or start a second bridge against the same session. Locate the bridge’s actual session directory (the verified 0.21.5 installation uses `whatsapp/session` under its owning profile home) and protect it with owner-only permissions and private backups; it contains account credentials. The current [WhatsApp guide](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp) documents this Baileys bridge.

In the organizer's Trip agent card select Hermes and issue the ten-minute single-use code. Exchange it from a private HTTP client on the provider host, over HTTPS to the Trip Planner deployment. Disable history, logs, and redirects:

```http
POST /api/trip-agent/pair
Content-Type: application/json

{"pairingCode":"<PAIRING_CODE>","provider":"hermes"}
```

Save the once-returned `credential` in owner-only provider storage (secret files `0600`, containing directories `0700`); use the response's exact `mcpUrl`. The response also identifies the connection/trip and `status: "paired"`. Never put the code, bearer, or organizer token in chat, screenshots, shell history, or this repository.

## Configuration

Merge into the selected profile's private `config.yaml`. Replace placeholders locally. The [official MCP guide](https://hermes-agent.nousresearch.com/docs/user-guide/features/mcp) documents URL/header configuration, timeouts, filtering, and `/reload-mcp`.

```yaml
mcp_servers:
  trip_planner:
    url: "https://trip-planner.example/api/mcp"
    headers:
      Authorization: "Bearer <TRIP_AGENT_CREDENTIAL>"
    protocol: stateless
    timeout: 20
    connect_timeout: 20
    enabled: true
    supports_parallel_tool_calls: false
    tools:
      include:
        - register_trip_group
        - get_trip_agent_readiness
        - activate_trip_agent
        - get_trip_context
        - get_today_plan
        - search_trip_options
        - get_pending_trip_decisions
        - report_group_announcement
        - preview_trip_change
        - commit_trip_change
        - vote_on_trip_change
        - decide_trip_change
      prompts: false
      resources: false
whatsapp:
  group_policy: allowlist
  group_allow_from: ["<GROUP_JID>"]
  require_mention: false
  unauthorized_dm_behavior: ignore
  send_read_receipts: false
```

Set `WHATSAPP_ENABLED=true`, `WHATSAPP_MODE=bot`, and an explicit comma-separated `WHATSAPP_ALLOWED_USERS` list of trusted phone numbers (country code, no `+`) in the selected profile's private `.env`. With no sender allowlist, `allowlist` trusts every participant of the listed group. Do not use `WHATSAPP_ALLOWED_USERS=*`, `WHATSAPP_ALLOW_ALL_USERS=true`, or open group policy. Leave batching defaults unchanged: current documentation says **0.3 seconds**, extended to **1 second** for long fragments, not the older plan's five seconds. See [WhatsApp access and batching](https://hermes-agent.nousresearch.com/docs/user-guide/messaging/whatsapp).

Install the complete [canonical group prompt](trip-agent-group-prompt.md) as durable instructions in this dedicated instance's `SOUL.md`, including the one selected group's identity and the organizer name. Start a fresh session so instructions are loaded. [Hermes documents `SOUL.md` as instance-wide](https://hermes-agent.nousresearch.com/docs/user-guide/features/personality); do not overwrite a shared personal assistant's identity. The prompt controls conversational restraint; provider admission and Trip Planner authority enforce access.

Reload MCP using `/reload-mcp` in Hermes, start the selected profile's gateway, and verify its discovery lists exactly the twelve allowed tools. Hermes may expose them with `mcp_trip_planner_` prefixes; the include list uses the original server names. Require a live readiness call, not only a configuration listing. If initialization fails because of the protocol revision, leave this provider unverified.

## Reusing an existing shared gateway

The verified 0.21.5 installation kept its existing WhatsApp bridge in the default profile and used `gateway.multiplex_profiles: true` with a top-level `profile_routes` entry matching only the selected WhatsApp `chat_id`. The destination trip profile disabled its own WhatsApp adapter and used `platform_toolsets.whatsapp: ["mcp-trip_planner"]`; discovery exposed only the twelve allowed Trip Planner tools. Group admission and existing sender restrictions remained on the gateway that owns the bridge. Apply the WhatsApp enablement settings above to that owning gateway, not to a second adapter.

Inspect the installed version and migration dry run before changing topology. Back up affected settings and service definitions privately, compare semantic changes, and preserve unrelated profiles. In this installation, `gateway.standalone: true` kept five existing profile services outside the shared gateway; this is a version-specific compatibility setting, not a blanket migration recommendation. Do not overwrite shared configuration or `SOUL.md`.

The migration command applied its changes but could not confirm the gateway through its PID helper. Independent runtime liveness and the local control socket confirmed the expected process and served profiles. A successful live control response is recorded separately from the CLI warning; do not repeatedly rerun migration to clear it.

## Register and activate

Follow the [registration and activation sequence](openclaw-whatsapp.md#register-disclose-activate): send stable group/sender identifiers from trusted provider events to `register_trip_group`, confirm the human organizer mapping in the app, review scopes/policy, check readiness, send the exact [v1 notice](trip-agent-privacy-notice.md), then activate using the actual outbound message ID as `deliveryReceiptId`. Use fresh UUID request IDs for new intents and preserve the ID for an exact retry.

For later changes, announce the confirmed result and report its real message ID through `report_group_announcement`. A generated reply or successful MCP mutation is not evidence of WhatsApp delivery.

Native polls are presentation only. To affect the plan, resolve each individual respondent's trusted external identifier and call `vote_on_trip_change` once per logical vote, subject to confirmed traveler mapping and the current proposal. Never turn aggregate poll counts into votes or invent sender identities. If the installed Hermes integration cannot expose individual poll events reliably, use explicit text votes and leave native-poll support unverified.

## Verification and recovery

Use private environment injection for `TRIP_AGENT_MCP_URL`, `TRIP_AGENT_CREDENTIAL`, and `TRIP_AGENT_GROUP_ID`, then run `npm run smoke:trip-agent` from this repository. For full active-state verification additionally supply `TRIP_SLUG` and the organizer's `TRIP_TOKEN` and run `npm run verify:trip-agent-setup`. Neither script sends messages or activates the connection; authentication/rate-limit telemetry may update. Never install the organizer token in Hermes.

Run the [behavioral verification matrix](openclaw-whatsapp.md#verify-before-calling-this-supported) on a consented test group. Additionally prove two mapped Hermes poll respondents produce two distinct canonical votes, with exact retries not adding votes, before claiming native-poll support. Record provider version, deployment, date, and outcomes without credentials or transcripts.

For outages, check MCP discovery and group admission, then re-read canonical state before any pending action. Rotation is manual: confirm in the app, replace the bearer privately, reload, and probe. Expired previews/confirmations stay expired. Pause/revoke must stop retries; never auto-resume. To change groups, revoke and pair again, register the new group, reconfirm mappings, and post a fresh notice.

Review Hermes/model transcript retention and log/backup access independently. The planner stores structured records, but cannot control Hermes history or its WhatsApp session backup. See [architecture and limitations](../architecture/trip-agent-connectors.md).

## Quiet replies for travelers

On versions supporting per-platform display settings, merge these keys into the dedicated trip profile. Preserve existing configuration and other profiles; back up affected settings privately first. These settings hide technical tool-progress bubbles and intermediate commentary, without changing trip permissions. Already-posted messages are unaffected. Verify the effective settings against the installed runtime.

```yaml
display:
  platforms:
    whatsapp:
      tool_progress: "off"
      show_reasoning: false
      interim_assistant_messages: false
      streaming: false
      long_running_notifications: false
      busy_ack_detail: false
```
