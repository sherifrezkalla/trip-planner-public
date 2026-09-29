import "server-only";

import {
  createMcpHandler,
  McpServer,
  type AuthInfo,
  type McpHttpHandler,
} from "@modelcontextprotocol/server";
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import {
  activateTripAgentInputSchema,
  previewTripChangeInputSchema,
  commitTripChangeInputSchema,
  voteOnTripChangeInputSchema,
  decideTripChangeInputSchema,
  getPendingTripDecisionsInputSchema,
  getTodayPlanInputSchema,
  getTripContextInputSchema,
  getTripAgentReadinessInputSchema,
  registerTripGroupInputSchema,
  reportGroupAnnouncementInputSchema,
  searchTripOptionsInputSchema,
  toolFailure,
  toolSuccess,
  type ActivateTripAgentInput,
  type AuthorityPolicy,
  type GetPendingTripDecisionsInput,
  type GetTodayPlanInput,
  type GetTripContextInput,
  type GetTripAgentReadinessInput,
  type RegisterTripGroupInput,
  type ReportGroupAnnouncementInput,
  type SearchTripOptionsInput,
  type TripAgentRouteEndpoint,
  type TripAgentOperation,
  type TripAgentScope,
  type TripAgentToolResult,
} from "./trip-agent-contracts";
import { digestExternalIdentity } from "./trip-agent-auth";
import { previewTripChange, commitTripChange, voteOnTripChange, decideTripChange } from "./trip-agent-change-service";
import { findItineraryMatches, tripDateForDayIndex } from "./itinerary-finder";
import { searchPlaces, type PlaceCandidate } from "./places";
import { evaluateTripAgentAuthority } from "./trip-agent-policy";
import {
  loadGroupSafeToday,
  loadGroupSafeTripContext,
  type GroupSafeTripContext,
  type GroupSafeViewerLookup,
} from "./trip-agent-read-model";
import { computeTrafficAwareRoute, type RouteCoordinates, type TrafficAwareRouteResult } from "./routes";

export type TripAgentToolContext = {
  db: SupabaseClient;
  connection: {
    id: string;
    tripId: string;
    lifecycleGeneration: number;
    status: "paired" | "active";
    grantedScopes: TripAgentScope[];
    whatsappGroupDigest?: string | null;
  };
};

export type TripAgentToolDependencies = {
  loadTripContext: typeof loadGroupSafeTripContext;
  loadToday: typeof loadGroupSafeToday;
  searchPlaces: typeof searchPlaces;
  computeTrafficAwareRoute: typeof computeTrafficAwareRoute;
  now: () => Date;
};

export type TripAgentMcpHandler = Pick<McpHttpHandler, "fetch">;

const defaultDependencies: TripAgentToolDependencies = {
  loadTripContext: loadGroupSafeTripContext,
  loadToday: loadGroupSafeToday,
  searchPlaces,
  computeTrafficAwareRoute,
  now: () => new Date(),
};

type RateBucket = "setup" | "read" | "mutation";
const RATE_LIMITS: Record<RateBucket, number> = {
  setup: 30,
  read: 120,
  mutation: 30,
};

const defaultPolicy: AuthorityPolicy = {
  travelerCanAddSuggestion: true,
  travelerCanProposeChange: true,
};

type MappingForAuthority = Parameters<typeof evaluateTripAgentAuthority>[0]["mapping"];

function externalIdentityDigest(
  connectionId: string,
  lifecycleGeneration: number,
  externalId: string,
): TripAgentToolResult<{ digest: string }> {
  try {
    return toolSuccess({ digest: digestExternalIdentity(connectionId, lifecycleGeneration, externalId) });
  } catch {
    return toolFailure("configuration_unavailable");
  }
}

