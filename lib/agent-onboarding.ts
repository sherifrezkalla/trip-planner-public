import type { TripAgentProvider } from "./trip-agent-contracts";
import type { SetupStep } from "./trip-agent-setup";

export const CONNECTOR_GUIDE_BASE = "https://github.com/sherifrezkalla/trip-planner-public/blob/master/docs/connectors";

/** Accept only the installation origin. Never derive this from a private trip URL. */
export function installationMcpUrl(siteUrl: string | undefined): string {
  if (!siteUrl?.trim()) throw new Error("Missing installation address");
  const url = new URL(siteUrl.trim());
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("Use a canonical HTTPS origin without credentials, paths or query parameters");
  }
  return `${url.origin}/api/mcp`;
}

/** Deliberately accepts no trip identity, pairing code, bearer, roster or group identifier. */
export function agentSetupBrief(provider: TripAgentProvider, siteUrl: string | undefined): string {
  const endpoint = installationMcpUrl(siteUrl);
  const name = provider === "hermes" ? "Hermes" : "OpenClaw";
  return [
    `Help me connect my existing ${name} assistant to Trip Planner.`,
    `Trip Planner installation: ${new URL(endpoint).origin}`,
    `MCP endpoint: ${endpoint}`,
    `Setup procedure: ${CONNECTOR_GUIDE_BASE}/agent-assisted-setup.md`,
    `Provider guide: ${CONNECTOR_GUIDE_BASE}/${provider}-whatsapp.md`,
    "",
    "First inspect the installed version and available capabilities without printing credentials. Explain what you can do and what needs my help. If you cannot securely configure the running assistant, stop and give me a short handoff for its operator; do not claim setup is complete.",
    "Preserve the existing WhatsApp login, configuration, other groups and workflows. Back up affected settings privately and make only reviewed, scoped changes for one trip and one group. Never reset a session, overwrite shared configuration or enable all senders/groups.",
    "Ask me which trip and WhatsApp group to use before connecting. A group invitation link is not a Trip Planner pairing code. Do not infer group or sender identifiers from names; use trusted provider events.",
    "When ready to pair, ask me to generate a ten-minute code in the Trip agent card. Collect it through a private secure local input, not chat, command arguments, logs or screenshots. Never request my organizer/resume token, database key, WhatsApp session files or model API key in chat. Store the returned connector credential securely and never echo it.",
    "After pairing and group registration, ask me to return to Trip Planner to confirm my personal WhatsApp identity and review permissions. Never confirm identity on my behalf or grant extra access.",
    "Before any group message or activation, ask for my explicit approval. Send the exact privacy notice only after approval, obtain its real WhatsApp receipt, then activate. Never invent a receipt or treat copied text as delivery. Preserve request IDs for exact retries and re-read state after an uncertain result.",
    "Use the complete canonical group instructions in the provider guide. Keep replies nontechnical: final answers only, with tool-progress and intermediate commentary hidden where supported. Do not make itinerary changes as part of setup.",
    "Offer a simple trip question from my personal WhatsApp account as a final check. If I defer it, record connected but conversation check deferred; never claim an untested flow is verified.",
  ].join("\n");
}

export const ONBOARDING_STAGES = ["Choose assistant", "Connect privately", "Choose group", "Confirm access", "Start chatting"] as const;

export function onboardingStage(step: SetupStep): number | null {
  switch (step) {
    case "not_connected": case "revoked": case "archived": return 0;
    case "pairing": return 1;
    case "paired": return 2;
    case "group_registered": case "organizer_mapping_needed": return 3;
    case "ready_for_notice": return 4;
    case "active": case "paused": return null;
  }
}

export const ONBOARDING_GUIDANCE: Record<SetupStep, { title: string; description: string }> = {
  not_connected: { title: "Bring the assistant you already use", description: "Choose Hermes or OpenClaw, then give it the setup brief below. Keep this page open while it helps you connect." },
  pairing: { title: "Connect in private", description: "Give the code only to your assistant’s secure setup input. Never paste it into WhatsApp or an AI chat. This page checks for progress automatically." },
  paired: { title: "Choose your WhatsApp group", description: "Your assistant is paired. Tell it which group to connect and send a message from your personal account when it asks. It should preserve your existing WhatsApp login." },
  group_registered: { title: "Review what your assistant can do", description: "Review and save access below. You remain in control of the trip and can pause the assistant later." },
  organizer_mapping_needed: { title: "Confirm your personal WhatsApp identity", description: "Match your own WhatsApp account to yourself below, not the assistant’s number. Check the account in WhatsApp before confirming; a matching name is not enough." },
  ready_for_notice: { title: "Introduce the assistant to your group", description: "Review permissions below, then tell your assistant it may send the privacy notice and activate. Wait for this page to confirm the connection." },
  active: { title: "Your assistant is connected", description: "Ask it about the trip from your personal account in the selected WhatsApp group. Connection status confirms setup; it does not prove every conversation or trip action has been tested." },
  paused: { title: "Your assistant’s trip access is paused", description: "Your trip is still available in the web app. Resume only when you are ready; previous actions will not be replayed automatically." },
  revoked: { title: "Connect again when you’re ready", description: "The previous connection has ended. A new connection needs a new code, identity confirmation and group notice." },
  archived: { title: "This connection is archived", description: "Start a new connection if you want to use an assistant again. The old connection cannot be resumed." },
};
