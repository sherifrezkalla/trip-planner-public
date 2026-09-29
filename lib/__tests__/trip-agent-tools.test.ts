import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { McpServer } from "@modelcontextprotocol/server";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

vi.mock("server-only", () => ({}));

import { digestExternalIdentity } from "@/lib/trip-agent-auth";
import { actionWorld, envelope as actionEnvelope, ids as actionIds, now as actionNow } from "./helpers/trip-agent-action-db";
import {
  activateTripAgent,
  authorizeTripAgentCall,
  createTripAgentMcpHandler,
  getPendingTripDecisions,
  getTodayPlan,
  getTripContext,
  getTripAgentReadiness,
  reportGroupAnnouncement,
  registerTripAgentGroup,
  registerTripAgentSetupTools,
  registerTripAgentTools,
  searchTripOptions,
  type TripAgentToolContext,
} from "@/lib/trip-agent-tools";

type Result = { data: unknown; error: unknown };
type Interaction = {
  table: string;
  operation: string;
  payload?: unknown;
  options?: unknown;
  filters: Array<[string, unknown]>;
};

const originalPepper = process.env.TRIP_AGENT_IDENTITY_PEPPER;
const interactions: Interaction[] = [];
const results = new Map<string, Result[]>();
const rpc = vi.fn();

function queue(table: string, ...queued: Result[]) {
  results.set(table, [...(results.get(table) ?? []), ...queued]);
}

function next(table: string): Result {
  return results.get(table)?.shift() ?? { data: null, error: null };
}