/** Apply lifecycle, exact-scope, confirmed-identity, and bound-group gates. */
export function authorizeTripAgentCall(
  context: TripAgentToolContext,
  operation: TripAgentOperation,
  externalGroupId: string,
  mapping: MappingForAuthority,
  changeKind?: Parameters<typeof evaluateTripAgentAuthority>[0]["changeKind"],
): TripAgentToolResult<{ requiredScope: TripAgentScope }> {
  const authority = evaluateTripAgentAuthority({
    operation,
    connection: context.connection,
    mapping,
    authorityPolicy: defaultPolicy,
    changeKind,
  });
  if (authority.decision === "denied") return toolFailure(authority.reason);

  const suppliedGroupDigest = externalIdentityDigest(
    context.connection.id,
    context.connection.lifecycleGeneration,
    externalGroupId,
  );
  if (!suppliedGroupDigest.ok) return suppliedGroupDigest;
  if (!context.connection.whatsappGroupDigest) return toolFailure("group_not_registered");
  if (suppliedGroupDigest.data.digest !== context.connection.whatsappGroupDigest) {
    return toolFailure("group_mismatch");
  }
  return toolSuccess({ requiredScope: authority.requiredScope });
}

type StoredConnection = {
  lifecycle_generation: number;
  whatsapp_group_digest: string | null;
  whatsapp_group_label?: string | null;
  authority_policy?: unknown;
  updated_at: string;
};

async function loadStoredConnection(context: TripAgentToolContext): Promise<{
  data: StoredConnection | null;
  error: unknown;
}> {
  try {
    const response = await context.db
      .from("trip_agent_connections")
      .select("lifecycle_generation, whatsapp_group_digest, whatsapp_group_label, authority_policy, updated_at")
      .eq("id", context.connection.id)
      .eq("trip_id", context.connection.tripId)
      .eq("lifecycle_generation", context.connection.lifecycleGeneration)
      .maybeSingle();
    return { data: response.data as StoredConnection | null, error: response.error };
  } catch {
    return { data: null, error: true };
  }
}

function authorityContext(
  context: TripAgentToolContext,
  whatsappGroupDigest: string | null,
): TripAgentToolContext {
  return {
    ...context,
    connection: { ...context.connection, whatsappGroupDigest },
  };
}

export async function registerTripAgentGroup(
  context: TripAgentToolContext,
  input: RegisterTripGroupInput,
): Promise<TripAgentToolResult<{ groupRegistered: true; participantCount: number }>> {
  const authority = evaluateTripAgentAuthority({
    operation: "register_group",
    connection: context.connection,
    mapping: null,
    authorityPolicy: defaultPolicy,
  });
  if (authority.decision === "denied") return toolFailure(authority.reason);

  const groupDigest = externalIdentityDigest(
    context.connection.id,
    context.connection.lifecycleGeneration,
    input.externalGroupId,
  );
  if (!groupDigest.ok) return groupDigest;

  const participantsByDigest = new Map<string, {
    digest: string;
    displayNameHint: string | null;
  }>();
  for (const participant of input.participants) {
    const participantDigest = externalIdentityDigest(
      context.connection.id,
      context.connection.lifecycleGeneration,
      participant.externalParticipantId,
    );
    if (!participantDigest.ok) return participantDigest;
    participantsByDigest.set(participantDigest.data.digest, {
      digest: participantDigest.data.digest,
      displayNameHint: participant.displayNameHint ?? null,
    });
  }
  const participants = [...participantsByDigest.values()]
    .sort((left, right) => left.digest.localeCompare(right.digest));

  try {
    const response = await context.db.rpc("register_trip_agent_group_command", {
      p_connection_id: context.connection.id,
      p_trip_id: context.connection.tripId,
      p_lifecycle_generation: context.connection.lifecycleGeneration,
      p_request_id: input.requestId.toLowerCase(),
      p_actor_digest: groupDigest.data.digest,
      p_normalized_request: {
        groupDigest: groupDigest.data.digest,
        groupLabel: input.groupLabel,
        participants,
      },
      p_now: new Date().toISOString(),
    });
    if (response.error) return toolFailure("database_unavailable");
    return lifecycleCommandResult(response.data, registerCommandSuccessSchema);
  } catch {
    return toolFailure("database_unavailable");
  }
}

const lifecycleCommandFailureSchema = z.object({
  code: z.enum([
    "invalid_input",
    "connection_changed",
    "authority_changed",
    "idempotency_conflict",
    "action_in_progress",
    "group_mismatch",
    "not_ready",
    "action_not_found",
    "action_not_announceable",
    "announcement_conflict",
    "database_unavailable",
  ]),
}).strict();

