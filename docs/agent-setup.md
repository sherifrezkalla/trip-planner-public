# Connect your own agent

**Optional guided setup preview.** The normal web app does not need an external agent. The organizer card now gives you a step-by-step path and a setup brief to share with your existing assistant. A capable local assistant or technical operator still performs provider-side configuration; the app does not install or host an agent.

## What you need

- An existing, working Trip Planner installation and your organizer identity.
- Your own running OpenClaw or Hermes agent with working model-provider access.
- A provider-supported WhatsApp setup and one group whose members know an assistant will participate.
- Someone able to configure that provider safely. The app does not currently offer a no-code installer.

[Hermes instructions](connectors/hermes-whatsapp.md) and [OpenClaw instructions](connectors/openclaw-whatsapp.md) contain the operator steps. Neither provider's full live-group behavior is certified. Instinct and other providers are not currently documented as supported connectors.

## The connection flow

1. **Choose your assistant.** Open the organizer's **Trip agent** card and choose Hermes or OpenClaw. If you do not have one, open **I don’t have an assistant yet**; you can keep using the web app independently. Copy the **setup brief** into a private conversation with your capable local assistant, or share it with its operator. You can read the brief before copying. It contains no trip data or access credentials, and copying does not pair or activate anything.
2. **Pair privately.** Wait until your assistant or operator is ready, then issue a ten-minute, single-use code. Enter the code only through its secure local setup input, never an AI chat. The operator exchanges it on the agent machine and stores the returned credential securely. Never post either value in a group chat or public issue.
3. **Identify the group.** The operator registers the chosen group using identifiers from real provider events. A group invitation URL is not a Trip Planner pairing code.
4. **Confirm yourself.** In the app, match the observed WhatsApp participant to your human organizer identity. Verify the participant using WhatsApp; a display name alone is not proof. Other travelers need their own confirmed mappings before protected actions.
5. **Review permissions.** Read the authority settings and choose the access you intend to grant.
6. **Disclose and activate.** The connector sends the exact privacy notice once, records the real message receipt, and activates. Copying the notice in the app does not prove delivery.
7. **Try a first question when ready.** The active card offers a question to copy. From your confirmed personal account, mention your assistant in the selected group and ask it. You can defer this until your trip; a deferred check is not a passing one.

**Paired**, **active**, and **successfully answered in WhatsApp** are different milestones. The guided steps reflect server-confirmed setup, not a certification that every live-trip flow works. The app does not automatically mark conversation tests passed.

## Existing WhatsApp accounts

Tell the operator if the number already runs other workflows. Preserve its session and use a supported group-specific route or dedicated profile. Do not reset its login, duplicate a bridge against the same session, overwrite shared configuration, or run two agents responding to the same group without a deliberate routing design.

A model quota failure is independent of WhatsApp pairing. Restore model access and repeat the read-only question test; do not resend the notice or repeat activation merely because the model failed.

## Stop or change access

Use **Pause** to stop canonical Trip Planner access, or **Revoke** to remove the connector's authorization. Follow the provider guide when rotating credentials or changing groups. Those controls govern Trip Planner access; the provider's own chat history and account access have separate controls.

## What this guide handles—and what still needs help

The app explains the next step, prepares a credential-free [setup brief](connectors/agent-assisted-setup.md), shows connection progress, and keeps configuration templates under **Advanced setup help**. It does not remotely install software, access provider accounts, collect a pairing code on the provider’s behalf, or send WhatsApp messages. An assistant capable of secure local setup can do that work with your approval; otherwise, its operator follows the provider guide. A packaged installer and hosted-agent service remain future work.
