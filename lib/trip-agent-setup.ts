import type { AuthorityPolicy, TripAgentProvider, TripAgentScope } from "./trip-agent-contracts";
import toolNames from "./trip-agent-tool-names.json";
import { TRIP_AGENT_GROUP_PROMPT } from "./trip-agent-wording";

/** Operator templates only: this API deliberately accepts no credential. */
export function providerConfiguration(provider: TripAgentProvider, mcpUrl: string, groupId = "<GROUP_JID>"): string {
  const url = new URL(mcpUrl);
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.pathname !== "/api/mcp") throw new Error("Use the deployed HTTPS MCP endpoint without credentials or query parameters.");
  if (groupId !== "<GROUP_JID>" && !/^[0-9-]+@g\.us$/.test(groupId)) throw new Error("Use one explicit WhatsApp group JID.");
  const headers = { Authorization: "Bearer <TRIP_AGENT_CREDENTIAL>" };
  if (provider === "openclaw") return JSON.stringify({
    mcp: { servers: { "trip-planner": { url: url.href, transport: "streamable-http", headers, connectionTimeoutMs: 20_000, requestTimeoutMs: 20_000, supportsParallelToolCalls: false, toolFilter: { include: toolNames } } } },
    channels: { whatsapp: { dmPolicy: "disabled", groupPolicy: "allowlist", groupAllowFrom: ["<TRUSTED_PARTICIPANT_E164>"], groups: { [groupId]: { requireMention: false, systemPrompt: TRIP_AGENT_GROUP_PROMPT } } } },
  }, null, 2);
  // JSON-quoted scalars/lists are valid YAML and prevent config injection.
  return [
    "mcp_servers:", "  trip_planner:", `    url: ${JSON.stringify(url.href)}`, "    headers:",
    `      Authorization: ${JSON.stringify(headers.Authorization)}`,
    "    timeout: 20", "    connect_timeout: 20", "    enabled: true", "    supports_parallel_tool_calls: false",
    "    tools:", `      include: ${JSON.stringify(toolNames)}`, "      resources: false", "      prompts: false",
    "whatsapp:", "  unauthorized_dm_behavior: ignore", "  send_read_receipts: false",
    "  group_policy: allowlist", `  group_allow_from: ${JSON.stringify([groupId])}`,
    "# Dedicated bot number. Set WHATSAPP_MODE=bot and an explicit WHATSAPP_ALLOWED_USERS list in the provider environment.",
    "# Keep current provider batching defaults. Install the canonical group prompt in the dedicated bot profile.",
  ].join("\n");
}

export type AgentConnection = {
  id: string; provider: TripAgentProvider;
  status: "pending" | "paired" | "active" | "paused" | "revoked" | "archived";
  lifecycleGeneration: number; pairingExpiresAt: string | null;
  grantedScopes: TripAgentScope[]; authorityPolicy: AuthorityPolicy;
  agentPhoneE164: string | null; whatsappGroupLabel: string | null;
  groupRegistered: boolean; privacyNoticeDelivered: boolean;
  lastSeenAt: string | null; pairedAt: string | null; activatedAt: string | null;
  pausedAt: string | null; revokedAt: string | null; archivedAt: string | null;
  createdAt: string; updatedAt: string;
};
export type AgentMapping = {
  id: string; displayNameHint: string | null; travelerId: string | null;
  status: "suggested" | "confirmed" | "revoked";
};
export type AgentAction = {
  id: string; mappedTravelerId: string | null; operation: string; authorityDecision: string;
  status: string; announcementStatus: string; createdAt: string;
};
export type AgentSnapshot = { connection: AgentConnection | null; mappings: AgentMapping[]; recentActions: AgentAction[] };
export type SetupStep = "not_connected" | "pairing" | "paired" | "group_registered" | "organizer_mapping_needed" | "ready_for_notice" | "active" | "paused" | "revoked" | "archived";
export type SetupOperation = "pair" | "refresh" | "pause" | "resume" | "rotate" | "revoke" | "policy" | "mapping";