const registerCommandSuccessSchema = z.object({
  groupRegistered: z.literal(true),
  participantCount: z.number().int().min(0).max(100),
}).strict();

const activateCommandSuccessSchema = z.object({
  status: z.literal("active"),
  activatedAt: z.string().datetime(),
}).strict();

const announcementCommandSuccessSchema = z.object({
  deliveryStatus: z.enum(["delivered", "failed"]),
}).strict();

function lifecycleCommandResult<T>(
  value: unknown,
  successSchema: z.ZodType<T>,
): TripAgentToolResult<T> {
  const success = successSchema.safeParse(value);
  if (success.success) return toolSuccess(success.data);
  const failure = lifecycleCommandFailureSchema.safeParse(value);
  return failure.success ? toolFailure(failure.data.code) : toolFailure("database_unavailable");
}

function isSavedPolicy(value: unknown): value is AuthorityPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2
    && typeof record.travelerCanAddSuggestion === "boolean"
    && typeof record.travelerCanProposeChange === "boolean";
}

export async function getTripAgentReadiness(
  context: TripAgentToolContext,
  input: GetTripAgentReadinessInput,
): Promise<TripAgentToolResult<{ ready: boolean; missing: string[] }>> {
  const stored = await loadStoredConnection(context);
  if (stored.error) return toolFailure("database_unavailable");
  if (!stored.data) return toolFailure("connection_not_found");

  const gate = authorizeTripAgentCall(
    authorityContext(context, stored.data.whatsapp_group_digest),
    "readiness",
    input.externalGroupId,
    null,
  );
  if (!gate.ok) return gate;

  let mappings;
  try {
    mappings = await context.db
      .from("trip_agent_participant_mappings")
      .select("id, traveler_id, status, traveler:travelers!trip_agent_participant_mapping_traveler_same_trip(id, is_organizer, is_bot)")
      .eq("connection_id", context.connection.id)
      .eq("trip_id", context.connection.tripId)
      .eq("lifecycle_generation", context.connection.lifecycleGeneration)
      .eq("status", "confirmed");
  } catch {
    return toolFailure("database_unavailable");
  }
  if (mappings.error) return toolFailure("database_unavailable");

  const rows = (mappings.data ?? []) as unknown as Array<{
    status: string;
    traveler_id: string | null;
    traveler: { id: string; is_organizer: boolean; is_bot: boolean }
      | Array<{ id: string; is_organizer: boolean; is_bot: boolean }>
      | null;
  }>;
  const hasOrganizerMapping = rows.some((mapping) => {
    const traveler = Array.isArray(mapping.traveler) ? mapping.traveler[0] : mapping.traveler;
    return mapping.status === "confirmed"
      && mapping.traveler_id === traveler?.id
      && traveler.is_organizer === true
      && traveler.is_bot === false;
  });
  const missing: string[] = [];
  if (!stored.data.whatsapp_group_digest || !stored.data.whatsapp_group_label?.trim()) {
    missing.push("group_metadata");
  }
  if (!isSavedPolicy(stored.data.authority_policy)) missing.push("authority_policy");
  if (!hasOrganizerMapping) missing.push("organizer_mapping");

  return toolSuccess({ ready: missing.length === 0, missing });
}