function query(table: string) {
  const interaction: Interaction = { table, operation: "read", filters: [] };
  interactions.push(interaction);
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.update = (payload: unknown) => {
    interaction.operation = "update";
    interaction.payload = payload;
    return builder;
  };
  builder.select = () => builder;
  builder.upsert = (payload: unknown, options: unknown) => {
    interaction.operation = "upsert";
    interaction.payload = payload;
    interaction.options = options;
    return builder;
  };
  builder.eq = (column: string, value: unknown) => {
    interaction.filters.push([column, value]);
    return builder;
  };
  builder.maybeSingle = () => Promise.resolve(next(table));
  builder.then = (resolve: (value: Result) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(next(table)).then(resolve, reject);
  return builder;
}

function context(overrides: Partial<TripAgentToolContext["connection"]> = {}): TripAgentToolContext {
  return {
    db: { from: query, rpc } as unknown as SupabaseClient,
    connection: {
      id: "connection-1",
      tripId: "trip-1",
      lifecycleGeneration: 1,
      status: "paired",
      grantedScopes: ["connector.setup"],
      ...overrides,
    },
  };
}

const envelope = {
  requestId: "00000000-0000-4000-8000-000000000001",
  externalGroupId: "provider-group-7",
};

beforeEach(() => {
  process.env.TRIP_AGENT_IDENTITY_PEPPER = "test-pepper";
  interactions.length = 0;
  results.clear();
  rpc.mockReset();
});

afterEach(() => {
  if (originalPepper === undefined) delete process.env.TRIP_AGENT_IDENTITY_PEPPER;
  else process.env.TRIP_AGENT_IDENTITY_PEPPER = originalPepper;
});

describe("trip-agent setup registry", () => {
  it("registers only the three setup tools on the MCP v2 server", () => {
    const names: string[] = [];
    const server = {
      registerTool(name: string) {
        names.push(name);
        return {};
      },
    } as unknown as McpServer;

    registerTripAgentSetupTools(server, context());

    expect(names).toEqual([
      "register_trip_group",
      "get_trip_agent_readiness",
      "activate_trip_agent",
    ]);
  });

  it("preserves setup tools when the operational registry is added", () => {
    const names: string[] = [];
    const server = {
      registerTool(name: string) {
        names.push(name);
        return {};
      },
    } as unknown as McpServer;

    registerTripAgentTools(server, context());

    expect(names).toEqual([
      "register_trip_group",
      "get_trip_agent_readiness",
      "activate_trip_agent",
      "get_trip_context",
      "get_today_plan",
      "search_trip_options",
      "get_pending_trip_decisions",
      "report_group_announcement",
      "preview_trip_change",
      "commit_trip_change",
      "vote_on_trip_change",
      "decide_trip_change",
    ]);
  });
});

describe("trip-agent tool boundary", () => {
  it("refuses ordinary tools while a connector is only paired", () => {
    expect(authorizeTripAgentCall(context(), "read_context", envelope.externalGroupId, null)).toEqual({
      ok: false,
      error: { code: "connection_not_active", message: expect.any(String), retryable: false },
    });
  });

  it("refuses a setup call for another provider group", () => {
    const groupDigest = digestExternalIdentity("connection-1", 1, "bound-group");
    expect(authorizeTripAgentCall(
      context({ whatsappGroupDigest: groupDigest }),
      "readiness",
      envelope.externalGroupId,
      null,
    )).toEqual({ ok: false, error: { code: "group_mismatch", message: expect.any(String), retryable: false } });
  });

  it("does not treat the same raw group from a prior lifecycle as the current group", () => {
    const priorLifecycleDigest = digestExternalIdentity("connection-1", 1, envelope.externalGroupId);

    expect(authorizeTripAgentCall(
      context({ lifecycleGeneration: 2, whatsappGroupDigest: priorLifecycleDigest }),
      "readiness",
      envelope.externalGroupId,
      null,
    )).toEqual({ ok: false, error: { code: "group_mismatch", message: expect.any(String), retryable: false } });
  });
});

describe("register_trip_group", () => {
  it("submits one digest-only registration command instead of separate connection and mapping writes", async () => {
    rpc.mockResolvedValue({
      data: { groupRegistered: true, participantCount: 1 },
      error: null,
    });

    const result = await registerTripAgentGroup(context(), {
      ...envelope,
      groupLabel: "Family summer trip",
      participants: [{ externalParticipantId: "person-7", displayNameHint: "Sam" }],
    });

    expect(result).toEqual({ ok: true, data: { groupRegistered: true, participantCount: 1 } });
    expect(rpc).toHaveBeenCalledWith("register_trip_agent_group_command", {
      p_connection_id: "connection-1",
      p_trip_id: "trip-1",
      p_lifecycle_generation: 1,
      p_request_id: envelope.requestId,
      p_actor_digest: digestExternalIdentity("connection-1", 1, envelope.externalGroupId),
      p_normalized_request: {
        groupDigest: digestExternalIdentity("connection-1", 1, envelope.externalGroupId),
        groupLabel: "Family summer trip",
        participants: [{
          digest: digestExternalIdentity("connection-1", 1, "person-7"),
          displayNameHint: "Sam",
        }],
      },
      p_now: expect.any(String),
    });
    expect(interactions.filter(({ operation }) => operation !== "read")).toHaveLength(0);
    expect(JSON.stringify(rpc.mock.calls)).not.toMatch(/provider-group-7|person-7/);
  });

  it("sorts participant digests and canonicalizes the request UUID before persistence", async () => {
    rpc.mockResolvedValue({ data: { groupRegistered: true, participantCount: 2 }, error: null });
    const requestId = "A0000000-0000-4000-8000-000000000001";

    await registerTripAgentGroup(context(), {
      ...envelope,
      requestId,
      groupLabel: "Family trip",
      participants: [
        { externalParticipantId: "zed", displayNameHint: "Zed" },
        { externalParticipantId: "amy", displayNameHint: "Amy" },
      ],
    });

    const args = rpc.mock.calls[0][1];
    expect(args.p_request_id).toBe(requestId.toLowerCase());
    expect(args.p_normalized_request.participants.map((participant: { digest: string }) => participant.digest))
      .toEqual([
        digestExternalIdentity("connection-1", 1, "amy"),
        digestExternalIdentity("connection-1", 1, "zed"),
      ].sort());
  });

  it("stores only connection-scoped group/participant digests and bounded display hints", async () => {
    rpc.mockResolvedValue({ data: { groupRegistered: true, participantCount: 1 }, error: null });

    const result = await registerTripAgentGroup(context(), {
      ...envelope,
      groupLabel: "Family summer trip",
      participants: [{ externalParticipantId: "person-7", displayNameHint: "Sam" }],
    });

    expect(result).toEqual({ ok: true, data: { groupRegistered: true, participantCount: 1 } });
    const serialized = JSON.stringify(rpc.mock.calls);
    expect(serialized).not.toContain("provider-group-7");
    expect(serialized).not.toContain("person-7");
    expect(interactions).toHaveLength(0);
  });

  it("does not overwrite a different group bound concurrently", async () => {
    rpc.mockResolvedValue({ data: { code: "connection_changed" }, error: null });

    const result = await registerTripAgentGroup(context(), {
      ...envelope,
      groupLabel: "Family summer trip",
      participants: [{ externalParticipantId: "person-7", displayNameHint: "Sam" }],
    });

    expect(result).toEqual({ ok: false, error: { code: "connection_changed", message: expect.any(String), retryable: false } });
    expect(interactions).toHaveLength(0);
  });

  it("keeps a newly observed participant suggested instead of granting a traveler identity", async () => {
    const groupDigest = digestExternalIdentity("connection-1", 1, envelope.externalGroupId);
    rpc.mockResolvedValue({ data: { groupRegistered: true, participantCount: 1 }, error: null });

    await registerTripAgentGroup(context({ status: "paired", whatsappGroupDigest: groupDigest }), {
      ...envelope,
      groupLabel: "Family summer trip",
      participants: [{ externalParticipantId: "new-person", displayNameHint: "New guest" }],
    });

    expect(rpc.mock.calls[0][1].p_normalized_request.participants).toEqual([{
      digest: digestExternalIdentity("connection-1", 1, "new-person"),
      displayNameHint: "New guest",
    }]);
  });

  it("writes and upserts registration identities only inside the authenticated lifecycle", async () => {
    rpc.mockResolvedValue({ data: { groupRegistered: true, participantCount: 1 }, error: null });

    const result = await registerTripAgentGroup(context({ lifecycleGeneration: 4 }), {
      ...envelope,
      groupLabel: "Fresh lifecycle",
      participants: [{ externalParticipantId: "person-7" }],
    });

    expect(result.ok).toBe(true);
    expect(rpc.mock.calls[0][1]).toMatchObject({
      p_lifecycle_generation: 4,
      p_normalized_request: {
        participants: [expect.objectContaining({ digest: digestExternalIdentity("connection-1", 4, "person-7") })],
      },
    });
  });
});

describe("readiness and activation", () => {
  it("submits activation identity and notice state as one durable command", async () => {
    const groupDigest = digestExternalIdentity("connection-1", 1, envelope.externalGroupId);
    rpc.mockResolvedValue({
      data: { status: "active", activatedAt: "2026-09-04T12:00:00.000Z" },
      error: null,
    });

    const result = await activateTripAgent(context(), {
      ...envelope,
      privacyNoticeVersion: "v1",
      deliveryReceiptId: "message-77",
    });

    expect(result).toEqual({
      ok: true,
      data: { status: "active", activatedAt: "2026-09-04T12:00:00.000Z" },
    });
    expect(rpc).toHaveBeenCalledWith("activate_trip_agent_command", {
      p_connection_id: "connection-1",
      p_trip_id: "trip-1",
      p_lifecycle_generation: 1,
      p_request_id: envelope.requestId,
      p_actor_digest: groupDigest,
      p_normalized_request: {
        groupDigest,
        privacyNoticeVersion: "v1",
        receiptDigest: digestExternalIdentity("connection-1", 1, "message-77"),
      },
      p_now: expect.any(String),
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toMatch(/provider-group-7|message-77/);
  });

  it("requires saved group metadata, bounded policy, and a confirmed actual organizer mapping", async () => {
    const groupDigest = digestExternalIdentity("connection-1", 1, envelope.externalGroupId);
    queue("trip_agent_connections", {
      data: {
        whatsapp_group_digest: groupDigest,
        whatsapp_group_label: "Family summer trip",
        authority_policy: { travelerCanAddSuggestion: true, travelerCanProposeChange: true },
      },
      error: null,
    });
    queue("trip_agent_participant_mappings", {
      data: [{
        status: "confirmed",
        traveler_id: "traveler-1",
        traveler: { id: "traveler-1", is_organizer: false, is_bot: false },
      }],
      error: null,
    });

    expect(await getTripAgentReadiness(context({ whatsappGroupDigest: groupDigest }), envelope)).toEqual({
      ok: true,
      data: { ready: false, missing: ["organizer_mapping"] },
    });
  });

  it("reports ready only when a confirmed row joins to the actual organizer", async () => {
    const groupDigest = digestExternalIdentity("connection-1", 1, envelope.externalGroupId);
    queue("trip_agent_connections", {
      data: {
        whatsapp_group_digest: groupDigest,
        whatsapp_group_label: "Family summer trip",
        authority_policy: { travelerCanAddSuggestion: true, travelerCanProposeChange: true },
      },
      error: null,
    });
    queue("trip_agent_participant_mappings", {
      data: [{
        status: "confirmed",
        traveler_id: "organizer-1",
        traveler: { id: "organizer-1", is_organizer: true, is_bot: false },
      }],
      error: null,
    });

    expect(await getTripAgentReadiness(context({ whatsappGroupDigest: groupDigest }), envelope)).toEqual({
      ok: true,
      data: { ready: true, missing: [] },
    });
  });

  it("does not accept a confirmed mapping to a bot organizer as ready", async () => {
    const groupDigest = digestExternalIdentity("connection-1", 1, envelope.externalGroupId);
    queue("trip_agent_connections", {
      data: {
        lifecycle_generation: 1,
        whatsapp_group_digest: groupDigest,
        whatsapp_group_label: "Family summer trip",
        authority_policy: { travelerCanAddSuggestion: true, travelerCanProposeChange: true },
      },
      error: null,
    });
    queue("trip_agent_participant_mappings", {
      data: [{
        status: "confirmed",
        traveler_id: "organizer-1",
        traveler: { id: "organizer-1", is_organizer: true, is_bot: true },
      }],
      error: null,
    });

    expect(await getTripAgentReadiness(context({ whatsappGroupDigest: groupDigest }), envelope)).toEqual({
      ok: true,
      data: { ready: false, missing: ["organizer_mapping"] },
    });
    const mappingRead = interactions.find((item) => item.table === "trip_agent_participant_mappings");
    expect(mappingRead?.filters).toContainEqual(["lifecycle_generation", 1]);
  });

  it("activates through the transactional readiness RPC and persists only a receipt digest", async () => {
    const groupDigest = digestExternalIdentity("connection-1", 1, envelope.externalGroupId);
    rpc.mockResolvedValue({
      data: { status: "active", activatedAt: "2026-09-04T12:00:00.000Z" },
      error: null,
    });

    const result = await activateTripAgent(context(), {
      ...envelope,
      privacyNoticeVersion: "v1",
      deliveryReceiptId: "message-77",
    });

    expect(result).toEqual({
      ok: true,
      data: { status: "active", activatedAt: "2026-09-04T12:00:00.000Z" },
    });
    expect(rpc).toHaveBeenCalledWith("activate_trip_agent_command", {
      p_connection_id: "connection-1",
      p_trip_id: "trip-1",
      p_lifecycle_generation: 1,
      p_request_id: envelope.requestId,
      p_actor_digest: groupDigest,
      p_normalized_request: {
        groupDigest,
        privacyNoticeVersion: "v1",
        receiptDigest: digestExternalIdentity("connection-1", 1, "message-77"),
      },
      p_now: expect.any(String),
    });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("message-77");
  });

  it("cannot activate before the database revalidates readiness and notice delivery", async () => {
    rpc.mockResolvedValue({ data: { code: "not_ready" }, error: null });

    expect(await activateTripAgent(context(), {
      ...envelope,
      privacyNoticeVersion: "v1",
      deliveryReceiptId: "message-77",
    })).toEqual({ ok: false, error: { code: "not_ready", message: expect.any(String), retryable: false } });
  });
});

describe("operational read adapters", () => {
  function activeContext(scopes: TripAgentToolContext["connection"]["grantedScopes"] = ["trip.read"]) {
    return context({
      status: "active",
      grantedScopes: scopes,
      whatsappGroupDigest: digestExternalIdentity("connection-1", 1, envelope.externalGroupId),
    });
  }

  it("loads group-safe context for an unmatched participant after consuming the read bucket", async () => {
    rpc.mockResolvedValue({ data: [{ allowed: true, count: 1, retry_after: 59 }], error: null });
    const loadTripContext = vi.fn().mockResolvedValue({ trip: { slug: "family-trip" }, items: [], pendingDecisions: [] });

    const result = await getTripContext(activeContext(), envelope, { loadTripContext });

    expect(result).toEqual({
      ok: true,
      data: { trip: { slug: "family-trip" }, items: [], pendingDecisions: [] },
    });
    expect(rpc).toHaveBeenCalledWith("consume_trip_agent_rate_limit", {
      p_connection: "connection-1",
      p_bucket: "read",
      p_limit: 120,
      p_now: expect.any(String),
    });
    expect(loadTripContext).toHaveBeenCalledWith(expect.anything(), "trip-1", null);
  });

  it("binds a participant identity to the authenticated connection before a Today read", async () => {
    rpc.mockResolvedValue({ data: [{ allowed: true, count: 1, retry_after: 59 }], error: null });
    const loadToday = vi.fn().mockResolvedValue({ phase: "during", pendingDecisions: [] });

    await getTodayPlan(activeContext(), {
      ...envelope,
      externalParticipantId: "provider-person-9",
    }, { loadToday, now: () => new Date("2026-09-04T12:00:00.000Z") });

    expect(loadToday).toHaveBeenCalledWith(expect.anything(), "trip-1", new Date("2026-09-04T12:00:00.000Z"), {
      viewer: {
        connectionId: "connection-1",
        lifecycleGeneration: 1,
        externalParticipantDigest: digestExternalIdentity("connection-1", 1, "provider-person-9"),
      },
    });
  });

  it("returns only pending decisions and viewer capabilities from the safe projection", async () => {
    rpc.mockResolvedValue({ data: [{ allowed: true, count: 1, retry_after: 59 }], error: null });
    const loadTripContext = vi.fn().mockResolvedValue({
      trip: { slug: "family-trip" },
      items: [{ id: "private-by-omission" }],
      pendingDecisions: [{ id: "decision-1" }],
      viewer: { canVote: true },
    });

    expect(await getPendingTripDecisions(activeContext(), envelope, { loadTripContext })).toEqual({
      ok: true,
      data: { pendingDecisions: [{ id: "decision-1" }], viewer: { canVote: true } },
    });
  });

  it("refuses a missing exact read scope before rate or domain calls", async () => {
    const loadTripContext = vi.fn();

    expect(await getTripContext(activeContext(["trip.research"]), envelope, { loadTripContext }))
      .toEqual({ ok: false, error: { code: "missing_scope", message: expect.any(String), retryable: false } });
    expect(rpc).not.toHaveBeenCalled();
    expect(loadTripContext).not.toHaveBeenCalled();
  });

  it("refuses a different external group before rate or domain calls", async () => {
    const loadToday = vi.fn();
    const wrongGroupContext = context({
      status: "active",
      grantedScopes: ["trip.read"],
      whatsappGroupDigest: digestExternalIdentity("connection-1", 1, "another-group"),
    });

    expect(await getTodayPlan(wrongGroupContext, envelope, { loadToday })).toEqual({
      ok: false,
      error: { code: "group_mismatch", message: expect.any(String), retryable: false },
    });
    expect(rpc).not.toHaveBeenCalled();
    expect(loadToday).not.toHaveBeenCalled();
  });

  it("returns a retry-after value without a domain read when the atomic bucket is exhausted", async () => {
    rpc.mockResolvedValue({ data: [{ allowed: false, count: 121, retry_after: 37 }], error: null });
    const loadTripContext = vi.fn();

    expect(await getTripContext(activeContext(), envelope, { loadTripContext })).toEqual({
      ok: false,
      error: { code: "rate_limited", retryAfter: 37, message: expect.any(String), retryable: true },
    });
    expect(loadTripContext).not.toHaveBeenCalled();
  });

  it("maps rate-store failures to a structured database refusal", async () => {
    rpc.mockResolvedValue({ data: null, error: { message: "offline" } });
    const loadTripContext = vi.fn();

    expect(await getTripContext(activeContext(), envelope, { loadTripContext })).toEqual({
      ok: false,
      error: { code: "database_unavailable", message: expect.any(String), retryable: true },
    });
    expect(loadTripContext).not.toHaveBeenCalled();
  });
});

describe("search_trip_options", () => {
  it.each([null, undefined, NaN, Infinity, 91])("refuses a stored route item with unusable latitude %s without calling Routes", async lat => {
    rpc.mockResolvedValue({ data: [{ allowed: true }], error: null });
    const loadTripContext = vi.fn().mockResolvedValue({ ...safeContext, items: [{
      ...safeContext.items[0], venue: { ...safeContext.items[0].venue, lat },
    }] });
    const computeTrafficAwareRoute = vi.fn();
    expect(await searchTripOptions(researchContext(), { ...envelope, kind: "route",
      origin: { itemId: safeContext.items[0].id }, destination: { lat: 43.7, lng: 7.27 },
    }, { loadTripContext, computeTrafficAwareRoute })).toEqual({ ok: true, data: {
      route: { status: "unavailable", reason: "coordinates_unavailable" },
    } });
    expect(computeTrafficAwareRoute).not.toHaveBeenCalled();
  });

  it.each(["place", "restaurant"] as const)("uses direct %s fallback and only its public projection", async kind => {
    rpc.mockResolvedValue({ data: [{ allowed: true }], error: null });
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "places-secret");
    const loadTripContext = vi.fn().mockResolvedValue({ ...safeContext, items: [] });
    const searchPlaces = vi.fn().mockResolvedValue([{ ...safeContext.items[0].venue,
      placeId: "PRIVATE-provider-id", privateNotes: "PRIVATE", priceLevel: "PRIVATE", category: kind,
    }]);
    expect(await searchTripOptions(researchContext(), { ...envelope, kind, query: "local spot" },
      { loadTripContext, searchPlaces })).toEqual({ ok: true, data: { status: "available", candidates: [{
      name: "Picasso Museum", rating: 4.7, reviewCount: 1234, regularHours: ["Monday: Closed"],
      coordinates: { lat: 43.55, lng: 7.01 }, mapsUrl: "https://maps.google.com/?cid=123",
      dataSource: "google_places", verifyLiveAvailability: true,
    }] } });
    expect(searchPlaces).toHaveBeenCalledWith({ query: "local spot", category: kind,
      lat: 43.55, lng: 7.01, area: "Example Coast", apiKey: "places-secret" });
  });

  it.each([new Error("PRIVATE provider response"), new DOMException("PRIVATE timeout", "AbortError")])("returns bounded successful Places unavailability on provider rejection", async error => {
    rpc.mockResolvedValue({ data: [{ allowed: true }], error: null });
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "places-secret");
    const loadTripContext = vi.fn().mockResolvedValue({ ...safeContext, items: [] });
    const searchPlaces = vi.fn().mockRejectedValue(error);
    expect(await searchTripOptions(researchContext(), { ...envelope, kind: "restaurant", query: "local spot" },
      { loadTripContext, searchPlaces })).toEqual({ ok: true, data: { status: "unavailable", reason: "upstream_unavailable" } });
  });
  function researchContext(scopes: TripAgentToolContext["connection"]["grantedScopes"] = ["trip.research"]) {
    return context({
      status: "active",
      grantedScopes: scopes,
      whatsappGroupDigest: digestExternalIdentity("connection-1", 1, envelope.externalGroupId),
    });
  }

  const safeContext = {
    trip: { destinationName: "Example Coast", startDate: "2026-09-01", lat: 43.55, lng: 7.01 },
    items: [{
      id: "00000000-0000-4000-8000-000000000099",
      dayIndex: 0,
      block: "morning",
      status: "planned",
      area: "Old Port",
      venue: {
        name: "Picasso Museum", rating: 4.7, reviewCount: 1234,
        openingHours: ["Monday: Closed"], lat: 43.55, lng: 7.01,
        mapsUrl: "https://maps.google.com/?cid=123", categories: ["history"],
      },
    }],
    pendingDecisions: [],
  };

  it("uses the research authority and read bucket before any context or provider work", async () => {
    const loadTripContext = vi.fn();
    const searchPlaces = vi.fn();
    const computeTrafficAwareRoute = vi.fn();
    expect(await searchTripOptions(researchContext(["trip.read"]), {
      ...envelope, kind: "place", query: "museum",
    }, { loadTripContext, searchPlaces, computeTrafficAwareRoute })).toEqual({ ok: false, error: { code: "missing_scope", message: expect.any(String), retryable: false } });
    expect(rpc).not.toHaveBeenCalled();
    expect(loadTripContext).not.toHaveBeenCalled();
    expect(searchPlaces).not.toHaveBeenCalled();
    expect(computeTrafficAwareRoute).not.toHaveBeenCalled();

    rpc.mockResolvedValue({ data: [{ allowed: false, retry_after: 17 }], error: null });
    expect(await searchTripOptions(researchContext(), {
      ...envelope, kind: "place", query: "museum",
    }, { loadTripContext, searchPlaces, computeTrafficAwareRoute })).toEqual({ ok: false, error: { code: "rate_limited", retryAfter: 17, message: expect.any(String), retryable: true } });
    expect(loadTripContext).not.toHaveBeenCalled();
    expect(searchPlaces).not.toHaveBeenCalled();
    expect(computeTrafficAwareRoute).not.toHaveBeenCalled();
  });

  it("returns a stored itinerary match without calling Google Places", async () => {
    rpc.mockResolvedValue({ data: [{ allowed: true, retry_after: 59 }], error: null });
    const loadTripContext = vi.fn().mockResolvedValue(safeContext);
    const searchPlaces = vi.fn();
    const result = await searchTripOptions(researchContext(), {
      ...envelope, kind: "place", query: "Picasso",
    }, { loadTripContext, searchPlaces });

    expect(result).toEqual({ ok: true, data: {
      status: "available",
      candidates: [{
        name: "Picasso Museum", rating: 4.7, reviewCount: 1234,
        regularHours: ["Monday: Closed"], coordinates: { lat: 43.55, lng: 7.01 },
        mapsUrl: "https://maps.google.com/?cid=123", dataSource: "stored_itinerary",
        verifyLiveAvailability: true,
      }],
    } });
    expect(searchPlaces).not.toHaveBeenCalled();
  });

  it("normalizes a parking search and exposes only verified public place fields", async () => {
    rpc.mockResolvedValue({ data: [{ allowed: true, retry_after: 59 }], error: null });
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "places-secret");
    const loadTripContext = vi.fn().mockResolvedValue(safeContext);
    const searchPlaces = vi.fn().mockResolvedValue([{
      name: "Port Parking", rating: 4.2, reviewCount: 44, openingHours: ["Open 24 hours"],
      lat: 43.56, lng: 7.02, mapsUrl: "https://maps.google.com/?cid=456",
      priceLevel: "PRICE_LEVEL_FREE", privateNotes: "do not disclose",
    }]);
    const result = await searchTripOptions(researchContext(), {
      ...envelope, kind: "parking", location: " Old Port ",
    }, { loadTripContext, searchPlaces });

    expect(searchPlaces).toHaveBeenCalledWith(expect.objectContaining({
      query: "parking near Old Port", category: "parking", lat: 43.55, lng: 7.01,
      apiKey: expect.any(String), area: "Example Coast",
    }));
    expect(result).toEqual({ ok: true, data: {
      status: "available",
      candidates: [{
        name: "Port Parking", rating: 4.2, reviewCount: 44,
        regularHours: ["Open 24 hours"], coordinates: { lat: 43.56, lng: 7.02 },
        mapsUrl: "https://maps.google.com/?cid=456", dataSource: "google_places",
        verifyLiveAvailability: true,
      }],
    } });
    expect(JSON.stringify(result)).not.toContain("do not disclose");
  });

  it("resolves route item IDs only within the trip and creates a deterministic navigation URL", async () => {
    rpc.mockResolvedValue({ data: [{ allowed: true, retry_after: 59 }], error: null });
    const loadTripContext = vi.fn().mockResolvedValue(safeContext);
    const computeTrafficAwareRoute = vi.fn().mockResolvedValue({
      status: "available", durationSeconds: 900, staticDurationSeconds: 600,
      durationMinutes: 15, trafficDelayMinutes: 5, distanceMeters: 12000,
      dataSource: "google_routes", verifyLiveAvailability: true,
    });
    const result = await searchTripOptions(researchContext(), {
      ...envelope, kind: "route",
      origin: { itemId: "00000000-0000-4000-8000-000000000099" },
      destination: { lat: 43.7, lng: 7.27, label: "Untrusted but bounded label" },
    }, { loadTripContext, computeTrafficAwareRoute });

    expect(computeTrafficAwareRoute).toHaveBeenCalledWith({
      origin: { lat: 43.55, lng: 7.01 }, destination: { lat: 43.7, lng: 7.27 },
    });
    expect(result).toEqual({ ok: true, data: {
      route: {
        status: "available", durationSeconds: 900, staticDurationSeconds: 600,
        durationMinutes: 15, trafficDelayMinutes: 5, distanceMeters: 12000,
        dataSource: "google_routes", verifyLiveAvailability: true,
        mapsUrl: "https://www.google.com/maps/dir/?api=1&origin=43.55%2C7.01&destination=43.7%2C7.27&travelmode=driving",
      },
    } });
  });

  it("does not call Routes when an item reference is absent or lacks usable coordinates", async () => {
    rpc.mockResolvedValue({ data: [{ allowed: true, retry_after: 59 }], error: null });
    const computeTrafficAwareRoute = vi.fn();
    const loadTripContext = vi.fn().mockResolvedValue(safeContext);
    expect(await searchTripOptions(researchContext(), {
      ...envelope, kind: "route",
      origin: { itemId: "00000000-0000-4000-8000-000000000001" },
      destination: { lat: 43.7, lng: 7.27 },
    }, { loadTripContext, computeTrafficAwareRoute })).toEqual({ ok: true, data: {
      route: { status: "unavailable", reason: "item_not_found" },
    } });
    expect(computeTrafficAwareRoute).not.toHaveBeenCalled();
  });

  it("sanitizes an unexpected route-provider failure", async () => {
    rpc.mockResolvedValue({ data: [{ allowed: true, retry_after: 59 }], error: null });
    const loadTripContext = vi.fn().mockResolvedValue(safeContext);
    const computeTrafficAwareRoute = vi.fn().mockRejectedValue(new Error("private provider body"));
    expect(await searchTripOptions(researchContext(), {
      ...envelope, kind: "route",
      origin: { itemId: "00000000-0000-4000-8000-000000000099" },
      destination: { lat: 43.7, lng: 7.27 },
    }, { loadTripContext, computeTrafficAwareRoute })).toEqual({ ok: true, data: {
      route: { status: "unavailable", reason: "upstream_unavailable" },
    } });
  });
});

