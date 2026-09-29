# OpenClaw WhatsApp connector

Status: operator preview. Configuration references were checked on 2026-09-23; no installed OpenClaw runtime or live WhatsApp group was verified for this release. A successful app deployment or repository smoke test does not establish provider compatibility. The gateway requires MCP **2026-07-28**, stateless POST Streamable HTTP; prove that the installed provider negotiates this revision before activation.

## Prepare and pair

You need an organizer trip link, deployed HTTPS Trip Planner, an OpenClaw account with WhatsApp linked, and the selected group's stable JID. Use a dedicated bot number where possible. In the board's **Trip agent** card choose OpenClaw and issue a pairing code. It expires after ten minutes and works once.

On the provider host, use a private HTTP client to make this request to the deployment origin. Fill the placeholder privately; disable request history, response logging, and redirects. Never paste secrets into group chat, command arguments, screenshots, or tracked files.

```http
POST /api/trip-agent/pair
Content-Type: application/json

{"pairingCode":"<PAIRING_CODE>","provider":"openclaw"}
```

Save the response's `credential` in the provider's owner-only credential/configuration storage (files mode `0600`, containing directories `0700`). The response also supplies `mcpUrl`, `connectionId`, `tripId`, and `status: "paired"`. Use that exact HTTPS `mcpUrl`; the bearer is returned only once. Pairing with Trip Planner and linking WhatsApp by QR are separate steps.

## Configure MCP and the selected group

Merge this fragment into the provider configuration. Replace the credential placeholder only in private provider storage, the URL with the pairing response, and `<GROUP_JID>` with the selected group. Copy the complete [canonical group prompt](trip-agent-group-prompt.md) into `systemPrompt`, preserving JSON escaping. Review existing account-level overrides before saving.

```json
{
  "mcp": {
    "servers": {
      "trip-planner": {
        "url": "https://trip-planner.example/api/mcp",
        "transport": "streamable-http",
        "connectionTimeoutMs": 20000,
        "requestTimeoutMs": 20000,
        "supportsParallelToolCalls": false,
        "headers": { "Authorization": "Bearer <TRIP_AGENT_CREDENTIAL>" },
        "toolFilter": {
          "include": [
            "register_trip_group", "get_trip_agent_readiness", "activate_trip_agent",
            "get_trip_context", "get_today_plan", "search_trip_options",
            "get_pending_trip_decisions", "report_group_announcement",
            "preview_trip_change", "commit_trip_change", "vote_on_trip_change", "decide_trip_change"
          ]
        }
      }
    }
  },
  "channels": {
    "whatsapp": {
      "groupPolicy": "allowlist",
      "groupAllowFrom": ["<TRUSTED_PARTICIPANT_E164>"],
      "groups": {
        "<GROUP_JID>": {
          "requireMention": false,
          "systemPrompt": "<COPY_CANONICAL_GROUP_PROMPT>"
        }
      }
    }
  }
}
```

The provider's `toolFilter.include` limits exposed tools. Select a messaging-capable runtime profile and verify discovery there. See the official [MCP registry](https://docs.openclaw.ai/cli/mcp/registry) and [Streamable HTTP transport](https://docs.openclaw.ai/cli/mcp/transports) documentation for these keys.

`groups` admits groups; `groupAllowFrom` authorizes senders separately. Add each intended participant's trusted E.164 number. Do not add a wildcard group: that admits every group at that scope. `requireMention: false` permits clear trip questions; the canonical prompt must suppress unrelated conversation. Link the intended WhatsApp account, if necessary, with `openclaw channels login --channel whatsapp`. These settings and QR linking follow the official [WhatsApp guide](https://docs.openclaw.ai/channels/whatsapp).

Probe from the provider host:

```sh
openclaw mcp status --verbose
openclaw mcp doctor trip-planner --probe
```

A saved configuration is insufficient: require successful live initialization, the exact twelve-tool inventory, and a read tool call. Stop on a protocol error; do not claim support by substituting a legacy SSE transport.

## Register, disclose, activate

1. From trusted provider event metadata, call `register_trip_group` with a fresh UUID `requestId`, `externalGroupId`, `groupLabel`, and `participants` containing stable `externalParticipantId` values and optional `displayNameHint`. Reuse a request ID only for the same logical retry. Names and message text never establish identity.
2. Refresh the app. Confirm the human organizer's suggested mapping to their traveler record, confirm other known travelers, and review operational scopes and authority. Unmatched people can use permitted reads after activation, but cannot change or vote on the plan.
3. Call `get_trip_agent_readiness` with the same stable group JID and a new request UUID. Resolve its missing prerequisites.
4. Send the exact [v1 notice](trip-agent-privacy-notice.md) to the selected group. Obtain the provider's actual visible outbound message ID. Call `activate_trip_agent` with a fresh request UUID, `externalGroupId`, `privacyNoticeVersion: "v1"`, and that ID as `deliveryReceiptId`. Never invent a receipt or equate generated text with delivery.
5. Refresh the board and perform the verification below. Later shared changes require a real group announcement and `report_group_announcement` with its provider message ID. The planner records the connector's assertion; it cannot independently verify WhatsApp delivery.

## Verify before calling this supported

Inject `TRIP_AGENT_MCP_URL`, `TRIP_AGENT_CREDENTIAL`, and `TRIP_AGENT_GROUP_ID` through private environment/secret storage. From this repository run `npm run smoke:trip-agent`. For a complete active setup also supply the organizer's `TRIP_SLUG` and `TRIP_TOKEN`, then run `npm run verify:trip-agent-setup`. Keep the organizer token out of the provider config. Both scripts are read-only: neither posts the notice nor activates or sends messages. Routine authentication/rate-limit telemetry may still update.

On a consented test group, record installed provider version, deployment, date, and pass/fail evidence without secrets or chat transcripts:

- Unrelated conversation gets silence; a direct mention and clear plan question fetch current canonical data.
- An unmatched sender's write is refused; a mapped organizer's permitted reversible change previews and applies once. Exact retry does not duplicate it.
- The notice and change announcements return real message IDs. Failed or uncertain delivery is not reported as successful.
- Pause and revoke block the next call. Stopping the provider leaves the web board usable.

## Recovery and retention

Probe the provider and verify the selected group before resuming. A stale last-contact timestamp signals uncertainty, not proof the bot is offline. On rotation, explicitly confirm in the app, privately replace the bearer, reload the provider connection, and rerun the probe. The old bearer stops immediately. Do not replay queued material actions after downtime: re-read the plan and revalidate previews and confirmations.

Changing the bound group requires revoking and pairing a new connection generation, registering the new group, confirming mappings, and delivering a fresh notice. Revoked/archived credentials cannot resume. Stop provider retries after pause/revoke; use the app's controls intentionally.

Review the provider's transcript retention, model data handling, log redaction, and encrypted session backups. Protect WhatsApp session credentials as account access. Trip Planner's structured-only storage does not delete or govern provider-local chat history. See [architecture and limitations](../architecture/trip-agent-connectors.md).