export async function activateTripAgent(
  context: TripAgentToolContext,
  input: ActivateTripAgentInput,
): Promise<TripAgentToolResult<{ status: "active"; activatedAt: string }>> {
  const authority = evaluateTripAgentAuthority({
    operation: "activate",
    connection: context.connection,
    mapping: null,
    authorityPolicy: defaultPolicy,
  });
  if (authority.decision === "denied") return toolFailure(authority.reason);

  const groupDigest = externalIdentityDigest(
    context.connection.id,
    context.connection.lifecycleGeneration,
    input.externalGroupId,
  );
  if (!groupDigest.ok) return groupDigest;
  const receiptDigest = externalIdentityDigest(
    context.connection.id,
    context.connection.lifecycleGeneration,
    input.deliveryReceiptId,
  );
  if (!receiptDigest.ok) return receiptDigest;
  let response;
  try {
    response = await context.db.rpc("activate_trip_agent_command", {
      p_connection_id: context.connection.id,
      p_trip_id: context.connection.tripId,
      p_lifecycle_generation: context.connection.lifecycleGeneration,
      p_request_id: input.requestId.toLowerCase(),
      p_actor_digest: groupDigest.data.digest,
      p_normalized_request: {
        groupDigest: groupDigest.data.digest,
        privacyNoticeVersion: input.privacyNoticeVersion,
        receiptDigest: receiptDigest.data.digest,
      },
      p_now: new Date().toISOString(),
    });
  } catch {
    return toolFailure("database_unavailable");
  }
  if (response.error) return toolFailure("database_unavailable");
  return lifecycleCommandResult(response.data, activateCommandSuccessSchema);
}

function mcpResult<T>(result: TripAgentToolResult<T>, requestId: string) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(result) }],
    structuredContent: result,
    _meta: { requestId },
    ...(!result.ok ? { isError: true as const } : {}),
  };
}

async function mcpAdapterResult<T>(
  requestId: string,
  execute: () => Promise<TripAgentToolResult<T>>,
) {
  try {
    return mcpResult(await execute(), requestId);
  } catch {
    return mcpResult(toolFailure("database_unavailable", { retryable: false }), requestId);
  }
}

async function consumeRateLimit(
  context: TripAgentToolContext,
  bucket: RateBucket,
): Promise<TripAgentToolResult<{ allowed: true }>> {
  try {
    const response = await context.db.rpc("consume_trip_agent_rate_limit", {
      p_connection: context.connection.id,
      p_bucket: bucket,
      p_limit: RATE_LIMITS[bucket],
      p_now: new Date().toISOString(),
    });
    if (response.error) return toolFailure("database_unavailable");
    const row = Array.isArray(response.data)
      ? response.data[0] as { allowed?: boolean; retry_after?: number } | undefined
      : undefined;
    if (!row || typeof row.allowed !== "boolean") return toolFailure("database_unavailable");
    if (!row.allowed) return toolFailure("rate_limited", { retryAfter: row.retry_after ?? 60 });
    return toolSuccess({ allowed: true });
  } catch {
    return toolFailure("database_unavailable");
  }
}

function viewerLookup(
  context: TripAgentToolContext,
  externalParticipantId?: string,
): TripAgentToolResult<{ viewer: GroupSafeViewerLookup | null }> {
  if (!externalParticipantId) return toolSuccess({ viewer: null });
  const digest = externalIdentityDigest(
    context.connection.id,
    context.connection.lifecycleGeneration,
    externalParticipantId,
  );
  if (!digest.ok) return digest;
  return toolSuccess({
    viewer: {
      connectionId: context.connection.id,
      lifecycleGeneration: context.connection.lifecycleGeneration,
      externalParticipantDigest: digest.data.digest,
    },
  });
}

function operationalGate(
  context: TripAgentToolContext,
  operation: "read_context" | "read_today" | "read_decisions" | "search_options" | "report_announcement",
  externalGroupId: string,
) {
  return authorizeTripAgentCall(context, operation, externalGroupId, null);
}

async function loadTripContextForOperation(
  context: TripAgentToolContext,
  input: GetTripContextInput,
  operation: "read_context" | "read_decisions",
  overrides: Partial<TripAgentToolDependencies> = {},
): Promise<TripAgentToolResult<GroupSafeTripContext>> {
  const gate = operationalGate(context, operation, input.externalGroupId);
  if (!gate.ok) return gate;
  const rate = await consumeRateLimit(context, "read");
  if (!rate.ok) return rate;
  const viewer = viewerLookup(context, input.externalParticipantId);
  if (!viewer.ok) return viewer;
  const dependencies = { ...defaultDependencies, ...overrides };
  try {
    return toolSuccess(await dependencies.loadTripContext(
      context.db,
      context.connection.tripId,
      viewer.data.viewer,
    ));
  } catch {
    return toolFailure("database_unavailable");
  }
}