describe("report_group_announcement", () => {
  function announcementContext() {
    return context({
      status: "active",
      grantedScopes: ["announcement.write"],
      whatsappGroupDigest: digestExternalIdentity("connection-1", 1, envelope.externalGroupId),
    });
  }

  it("refuses an action outside the authenticated connection and trip", async () => {
    rpc
      .mockResolvedValueOnce({ data: [{ allowed: true, count: 1, retry_after: 59 }], error: null })
      .mockResolvedValueOnce({ data: { code: "action_not_found" }, error: null });

    expect(await reportGroupAnnouncement(announcementContext(), {
      ...envelope,
      actionId: "00000000-0000-4000-8000-000000000099",
      deliveryStatus: "delivered",
    })).toEqual({ ok: false, error: { code: "action_not_found", message: expect.any(String), retryable: false } });
    expect(interactions).toHaveLength(0);
  });

  it("refuses a missing announcement scope before rate or action lookup", async () => {
    const denied = context({
      status: "active",
      grantedScopes: ["trip.read"],
      whatsappGroupDigest: digestExternalIdentity("connection-1", 1, envelope.externalGroupId),
    });

    expect(await reportGroupAnnouncement(denied, {
      ...envelope,
      actionId: "00000000-0000-4000-8000-000000000099",
      deliveryStatus: "delivered",
    })).toEqual({ ok: false, error: { code: "missing_scope", message: expect.any(String), retryable: false } });
    expect(rpc).not.toHaveBeenCalled();
    expect(interactions).toHaveLength(0);
  });

  it("does not look up an action after the mutation rate bucket is exhausted", async () => {
    rpc.mockResolvedValue({ data: [{ allowed: false, count: 31, retry_after: 19 }], error: null });

    expect(await reportGroupAnnouncement(announcementContext(), {
      ...envelope,
      actionId: "00000000-0000-4000-8000-000000000099",
      deliveryStatus: "delivered",
    })).toEqual({ ok: false, error: { code: "rate_limited", retryAfter: 19, message: expect.any(String), retryable: true } });
    expect(interactions).toHaveLength(0);
  });

  it("stores only the connection-scoped message digest and is idempotent", async () => {
    rpc
      .mockResolvedValueOnce({ data: [{ allowed: true, count: 1, retry_after: 59 }], error: null })
      .mockResolvedValueOnce({ data: { deliveryStatus: "delivered" }, error: null });

    const result = await reportGroupAnnouncement(announcementContext(), {
      ...envelope,
      actionId: "00000000-0000-4000-8000-000000000099",
      deliveryStatus: "delivered",
      providerMessageId: "whatsapp-message-77",
    });

    expect(result).toEqual({ ok: true, data: { deliveryStatus: "delivered" } });
    expect(JSON.stringify(rpc.mock.calls)).not.toContain("whatsapp-message-77");
  });

  it("submits announcement truth through one current-generation command RPC", async () => {
    rpc
      .mockResolvedValueOnce({ data: [{ allowed: true, count: 1, retry_after: 59 }], error: null })
      .mockResolvedValueOnce({ data: { deliveryStatus: "delivered" }, error: null });

    const result = await reportGroupAnnouncement(announcementContext(), {
      ...envelope,
      actionId: "00000000-0000-4000-8000-000000000099",
      deliveryStatus: "delivered",
      providerMessageId: "whatsapp-message-77",
    });

    expect(result).toEqual({ ok: true, data: { deliveryStatus: "delivered" } });
    expect(rpc).toHaveBeenNthCalledWith(2, "report_trip_agent_announcement_command", {
      p_connection_id: "connection-1",
      p_trip_id: "trip-1",
      p_lifecycle_generation: 1,
      p_request_id: envelope.requestId,
      p_actor_digest: digestExternalIdentity("connection-1", 1, envelope.externalGroupId),
      p_normalized_request: {
        actionId: "00000000-0000-4000-8000-000000000099",
        deliveryStatus: "delivered",
        providerMessageDigest: digestExternalIdentity("connection-1", 1, "whatsapp-message-77"),
      },
      p_now: expect.any(String),
    });
    expect(interactions).toHaveLength(0);
    expect(JSON.stringify(rpc.mock.calls)).not.toMatch(/provider-group-7|whatsapp-message-77/);
  });

  it("returns an identical completed report without another update", async () => {
    rpc
      .mockResolvedValueOnce({ data: [{ allowed: true, count: 1, retry_after: 59 }], error: null })
      .mockResolvedValueOnce({ data: { deliveryStatus: "failed" }, error: null });

    expect(await reportGroupAnnouncement(announcementContext(), {
      ...envelope,
      actionId: "00000000-0000-4000-8000-000000000099",
      deliveryStatus: "failed",
    })).toEqual({ ok: true, data: { deliveryStatus: "failed" } });
    expect(interactions.filter((item) => item.operation === "update")).toHaveLength(0);
  });
});

