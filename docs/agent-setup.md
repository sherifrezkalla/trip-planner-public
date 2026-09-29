# Connect your own agent

**Optional advanced preview.** The normal web app does not need an external agent. This guide explains the process in everyday language; a technical operator still needs to perform the provider-side installation and configuration.

## What you need

- An existing, working Trip Planner installation and your organizer identity.
- Your own running OpenClaw or Hermes agent with working model-provider access.
- A provider-supported WhatsApp setup and one group whose members know an assistant will participate.
- Someone able to configure that provider safely. The app does not currently offer a no-code installer.

[Hermes instructions](connectors/hermes-whatsapp.md) and [OpenClaw instructions](connectors/openclaw-whatsapp.md) contain the operator steps. Neither provider's full live-group behavior is certified. Instinct and other providers are not currently documented as supported connectors.

## The connection flow

1. **Choose your assistant.** Open the organizer's **Trip agent** card and choose the provider. This chooses the integration; it does not install the agent.
2. **Pair privately.** Issue a ten-minute, single-use code. The operator exchanges it on the agent machine and stores the returned credential securely. Never post either value in a group chat or public issue.
3. **Identify the group.** The operator registers the chosen group using identifiers from real provider events. A group invitation URL is not a Trip Planner pairing code.
4. **Confirm yourself.** In the app, match the observed WhatsApp participant to your human organizer identity. Verify the participant using WhatsApp; a display name alone is not proof. Other travelers need their own confirmed mappings before protected actions.
5. **Review permissions.** Read the authority settings and choose the access you intend to grant.
6. **Disclose and activate.** The connector sends the exact privacy notice once, records the real message receipt, and activates. Copying the notice in the app does not prove delivery.
7. **Test the whole path.** From your confirmed human account, ask the assistant a simple trip question in the selected group. Verify that it reads the current plan and replies in the group.

**Paired**, **active**, and **successfully answered in WhatsApp** are different milestones. Do not call setup complete based only on the first two.

## Existing WhatsApp accounts

Tell the operator if the number already runs other workflows. Preserve its session and use a supported group-specific route or dedicated profile. Do not reset its login, duplicate a bridge against the same session, overwrite shared configuration, or run two agents responding to the same group without a deliberate routing design.

A model quota failure is independent of WhatsApp pairing. Restore model access and repeat the read-only question test; do not resend the notice or repeat activation merely because the model failed.

## Stop or change access

Use **Pause** to stop canonical Trip Planner access, or **Revoke** to remove the connector's authorization. Follow the provider guide when rotating credentials or changing groups. Those controls govern Trip Planner access; the provider's own chat history and account access have separate controls.

## The simpler experience we intend to build

A future installer/provider handoff should handle secure pairing, compatible tool configuration, group selection, identity confirmation, and a real test without editing configuration files. That flow is not implemented yet. For now, use the web app independently or ask a technical operator to follow one supported provider guide.