export async function getTripContext(
  context: TripAgentToolContext,
  input: GetTripContextInput,
  overrides: Partial<TripAgentToolDependencies> = {},
): Promise<TripAgentToolResult<GroupSafeTripContext>> {
  return loadTripContextForOperation(context, input, "read_context", overrides);
}

export async function getTodayPlan(
  context: TripAgentToolContext,
  input: GetTodayPlanInput,
  overrides: Partial<TripAgentToolDependencies> = {},
) {
  const gate = operationalGate(context, "read_today", input.externalGroupId);
  if (!gate.ok) return gate;
  const rate = await consumeRateLimit(context, "read");
  if (!rate.ok) return rate;
  const viewer = viewerLookup(context, input.externalParticipantId);
  if (!viewer.ok) return viewer;
  const dependencies = { ...defaultDependencies, ...overrides };
  try {
    return toolSuccess(await dependencies.loadToday(
      context.db,
      context.connection.tripId,
      dependencies.now(),
      { viewer: viewer.data.viewer },
    ));
  } catch {
    return toolFailure("database_unavailable");
  }
}

export async function getPendingTripDecisions(
  context: TripAgentToolContext,
  input: GetPendingTripDecisionsInput,
  overrides: Partial<TripAgentToolDependencies> = {},
) {
  const result = await loadTripContextForOperation(context, input, "read_decisions", overrides);
  if (!result.ok) return result;
  return toolSuccess({
    pendingDecisions: result.data.pendingDecisions,
    ...(result.data.viewer ? { viewer: result.data.viewer } : {}),
  });
}

type ResearchCandidate = {
  name: string;
  rating: number | null;
  reviewCount: number;
  regularHours: string[];
  coordinates: RouteCoordinates;
  mapsUrl: string;
  dataSource: "stored_itinerary" | "google_places";
  verifyLiveAvailability: true;
};

type ResearchResult =
  | { status: "available"; candidates: ResearchCandidate[] }
  | { status: "unavailable"; reason: "not_configured" | "upstream_unavailable" };

type RouteResearchResult = TrafficAwareRouteResult | {
  status: "unavailable";
  reason: "item_not_found" | "coordinates_unavailable";
};

function isUsableCoordinates(value: unknown): value is RouteCoordinates {
  if (!value || typeof value !== "object") return false;
  const coordinates = value as RouteCoordinates;
  return Number.isFinite(coordinates.lat) && Number.isFinite(coordinates.lng)
    && coordinates.lat >= -90 && coordinates.lat <= 90
    && coordinates.lng >= -180 && coordinates.lng <= 180;
}

function publicCandidate(
  candidate: Pick<PlaceCandidate, "name" | "rating" | "reviewCount" | "openingHours" | "lat" | "lng" | "mapsUrl">,
  dataSource: ResearchCandidate["dataSource"],
): ResearchCandidate {
  return {
    name: candidate.name,
    rating: candidate.rating,
    reviewCount: candidate.reviewCount,
    regularHours: candidate.openingHours,
    coordinates: { lat: candidate.lat, lng: candidate.lng },
    mapsUrl: candidate.mapsUrl,
    dataSource,
    verifyLiveAvailability: true,
  };
}