/** Mutation replies omit collections, which belong only to one connection generation. */
export function mutationSnapshot(previous: AgentSnapshot, connection: AgentConnection | null, operation: Exclude<SetupOperation, "refresh" | "mapping">): AgentSnapshot {
  const retainCollections = operation !== "pair" && connection !== null
    && previous.connection?.id === connection.id
    && previous.connection.lifecycleGeneration === connection.lifecycleGeneration;
  return {
    connection,
    mappings: retainCollections ? previous.mappings : [],
    recentActions: retainCollections ? previous.recentActions : [],
  };
}

export function connectionSetupStep(connection: AgentConnection | null, readiness: { organizerMapped: boolean } | null): SetupStep {
  if (!connection) return "not_connected";
  if (connection.status === "paused" || connection.status === "revoked" || connection.status === "archived") return connection.status;
  if (connection.status === "pending") return "pairing";
  if (!connection.groupRegistered) return "paired";
  if (!readiness) return "group_registered";
  if (!readiness.organizerMapped) return "organizer_mapping_needed";
  if (!connection.grantedScopes.includes("trip.read")) return "group_registered";
  if (connection.status === "active" && connection.activatedAt && connection.privacyNoticeDelivered) return "active";
  if (!connection.grantedScopes.includes("connector.setup")) return "group_registered";
  return "ready_for_notice";
}

export function connectionHealth(snapshot: AgentSnapshot, now: number, duringTrip: boolean): string[] {
  const warnings: string[] = [];
  const connection = snapshot.connection;
  if (connection?.status === "active" && duringTrip
    && (!connection.lastSeenAt || !Number.isFinite(Date.parse(connection.lastSeenAt)) || now - Date.parse(connection.lastSeenAt) > 600_000)) warnings.push("no_recent_contact");
  if (snapshot.recentActions.some(action => action.announcementStatus === "failed")) warnings.push("delivery_failed");
  return warnings;
}

export type SetupState = {
  snapshot: AgentSnapshot; busy: SetupOperation | null; request: number;
  loaded: boolean; error: string | null; pairingCode: string | null; credential: string | null;
};
export const initialSetupState: SetupState = {
  snapshot: { connection: null, mappings: [], recentActions: [] }, busy: null,
  request: 0, loaded: false, error: null, pairingCode: null, credential: null,
};
type SetupEvent =
  | { type: "start"; operation: SetupOperation; request: number }
  | { type: "success"; request: number; snapshot: AgentSnapshot; now: number; pairingCode?: string; credential?: string }
  | { type: "failure"; request: number; unauthorized?: boolean }
  | { type: "tick"; now: number }
  | { type: "clear_secrets" };

export function setupReducer(state: SetupState, event: SetupEvent): SetupState {
  if (event.type === "start") return {
    ...state, busy: event.operation, request: event.request, error: null,
    // These requests may invalidate the displayed bearer even if their reply is lost.
    credential: event.operation === "rotate" || event.operation === "revoke" ? null : state.credential,
  };
  if (event.type === "clear_secrets") return { ...state, pairingCode: null, credential: null };
  if (event.type === "tick") {
    const expiry = Date.parse(state.snapshot.connection?.pairingExpiresAt ?? "");
    return state.pairingCode && (!Number.isFinite(expiry) || expiry <= event.now) ? { ...state, pairingCode: null } : state;
  }
  if (event.request !== state.request) return state;
  if (event.type === "failure") return {
    ...(event.unauthorized ? initialSetupState : state), request: event.request, busy: null, loaded: true,
    error: event.unauthorized ? "Organizer access is required. Reload the trip to sign in again." : "Could not verify the latest state. Refresh before trying an action again.",
  };
  const previous = state.snapshot.connection;
  const next = event.snapshot.connection;
  const sameConnection = previous?.id === next?.id && previous?.lifecycleGeneration === next?.lifecycleGeneration;
  const samePairing = sameConnection && previous?.pairingExpiresAt === next?.pairingExpiresAt;
  const expiry = Date.parse(next?.pairingExpiresAt ?? "");
  return {
    ...state, snapshot: event.snapshot, busy: null, error: null, loaded: true,
    pairingCode: next?.status === "pending" && expiry > event.now ? event.pairingCode ?? (samePairing ? state.pairingCode : null) : null,
    credential: next && !["revoked", "archived", "pending"].includes(next.status)
      ? event.credential ?? (sameConnection && previous?.updatedAt === next.updatedAt ? state.credential : null) : null,
  };
}
