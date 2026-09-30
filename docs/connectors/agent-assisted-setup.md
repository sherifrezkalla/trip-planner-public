# Help an organizer connect an existing assistant

This is the procedure referenced by the organizer's **Copy setup brief** button. It is for a capable local assistant or the person operating it. The brief contains only the provider, installation address, and public instructions; it intentionally excludes the trip link, identity token, roster, pairing code, and connector credential.

## 1. Establish what is available

Confirm the organizer's chosen trip and one WhatsApp group. Inspect the installed provider version, model availability, and existing WhatsApp connection without exposing credentials. Read the matching [Hermes](hermes-whatsapp.md) or [OpenClaw](openclaw-whatsapp.md) guide, including its limitations.

If you cannot configure the provider securely on its machine, stop and give the organizer a short explanation of what its operator needs to do. Do not claim the brief installs an agent. Do not request account credentials in chat or make purchases. The app supplies neither agent hosting nor a WhatsApp account.

## 2. Prepare a scoped connection

Preserve the existing WhatsApp session, unrelated routes, sender restrictions, and assistant identity. Back up affected settings privately. Prefer a dedicated trip profile and one explicit group route. Inspect existing configuration before merging individual keys; never replace a whole configuration with a template. Do not enable all groups or all senders, duplicate an active bridge, or re-pair an already working account.

The copied installation origin is the expected destination. Verify it with the organizer before transmitting the pairing code. Never use a trip/resume link as the endpoint or send setup credentials to a redirect target.

## 3. Pair through secure local input

Only when the runtime is ready, ask the organizer to generate a ten-minute pairing code in the app. Collect it through an input excluded from model/chat transcripts, command arguments, history, screenshots, and logs, such as a private local password prompt. If no secure input is available, ask the operator to perform this step; do not fall back to pasting the code into chat.

Exchange it at the installation's `/api/trip-agent/pair` endpoint with the selected provider using HTTPS, redirects disabled, and a bounded timeout. Store the once-returned credential in owner-only provider storage and configure the exact returned MCP endpoint. Never echo the bearer or install an organizer token. Follow the provider guide for protocol, tool filtering, scoped routing, and canonical group instructions. Verify real MCP discovery and readiness, not just a written config file.

If an exchange has an uncertain outcome, read the app's connection state before retrying. A missing once-returned credential requires the documented organizer recovery/rotation flow; do not create repeated connections blindly.

## 4. Confirm group, identity and access

Use a real provider event to obtain stable group and sender identifiers. A WhatsApp invitation URL or matching display name is insufficient. Register only the group the organizer selected. Ask them to return to the app and match their personal WhatsApp account to their human organizer identity, then review permissions. Never approve mappings, elevate participants, or grant additional access on their behalf.

## 5. Disclose, activate and hand back

Obtain explicit organizer approval before sending anything to the group or activating. Send the exact privacy notice once, capture the actual provider receipt, and activate with that receipt. Do not invent a receipt or treat copying the notice as delivery. Preserve request IDs for exact retries, and re-read state after an uncertain result. Do not mutate the itinerary during setup.

Keep messages appropriate for travelers: hide tool-progress output, reasoning, and intermediate technical commentary where the installed provider supports it. The Hermes guide includes scoped quiet-display settings. Preserve other profiles' preferences.

Explain whether the connection is paired, active, or has also answered a real WhatsApp question. Offer a first question from the organizer's personal account. If they defer testing until a live trip, record the deferral rather than a passing test. Broader change/vote/recovery tests remain separate from this first conversation.