function navigationUrl(origin: RouteCoordinates, destination: RouteCoordinates): string {
  const params = new URLSearchParams({
    api: "1",
    origin: `${origin.lat},${origin.lng}`,
    destination: `${destination.lat},${destination.lng}`,
    travelmode: "driving",
  });
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

function routeEndpointCoordinates(
  endpoint: TripAgentRouteEndpoint,
  tripContext: GroupSafeTripContext,
): { coordinates: RouteCoordinates } | { reason: "item_not_found" | "coordinates_unavailable" } {
  if ("itemId" in endpoint) {
    const item = tripContext.items.find((candidate) => candidate.id === endpoint.itemId);
    if (!item) return { reason: "item_not_found" };
    const coordinates = { lat: item.venue.lat, lng: item.venue.lng };
    return isUsableCoordinates(coordinates) ? { coordinates } : { reason: "coordinates_unavailable" };
  }
  const coordinates = { lat: endpoint.lat, lng: endpoint.lng };
  return isUsableCoordinates(coordinates) ? { coordinates } : { reason: "coordinates_unavailable" };
}

/**
 * Live research is intentionally deterministic: safe itinerary lookup first,
 * then the applicable Google service. It never asks a model to invent venues
 * or routes, and it reads only the already group-safe trip projection.
 */
export async function searchTripOptions(
  context: TripAgentToolContext,
  input: SearchTripOptionsInput,
  overrides: Partial<TripAgentToolDependencies> = {},
): Promise<TripAgentToolResult<ResearchResult | { route: RouteResearchResult & { mapsUrl?: string } }>> {
  const gate = operationalGate(context, "search_options", input.externalGroupId);
  if (!gate.ok) return gate;
  const rate = await consumeRateLimit(context, "read");
  if (!rate.ok) return rate;
  const dependencies = { ...defaultDependencies, ...overrides };

  let tripContext: GroupSafeTripContext;
  try {
    const viewer = viewerLookup(context, input.externalParticipantId);
    if (!viewer.ok) return viewer;
    tripContext = await dependencies.loadTripContext(
      context.db,
      context.connection.tripId,
      viewer.data.viewer,
    );
  } catch {
    return toolFailure("database_unavailable");
  }

  if (input.kind === "route") {
    const origin = routeEndpointCoordinates(input.origin, tripContext);
    const destination = routeEndpointCoordinates(input.destination, tripContext);
    if ("reason" in origin) return toolSuccess({ route: { status: "unavailable", reason: origin.reason } });
    if ("reason" in destination) return toolSuccess({ route: { status: "unavailable", reason: destination.reason } });
    let route: TrafficAwareRouteResult;
    try {
      route = await dependencies.computeTrafficAwareRoute({
        origin: origin.coordinates,
        destination: destination.coordinates,
      });
    } catch {
      route = { status: "unavailable", reason: "upstream_unavailable" };
    }
    return toolSuccess({
      route: route.status === "available"
        ? { ...route, mapsUrl: navigationUrl(origin.coordinates, destination.coordinates) }
        : route,
    });
  }

  if (input.kind === "place" || input.kind === "restaurant") {
    const lookup = findItineraryMatches(input.query, tripContext.items.map((item) => ({
      itemId: item.id,
      candidateKey: item.id,
      dayIndex: item.dayIndex,
      date: tripDateForDayIndex(tripContext.trip.startDate, item.dayIndex),
      block: item.block,
      status: item.status,
      name: item.venue.name,
      area: item.area,
      mapsUrl: item.venue.mapsUrl,
      categories: item.venue.categories,
    })), tripContext.trip.destinationName);
    const storedKeys = new Set(lookup.matches.map((match) => `${match.name}\u0000${match.mapsUrl}`));
    const stored = tripContext.items
      .filter((item) => storedKeys.has(`${item.venue.name}\u0000${item.venue.mapsUrl}`))
      .filter((item) => isUsableCoordinates(item.venue))
      .map((item) => publicCandidate(item.venue, "stored_itinerary"));
    if (stored.length > 0) return toolSuccess({ status: "available", candidates: stored });
  }

  const apiKey = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!apiKey) return toolSuccess({ status: "unavailable", reason: "not_configured" });
  const query = input.kind === "parking" ? `parking near ${input.location.trim()}` : input.query;
  const category = input.kind === "parking" ? "parking" : input.kind;
  try {
    const candidates = await dependencies.searchPlaces({
      query,
      category,
      lat: tripContext.trip.lat,
      lng: tripContext.trip.lng,
      area: tripContext.trip.destinationName,
      apiKey,
    });
    return toolSuccess({
      status: "available",
      candidates: candidates
        .filter((candidate) => isUsableCoordinates(candidate))
        .map((candidate) => publicCandidate(candidate, "google_places")),
    });
  } catch {
    return toolSuccess({ status: "unavailable", reason: "upstream_unavailable" });
  }
}