async function protocolClient(
  toolContext: TripAgentToolContext,
  dependencies: Parameters<typeof createTripAgentMcpHandler>[1] = {},
) {
  const handler = createTripAgentMcpHandler(toolContext, dependencies);
  const transport = new StreamableHTTPClientTransport(new URL("https://trip.test/api/mcp"), {
    fetch: async (input, init) => handler.fetch(new Request(input, init)),
  });
  const client = new Client({ name: "trip-agent-test", version: "1.0.0" }, {
    versionNegotiation: { mode: "auto" },
  });
  await client.connect(transport);
  return client;
}

function activeProtocolContext(
  connectionId = "connection-1",
  tripId = "trip-1",
  scopes: TripAgentToolContext["connection"]["grantedScopes"] = ["trip.read"],
) {
  return context({
    id: connectionId,
    tripId,
    status: "active",
    grantedScopes: scopes,
    whatsappGroupDigest: digestExternalIdentity(connectionId, 1, envelope.externalGroupId),
  });
}

describe("MCP v2 in-process transport", () => {
  it("makes an uncaught adapter failure terminal with only request ID diagnostic metadata", async () => {
    const toolContext = activeProtocolContext();
    const client = await protocolClient(toolContext);
    try {
      // Throw outside a tool's own guarded I/O, after authentication and schema validation.
      Object.defineProperty(toolContext.connection, "status", { get() { throw new Error("PRIVATE context diagnostic"); } });
      const result = await client.callTool({ name: "get_trip_context", arguments: envelope });
      expect(result.structuredContent).toEqual({ ok: false, error: {
        code: "database_unavailable", message: "The service is temporarily unavailable.", retryable: false,
      } });
      expect(result._meta).toMatchObject({ requestId: envelope.requestId });
      expect(JSON.stringify(result)).not.toContain("PRIVATE");
    } finally { await client.close(); }
  });
  it.each([
    ["missing_scope", false], ["idempotency_conflict", false], ["rate_limited", true],
    ["database_unavailable", true], ["preview_expired", false], ["unknown", false],
  ] as const)("emits the closed %s failure through the real wire", async (scenario, retryable) => {
    const world = actionWorld();
    const requestId = actionIds.request;
    const client = await protocolClient(world.context, { now: () => actionNow });
    try {
      const input = { ...actionEnvelope, kind: "reservation_prepare", itemId: actionIds.item,
        partySize: 4, requestedAt: actionNow.toISOString() };
      let name = "preview_trip_change";
      let args: Record<string, unknown> = input;
      if (["idempotency_conflict", "preview_expired", "unknown"].includes(scenario)) {
        await client.callTool({ name, arguments: input });
        if (scenario === "idempotency_conflict") args = { ...input, partySize: 5 };
        else {
          name = "commit_trip_change";
          args = { actionId: actionIds.action, externalGroupId: actionEnvelope.externalGroupId, externalParticipantId: actionEnvelope.externalParticipantId };
          if (scenario === "preview_expired") world.rows.trip_agent_actions[0].confirmation_expires_at = actionNow.toISOString();
          else Object.assign(world.rows.trip_agent_actions[0], { status: "unknown", error_code: "database_unavailable" });
        }
      }
      if (scenario === "missing_scope") world.rows.trip_agent_connections[0].granted_scopes = [];
      if (scenario === "database_unavailable") world.fail(table => table === "trip_agent_connections");
      if (scenario === "rate_limited") world.rpc.mockResolvedValueOnce({ data: [{ allowed: false, retry_after: 17 }], error: null });
      const result = await client.callTool({ name, arguments: args });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({ ok: false, error: {
        code: scenario === "unknown" ? "database_unavailable" : scenario,
        message: expect.any(String), retryable,
        ...(scenario === "rate_limited" ? { retryAfter: 17 } : {}),
      } });
      expect(result._meta).toMatchObject({ requestId: name === "commit_trip_change" ? actionIds.action : requestId });
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|raw-group|raw-person/);
    } finally { await client.close(); }
  });
  it("rejects a reservation note at the public boundary before persisting an action", async () => {
    const world = actionWorld(); const client = await protocolClient(world.context, { now: () => actionNow });
    try {
      const result = await client.callTool({ name: "preview_trip_change", arguments: {
        ...actionEnvelope, kind: "reservation_prepare", itemId: actionIds.item, partySize: 4,
        requestedAt: actionNow.toISOString(), note: "Private reservation request",
      } });
      expect(result.isError).toBe(true);
      expect(world.rows.trip_agent_actions).toHaveLength(0);
      expect(world.writes).toHaveLength(0);
    } finally { await client.close(); }
  });

  it.each(["vote_on_trip_change", "decide_trip_change"])("%s preserves exact durable replay and mutation rate limits through the wire", async name => {
    const world = actionWorld(); world.rows.trip_agent_connections[0].granted_scopes = ["trip.vote"];
    const settlement = { status: "open", reasonCode: "awaiting_vote", yes: 1, no: 0, needed: 2, travelerCount: 3 };
    // A replay exercises the real schema, HMAC binding, beginAction uniqueness,
    // response projection, transport and limiter without a second settlement.
    world.rows.trip_agent_actions.push({ id: actionIds.action, connection_id: actionIds.connection, trip_id: actionIds.trip,
      lifecycle_generation: 1,
      idempotency_key: actionIds.request, external_actor_digest: digestExternalIdentity(actionIds.connection, 1, actionEnvelope.externalParticipantId),
      mapped_traveler_id: actionIds.actor, operation: name === "vote_on_trip_change" ? "vote" : "decide",
      normalized_request: { actionId: actionIds.item, ...(name === "vote_on_trip_change" ? { vote: "up" } : { decision: "approve" }) },
      status: "awaiting_vote", authority_decision: "allowed", result: { settlement }, credential_digest: "PRIVATE", preview: null });
    const client = await protocolClient(world.context);
    try {
      const input = { ...actionEnvelope, actionId: actionIds.item, ...(name === "vote_on_trip_change" ? { vote: "up" } : { decision: "approve" }) };
      const result = await client.callTool({ name, arguments: input });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ ok: true, data: { status: "awaiting_vote", settlement } });
      expect(JSON.stringify(result)).not.toMatch(/PRIVATE|digest|normalized_request|raw-person/);
      expect(world.rpc.mock.calls.map(call => call[0])).toEqual(["consume_trip_agent_rate_limit"]);
      expect((await client.callTool({ name, arguments: { ...input, travelerId: actionIds.actor } })).isError).toBe(true);
      world.rows.travelers[0].is_bot = true;
      const denied = await client.callTool({ name, arguments: input });
      expect(denied.isError).toBe(true); expect(denied.structuredContent).toEqual({ ok: false, error: { code: "automated_travelers_cannot_vote", message: expect.any(String), retryable: false } });
    } finally { await client.close(); }
  });
  it("previews and commits a reservation through the wire with no commit requestId", async () => {
    const world = actionWorld(); const client = await protocolClient(world.context, { now: () => actionNow });
    try {
      const preview = await client.callTool({ name: "preview_trip_change", arguments: {
        ...actionEnvelope, kind: "reservation_prepare", itemId: actionIds.item, partySize: 4, requestedAt: actionNow.toISOString(),
      } });
      expect(preview.structuredContent).toMatchObject({ ok: true, data: { status: "previewed" } });
      const commit = { actionId: actionIds.action, externalGroupId: actionEnvelope.externalGroupId, externalParticipantId: actionEnvelope.externalParticipantId };
      const result = await client.callTool({ name: "commit_trip_change", arguments: commit });
      expect(result.structuredContent).toMatchObject({ ok: true, data: { status: "awaiting_confirmation" } });
      expect(JSON.stringify(result)).not.toMatch(/Private Organizer|booking.test|maps.test/);
      expect((await client.callTool({ name: "commit_trip_change", arguments: { ...commit, requestId: actionIds.request } })).isError).toBe(true);
      expect(world.rpc.mock.calls.filter(call => call[0] === "consume_trip_agent_rate_limit").every(call => call[1].p_bucket === "mutation")).toBe(true);
    } finally { await client.close(); }
  });
  it("negotiates the modern protocol and lists setup plus group-safe operational tools", async () => {
    const client = await protocolClient(activeProtocolContext());
    try {
      expect(client.getProtocolEra()).toBe("modern");
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "register_trip_group",
        "get_trip_agent_readiness",
        "activate_trip_agent",
        "get_trip_context",
        "get_today_plan",
        "search_trip_options",
        "get_pending_trip_decisions",
        "report_group_announcement",
        "preview_trip_change",
        "commit_trip_change",
        "vote_on_trip_change",
        "decide_trip_change",
      ]);
    } finally {
      await client.close();
    }
  });

  it("calls a valid unmatched-participant read through the official client transport", async () => {
    rpc.mockResolvedValue({ data: [{ allowed: true, count: 1, retry_after: 59 }], error: null });
    const loadTripContext = vi.fn().mockResolvedValue({
      trip: { slug: "family-trip" },
      items: [],
      pendingDecisions: [],
    });
    const client = await protocolClient(activeProtocolContext(), { loadTripContext });
    try {
      const result = await client.callTool({
        name: "get_trip_context",
        arguments: envelope,
      });

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toEqual({
        ok: true,
        data: { trip: { slug: "family-trip" }, items: [], pendingDecisions: [] },
      });
      expect(result._meta).toMatchObject({ requestId: envelope.requestId });
      expect(JSON.stringify(result._meta)).not.toMatch(/provider-group-7|raw-person/);
      expect(loadTripContext).toHaveBeenCalledWith(expect.anything(), "trip-1", null);
    } finally {
      await client.close();
    }
  });

  it("rejects an invalid tool schema before rate or domain execution", async () => {
    const loadTripContext = vi.fn();
    const client = await protocolClient(activeProtocolContext(), { loadTripContext });
    try {
      const result = await client.callTool({
        name: "get_trip_context",
        arguments: { ...envelope, unexpected: true },
      });

      expect(result.isError).toBe(true);
      expect(result.content).toEqual([
        expect.objectContaining({ type: "text", text: expect.stringContaining("Input validation error") }),
      ]);
      expect(rpc).not.toHaveBeenCalled();
      expect(loadTripContext).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("returns a structured exact-scope refusal without touching rate or domain code", async () => {
    const loadTripContext = vi.fn();
    const client = await protocolClient(
      activeProtocolContext("connection-1", "trip-1", ["trip.research"]),
      { loadTripContext },
    );
    try {
      const result = await client.callTool({ name: "get_trip_context", arguments: envelope });

      expect(result.structuredContent).toEqual({
        ok: false,
        error: { code: "missing_scope", message: expect.any(String), retryable: false },
      });
      expect(result.isError).toBe(true);
      expect(result._meta).toMatchObject({ requestId: envelope.requestId });
      expect(rpc).not.toHaveBeenCalled();
      expect(loadTripContext).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("refuses a cross-trip announcement through the protocol boundary", async () => {
    rpc
      .mockResolvedValueOnce({ data: [{ allowed: true, count: 1, retry_after: 59 }], error: null })
      .mockResolvedValueOnce({ data: { code: "action_not_found" }, error: null });
    const client = await protocolClient(activeProtocolContext(
      "connection-1",
      "trip-1",
      ["announcement.write"],
    ));
    try {
      const result = await client.callTool({
        name: "report_group_announcement",
        arguments: {
          ...envelope,
          actionId: "00000000-0000-4000-8000-000000000099",
          deliveryStatus: "delivered",
        },
      });

      expect(result.structuredContent).toEqual({
        ok: false,
        error: { code: "action_not_found", message: expect.any(String), retryable: false },
      });
      expect(result.isError).toBe(true);
      expect(interactions).toHaveLength(0);
    } finally {
      await client.close();
    }
  });

  it("keeps authenticated tool context isolated across concurrent requests", async () => {
    rpc.mockResolvedValue({ data: [{ allowed: true, count: 1, retry_after: 59 }], error: null });
    const loadA = vi.fn().mockResolvedValue({
      trip: { slug: "trip-a" }, items: [], pendingDecisions: [],
    });
    const loadB = vi.fn().mockResolvedValue({
      trip: { slug: "trip-b" }, items: [], pendingDecisions: [],
    });
    const [clientA, clientB] = await Promise.all([
      protocolClient(activeProtocolContext("connection-a", "trip-a"), { loadTripContext: loadA }),
      protocolClient(activeProtocolContext("connection-b", "trip-b"), { loadTripContext: loadB }),
    ]);
    try {
      const [resultA, resultB] = await Promise.all([
        clientA.callTool({ name: "get_trip_context", arguments: envelope }),
        clientB.callTool({ name: "get_trip_context", arguments: envelope }),
      ]);

      expect(resultA.structuredContent).toMatchObject({ data: { trip: { slug: "trip-a" } } });
      expect(resultB.structuredContent).toMatchObject({ data: { trip: { slug: "trip-b" } } });
      expect(loadA).toHaveBeenCalledWith(expect.anything(), "trip-a", null);
      expect(loadB).toHaveBeenCalledWith(expect.anything(), "trip-b", null);
    } finally {
      await Promise.all([clientA.close(), clientB.close()]);
    }
  });

  it("marks rate-limit and database refusals as wire errors without leaking exceptions", async () => {
    const secret = "SECRET_RATE_DATABASE_DIAGNOSTIC_SHOULD_NOT_ESCAPE";
    const loadTripContext = vi.fn();
    const client = await protocolClient(activeProtocolContext(), { loadTripContext });
    try {
      rpc.mockResolvedValueOnce({
        data: [{ allowed: false, count: 121, retry_after: 17 }],
        error: null,
      });
      const limited = await client.callTool({ name: "get_trip_context", arguments: envelope });
      expect(limited.isError).toBe(true);
      expect(limited.structuredContent).toEqual({
        ok: false,
        error: { code: "rate_limited", retryAfter: 17, message: expect.any(String), retryable: true },
      });
      expect(limited._meta).toMatchObject({ requestId: envelope.requestId });

      rpc.mockRejectedValueOnce(new Error(secret));
      const unavailable = await client.callTool({ name: "get_trip_context", arguments: envelope });
      expect(unavailable.isError).toBe(true);
      expect(unavailable.structuredContent).toEqual({
        ok: false,
        error: { code: "database_unavailable", message: expect.any(String), retryable: true },
      });
      expect(unavailable._meta).toMatchObject({ requestId: envelope.requestId });
      expect(JSON.stringify(unavailable)).not.toContain(secret);
      expect(loadTripContext).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("sanitizes thrown setup database diagnostics into a bounded wire error", async () => {
    const secret = "SECRET_SETUP_DATABASE_DIAGNOSTIC_SHOULD_NOT_ESCAPE";
    const db = {
      rpc: vi.fn().mockResolvedValue({
        data: [{ allowed: true, count: 1, retry_after: 59 }],
        error: null,
      }),
      from: vi.fn(() => { throw new Error(secret); }),
    } as unknown as SupabaseClient;
    const client = await protocolClient({
      db,
      connection: {
        id: "connection-1",
        tripId: "trip-1",
        lifecycleGeneration: 1,
        status: "paired",
        grantedScopes: ["connector.setup"],
        whatsappGroupDigest: null,
      },
    });
    try {
      const result = await client.callTool({
        name: "register_trip_group",
        arguments: {
          ...envelope,
          groupLabel: "Family trip",
          participants: [],
        },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        ok: false,
        error: { code: "database_unavailable", message: expect.any(String), retryable: true },
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally {
      await client.close();
    }
  });

  it("sanitizes missing HMAC configuration before rate or domain execution", async () => {
    delete process.env.TRIP_AGENT_IDENTITY_PEPPER;
    const loadTripContext = vi.fn();
    const client = await protocolClient(context({
      status: "active",
      grantedScopes: ["trip.read"],
      whatsappGroupDigest: "configured-group-digest",
    }), { loadTripContext });
    try {
      const result = await client.callTool({ name: "get_trip_context", arguments: envelope });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        ok: false,
        error: { code: "configuration_unavailable", message: expect.any(String), retryable: false },
      });
      expect(JSON.stringify(result)).not.toContain("TRIP_AGENT_IDENTITY_PEPPER must be configured");
      expect(rpc).not.toHaveBeenCalled();
      expect(loadTripContext).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("sanitizes thrown announcement lookups into a bounded wire error", async () => {
    const secret = "SECRET_ACTION_DATABASE_DIAGNOSTIC_SHOULD_NOT_ESCAPE";
    const db = {
      rpc: vi.fn().mockResolvedValue({
        data: [{ allowed: true, count: 1, retry_after: 59 }],
        error: null,
      }),
      from: vi.fn(() => { throw new Error(secret); }),
    } as unknown as SupabaseClient;
    const client = await protocolClient({
      db,
      connection: {
        id: "connection-1",
        tripId: "trip-1",
        lifecycleGeneration: 1,
        status: "active",
        grantedScopes: ["announcement.write"],
        whatsappGroupDigest: digestExternalIdentity("connection-1", 1, envelope.externalGroupId),
      },
    });
    try {
      const result = await client.callTool({
        name: "report_group_announcement",
        arguments: {
          ...envelope,
          actionId: "00000000-0000-4000-8000-000000000099",
          deliveryStatus: "delivered",
        },
      });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toEqual({
        ok: false,
        error: { code: "database_unavailable", message: expect.any(String), retryable: true },
      });
      expect(JSON.stringify(result)).not.toContain(secret);
    } finally {
      await client.close();
    }
  });
});