export async function reportGroupAnnouncement(
  context: TripAgentToolContext,
  input: ReportGroupAnnouncementInput,
) {
  const gate = operationalGate(context, "report_announcement", input.externalGroupId);
  if (!gate.ok) return gate;
  const rate = await consumeRateLimit(context, "mutation");
  if (!rate.ok) return rate;

  try {
    const groupDigest = externalIdentityDigest(
      context.connection.id,
      context.connection.lifecycleGeneration,
      input.externalGroupId,
    );
    if (!groupDigest.ok) return groupDigest;
    const providerMessageDigest = input.providerMessageId
      ? externalIdentityDigest(
        context.connection.id,
        context.connection.lifecycleGeneration,
        input.providerMessageId,
      )
      : null;
    if (providerMessageDigest && !providerMessageDigest.ok) return providerMessageDigest;
    const response = await context.db.rpc("report_trip_agent_announcement_command", {
      p_connection_id: context.connection.id,
      p_trip_id: context.connection.tripId,
      p_lifecycle_generation: context.connection.lifecycleGeneration,
      p_request_id: input.requestId.toLowerCase(),
      p_actor_digest: groupDigest.data.digest,
      p_normalized_request: {
        actionId: input.actionId.toLowerCase(),
        deliveryStatus: input.deliveryStatus,
        providerMessageDigest: providerMessageDigest?.data.digest ?? null,
      },
      p_now: new Date().toISOString(),
    });
    if (response.error) return toolFailure("database_unavailable");
    return lifecycleCommandResult(response.data, announcementCommandSuccessSchema);
  } catch {
    return toolFailure("database_unavailable");
  }
}

/** Register setup only; Task 7 extends this registry with operational tools. */
export function registerTripAgentSetupTools(server: McpServer, context: TripAgentToolContext): void {
  server.registerTool(
    "register_trip_group",
    { description: "Bind this connector to one trip group and suggest participant mappings.", inputSchema: registerTripGroupInputSchema },
    async (input) => mcpAdapterResult(input.requestId, async () => {
      const rate = await consumeRateLimit(context, "setup");
      return rate.ok ? registerTripAgentGroup(context, input) : rate;
    }),
  );
  server.registerTool(
    "get_trip_agent_readiness",
    { description: "Report the remaining organizer-controlled setup requirements.", inputSchema: getTripAgentReadinessInputSchema },
    async (input) => mcpAdapterResult(input.requestId, async () => {
      const rate = await consumeRateLimit(context, "setup");
      return rate.ok ? getTripAgentReadiness(context, input) : rate;
    }),
  );
  server.registerTool(
    "activate_trip_agent",
    { description: "Activate after the v1 privacy notice has been delivered.", inputSchema: activateTripAgentInputSchema },
    async (input) => mcpAdapterResult(input.requestId, async () => {
      const rate = await consumeRateLimit(context, "setup");
      return rate.ok ? activateTripAgent(context, input) : rate;
    }),
  );
}

/** Register the Task 5 setup surface plus the first group-safe operational tools. */
export function registerTripAgentTools(
  server: McpServer,
  context: TripAgentToolContext,
  dependencies: Partial<TripAgentToolDependencies> = {},
): void {
  registerTripAgentSetupTools(server, context);
  server.registerTool(
    "get_trip_context",
    { description: "Return a group-safe canonical trip projection.", inputSchema: getTripContextInputSchema },
    async (input) => mcpAdapterResult(input.requestId, () => getTripContext(context, input, dependencies)),
  );
  server.registerTool(
    "get_today_plan",
    { description: "Return the group-safe plan for today and the next stop.", inputSchema: getTodayPlanInputSchema },
    async (input) => mcpAdapterResult(input.requestId, () => getTodayPlan(context, input, dependencies)),
  );
  server.registerTool(
    "search_trip_options",
    { description: "Research stored trip stops, verified places, parking, or live driving routes.", inputSchema: searchTripOptionsInputSchema },
    async (input) => mcpAdapterResult(input.requestId, () => searchTripOptions(context, input, dependencies)),
  );
  server.registerTool(
    "get_pending_trip_decisions",
    { description: "Return open group decisions and caller capabilities.", inputSchema: getPendingTripDecisionsInputSchema },
    async (input) => mcpAdapterResult(input.requestId, () => getPendingTripDecisions(context, input, dependencies)),
  );
  server.registerTool(
    "report_group_announcement",
    { description: "Record delivery of a completed action announcement.", inputSchema: reportGroupAnnouncementInputSchema },
    async (input) => mcpAdapterResult(input.requestId, () => reportGroupAnnouncement(context, input)),
  );
  server.registerTool(
    "preview_trip_change",
    { description: "Preview an itinerary change without changing the canonical plan. Valid for ten minutes.", inputSchema: previewTripChangeInputSchema },
    async (input) => mcpAdapterResult(input.requestId, async () => {
      const rate = await consumeRateLimit(context, "mutation");
      return rate.ok ? previewTripChange(context, input, { now: dependencies.now ?? defaultDependencies.now }) : rate;
    }),
  );
  server.registerTool(
    "commit_trip_change",
    { description: "Commit a preview by actionId; retries return durable state without executing twice.", inputSchema: commitTripChangeInputSchema },
    async (input) => mcpAdapterResult(input.actionId, async () => {
      const rate = await consumeRateLimit(context, "mutation");
      return rate.ok ? commitTripChange(context, input, { now: dependencies.now ?? defaultDependencies.now }) : rate;
    }),
  );
  server.registerTool(
    "vote_on_trip_change",
    { description: "Record a human traveler's vote on a preview's proposal and return its durable settlement.", inputSchema: voteOnTripChangeInputSchema },
    async input => mcpAdapterResult(input.requestId, async () => {
      const rate = await consumeRateLimit(context, "mutation");
      return rate.ok ? voteOnTripChange(context, input, { now: dependencies.now ?? defaultDependencies.now }) : rate;
    }),
  );
  server.registerTool(
    "decide_trip_change",
    { description: "Record the human organizer's decision; current plan safety still takes precedence.", inputSchema: decideTripChangeInputSchema },
    async input => mcpAdapterResult(input.requestId, async () => {
      const rate = await consumeRateLimit(context, "mutation");
      return rate.ok ? decideTripChange(context, input, { now: dependencies.now ?? defaultDependencies.now }) : rate;
    }),
  );
}

type TripAgentMcpFactoryContext = {
  toolContext: TripAgentToolContext;
  dependencies: Partial<TripAgentToolDependencies>;
};

function factoryContextFrom(authInfo: AuthInfo | undefined): TripAgentMcpFactoryContext {
  const context = authInfo?.extra?.tripAgentMcpContext;
  if (!context || typeof context !== "object") {
    throw new Error("Authenticated trip-agent context is required");
  }
  return context as TripAgentMcpFactoryContext;
}

/**
 * One process-wide HTTP entry owns routing only. Its factory creates a fresh
 * MCP server for every protocol request, with the authenticated trip context
 * supplied through the SDK's per-request authInfo channel.
 */
const tripAgentMcpHttpHandler = createMcpHandler(({ authInfo }) => {
  const { toolContext, dependencies } = factoryContextFrom(authInfo);
  const server = new McpServer({
    name: "trip-planner-agent-gateway",
    version: "1.0.0",
  });
  registerTripAgentTools(server, toolContext, dependencies);
  return server;
}, {
  legacy: "reject",
  responseMode: "auto",
});

/** Bind one authenticated connection to the module-scope MCP transport. */
export function createTripAgentMcpHandler(
  toolContext: TripAgentToolContext,
  dependencies: Partial<TripAgentToolDependencies> = {},
): TripAgentMcpHandler {
  const authInfo: AuthInfo = {
    // The bearer was already verified by the route. Do not copy it into the
    // SDK context; tools need only the connection ID and exact granted scopes.
    token: "verified-by-trip-agent-route",
    clientId: toolContext.connection.id,
    scopes: [...toolContext.connection.grantedScopes],
    extra: { tripAgentMcpContext: { toolContext, dependencies } },
  };

  return {
    fetch: (request) => tripAgentMcpHttpHandler.fetch(request, { authInfo }),
  };
}
