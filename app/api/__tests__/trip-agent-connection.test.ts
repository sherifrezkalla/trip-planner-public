import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authTraveler: vi.fn(),
  client: vi.fn(),
  interactions: [] as Array<{
    table: string;
    operation: string;
    payload?: unknown;
    projection?: string;
    filters: Array<[string, unknown]>;
    order?: [string, unknown];
    limit?: number;
  }>,
  results: new Map<string, Array<{ data: unknown; error: unknown }>>(),
  rpc: vi.fn(),
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  rpcResults: new Map<string, Array<{ data: unknown; error: unknown }>>(),
}));

vi.mock("@/lib/db", () => ({ serviceClient: () => mocks.client() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, authTraveler: mocks.authTraveler };
});
vi.mock("server-only", () => ({}));

import { TRIP_TOKEN_HEADER } from "@/lib/auth";
import {
  createTripAgentConnectionSchema,
  updateTripAgentConnectionSchema,
} from "@/lib/schema";
import { digestTripAgentSecret } from "@/lib/trip-agent-auth";

type Handler = (request: Request, context: { params: Promise<{ slug: string }> }) => Promise<Response>;
const loadHandler = (name: "DELETE" | "GET" | "PATCH" | "POST"): Handler => async (req, ctx) => {
  const route = await import("@/app/api/trips/[slug]/agent-connection/route");
  return route[name](req, ctx);
};
const DELETE = loadHandler("DELETE");
const GET = loadHandler("GET");
const PATCH = loadHandler("PATCH");
const POST = loadHandler("POST");

type DbResult = { data: unknown; error: unknown };

const params = Promise.resolve({ slug: "summer" });
const auth = {
  trip: { id: "trip-1", slug: "summer" },
  me: { id: "organizer-1", is_organizer: true, is_bot: false },
};

const connection = {
  id: "connection-1",
  trip_id: "trip-1",
  provider: "openclaw",
  status: "paired",
  lifecycle_generation: 1,
  granted_scopes: ["connector.setup"],
  authority_policy: {
    travelerCanAddSuggestion: true,
    travelerCanProposeChange: true,
  },
  agent_phone_e164: "+491701234567",
  whatsapp_group_label: "Summer group",
  paired_at: "2026-09-01T10:00:00.000Z",
  activated_at: null,
  paused_at: null,
  revoked_at: null,
  archived_at: null,
  created_at: "2026-09-01T09:00:00.000Z",
  updated_at: "2026-09-01T10:00:00.000Z",
};

function queue(table: string, ...results: DbResult[]) {
  mocks.results.set(table, [...(mocks.results.get(table) ?? []), ...results]);
}

function next(table: string): DbResult {
  return mocks.results.get(table)?.shift() ?? { data: null, error: null };
}

function queueRpc(name: string, ...results: DbResult[]) {
  mocks.rpcResults.set(name, [...(mocks.rpcResults.get(name) ?? []), ...results]);
}

function nextRpc(name: string): DbResult {
  return mocks.rpcResults.get(name)?.shift() ?? { data: null, error: null };
}

function query(table: string) {
  const record = {
    table,
    operation: "read",
    filters: [] as Array<[string, unknown]>,
  } as (typeof mocks.interactions)[number];
  mocks.interactions.push(record);
  const builder: Record<string, unknown> = {};
  builder.select = (projection: string) => {
    record.projection = projection;
    return builder;
  };
  builder.insert = (payload: unknown) => {
    record.operation = "insert";
    record.payload = payload;
    return builder;
  };
  builder.update = (payload: unknown) => {
    record.operation = "update";
    record.payload = payload;
    return builder;
  };
  builder.eq = (column: string, value: unknown) => {
    record.filters.push([column, value]);
    return builder;
  };
  builder.order = (column: string, options: unknown) => {
    record.order = [column, options];
    return builder;
  };
  builder.limit = (value: number) => {
    record.limit = value;
    return builder;
  };
  builder.maybeSingle = () => Promise.resolve(next(table));
  builder.single = () => Promise.resolve(next(table));
  builder.then = (resolve: (value: DbResult) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(next(table)).then(resolve, reject);
  return builder;
}

function request(method: string, body?: unknown, token = "organizer-token") {
  return new Request("https://trip-planner.test/api/trips/summer/agent-connection", {
    method,
    headers: {
      [TRIP_TOKEN_HEADER]: token,
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function queryTokenRequest(method: string, body?: unknown, token = "organizer-token") {
  return new Request(`https://trip-planner.test/api/trips/summer/agent-connection?token=${token}`, {
    method,
    headers: body === undefined ? undefined : { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function writes(table = "trip_agent_connections") {
  return mocks.interactions.filter((item) => item.table === table && item.operation !== "read");
}

beforeEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  mocks.interactions.length = 0;
  mocks.results.clear();
  mocks.rpcCalls.length = 0;
  mocks.rpcResults.clear();
  mocks.rpc.mockImplementation((name: string, args: unknown) => {
    mocks.rpcCalls.push({ name, args });
    return Promise.resolve(nextRpc(name));
  });
  mocks.client.mockImplementation(() => ({ from: query, rpc: mocks.rpc }));
  mocks.authTraveler.mockResolvedValue(auth);
});

describe("trip-agent organizer request schemas", () => {
  it("accepts only a known provider for creation", () => {
    expect(createTripAgentConnectionSchema.safeParse({ provider: "openclaw" }).success).toBe(true);
    expect(createTripAgentConnectionSchema.safeParse({ provider: "other" }).success).toBe(false);
    expect(createTripAgentConnectionSchema.safeParse({ provider: "openclaw", extra: true }).success).toBe(false);
  });

  it.each(["pause", "resume", "rotate", "archive"])("accepts the strict %s action", (action) => {
    expect(updateTripAgentConnectionSchema.safeParse({ action }).success).toBe(true);
    expect(updateTripAgentConnectionSchema.safeParse({ action, extra: true }).success).toBe(false);
  });

  it("bounds policy changes to exact booleans and known scopes", () => {
    const valid = {
      action: "update_policy",
      travelerCanAddSuggestion: false,
      travelerCanProposeChange: true,
      grantedScopes: ["connector.setup", "trip.read"],
    };
    expect(updateTripAgentConnectionSchema.safeParse(valid).success).toBe(true);
    expect(updateTripAgentConnectionSchema.safeParse({ ...valid, grantedScopes: ["admin"] }).success).toBe(false);
    expect(updateTripAgentConnectionSchema.safeParse({ ...valid, travelerCanAddSuggestion: "yes" }).success).toBe(false);
    expect(updateTripAgentConnectionSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });

  it("accepts only E.164 phone numbers and 1-100 character group labels", () => {
    const metadata = {
      action: "update_metadata",
      agentPhoneE164: "+491701234567",
      whatsappGroupLabel: "x".repeat(100),
    };
    expect(updateTripAgentConnectionSchema.safeParse(metadata).success).toBe(true);
    for (const agentPhoneE164 of ["491701234567", "+123456", "+1234567890123456", "+49 1701234567"]) {
      expect(updateTripAgentConnectionSchema.safeParse({ ...metadata, agentPhoneE164 }).success).toBe(false);
    }
    expect(updateTripAgentConnectionSchema.safeParse({ ...metadata, whatsappGroupLabel: "" }).success).toBe(false);
    expect(updateTripAgentConnectionSchema.safeParse({ ...metadata, whatsappGroupLabel: "x".repeat(101) }).success).toBe(false);
  });
});

describe("/api/trips/[slug]/agent-connection authorization", () => {
  it.each([
    ["openclaw", null, null, null, false, false],
    ["openclaw", "group-digest-secret", null, null, true, false],
    ["openclaw", "group-digest-secret", "v1", "receipt-digest-secret", true, true],
    ["openclaw", "group-digest-secret", "v1", null, true, false],
    ["hermes", null, null, null, false, false],
    ["hermes", "group-digest-secret", null, null, true, false],
    ["hermes", "group-digest-secret", "v1", "receipt-digest-secret", true, true],
    ["hermes", "group-digest-secret", "v1", null, true, false],
  ])("exposes provider-neutral boolean setup evidence for %s, never group or receipt digests", async (provider, group, version, receipt, registered, delivered) => {
    const row = { ...connection, provider, whatsapp_group_digest: group, privacy_notice_version: version, privacy_notice_message_digest: receipt };
    queue("trip_agent_connections", { data: row, error: null }, { data: row, error: null });
    queue("trip_agent_participant_mappings", { data: [], error: null });
    queue("trip_agent_actions", { data: [], error: null });
    const response = await GET(request("GET"), { params });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.connection.provider).toBe(provider);
    expect(body.connection.groupRegistered).toBe(registered);
    expect(body.connection.privacyNoticeDelivered).toBe(delivered);
    expect(JSON.stringify(body)).not.toContain("digest-secret");
    expect(body.connection).not.toHaveProperty("whatsapp_group_digest");
    expect(body.connection).not.toHaveProperty("privacy_notice_message_digest");
  });

  it.each([
    ["GET", GET, undefined],
    ["POST", POST, { provider: "openclaw" }],
    ["PATCH", PATCH, { action: "pause" }],
    ["DELETE", DELETE, undefined],
  ] as const)("keeps %s organizer-only and authenticates from the trip header", async (method, handler, body) => {
    mocks.authTraveler.mockResolvedValue({ ...auth, me: { ...auth.me, is_organizer: false } });

    const response = await handler(request(method, body), { params });

    expect(response.status).toBe(403);
    expect(mocks.authTraveler).toHaveBeenCalledWith(expect.anything(), "summer", "organizer-token");
    expect(writes()).toHaveLength(0);
  });

  it.each([
    ["GET", GET, undefined],
    ["POST", POST, { provider: "openclaw" }],
    ["PATCH", PATCH, { action: "pause" }],
    ["DELETE", DELETE, undefined],
  ] as const)("rejects a query-only organizer token on %s", async (method, handler, body) => {
    mocks.authTraveler.mockResolvedValue({ status: 401, error: "Invalid traveler token" });

    const response = await handler(queryTokenRequest(method, body), { params });

    expect(response.status).toBe(401);
    expect(mocks.authTraveler).toHaveBeenCalledWith(expect.anything(), "summer", "");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it.each([
    ["GET", GET, undefined],
    ["POST", POST, { provider: "openclaw" }],
    ["PATCH", PATCH, { action: "pause" }],
    ["DELETE", DELETE, undefined],
  ] as const)("denies a malformed bot organizer on %s", async (method, handler, body) => {
    mocks.authTraveler.mockResolvedValue({ ...auth, me: { ...auth.me, is_bot: true } });

    const response = await handler(request(method, body), { params });

    expect(response.status).toBe(403);
    expect(writes()).toHaveLength(0);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("POST /api/trips/[slug]/agent-connection", () => {
  it("issues ten-minute pairing material once and stores only its digest with setup scope", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T12:00:00.000Z"));
    queue("trip_agent_connections", { data: null, error: null }, { data: { ...connection, status: "pending" }, error: null });

    const response = await POST(request("POST", { provider: "openclaw" }), { params });
    const body = await response.json() as { pairingCode: string; pairingExpiresAt: string };

    expect(response.status).toBe(201);
    expect(body.pairingCode).toEqual(expect.any(String));
    expect(body.pairingExpiresAt).toBe("2026-09-04T12:10:00.000Z");
    expect(writes()[0].payload).toMatchObject({
      trip_id: "trip-1",
      provider: "openclaw",
      status: "pending",
      pairing_code_digest: digestTripAgentSecret(body.pairingCode),
      pairing_expires_at: "2026-09-04T12:10:00.000Z",
      granted_scopes: ["connector.setup"],
    });
    expect(JSON.stringify(writes()[0].payload)).not.toContain(body.pairingCode);
  });

  it("replaces an old pending pairing digest instead of creating a second row", async () => {
    queue("trip_agent_connections", { data: { ...connection, status: "pending" }, error: null }, { data: { ...connection, status: "pending" }, error: null });

    const response = await POST(request("POST", { provider: "hermes" }), { params });
    const body = await response.json() as { pairingCode: string };

    expect(response.status).toBe(201);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].operation).toBe("update");
    expect(writes()[0].filters).toContainEqual(["id", "connection-1"]);
    expect(writes()[0].payload).toMatchObject({
      provider: "hermes",
      pairing_code_digest: digestTripAgentSecret(body.pairingCode),
      updated_at: expect.any(String),
    });
    expect(writes()[0].filters).toContainEqual(["updated_at", connection.updated_at]);
  });

  it.each(["revoked", "archived"])("atomically starts a fresh generation from a %s row", async (status) => {
    queue(
      "trip_agent_connections",
      { data: { ...connection, status }, error: null },
    );
    queueRpc("replace_trip_agent_connection", {
      data: [{ ...connection, provider: "hermes", status: "pending", lifecycle_generation: 2 }],
      error: null,
    });

    const response = await POST(request("POST", { provider: "hermes" }), { params });
    const body = await response.json() as { pairingCode: string; connection: { lifecycleGeneration: number } };

    expect(response.status).toBe(201);
    expect(body.connection.lifecycleGeneration).toBe(2);
    expect(writes()).toHaveLength(0);
    expect(mocks.rpcCalls[0]).toMatchObject({
      name: "replace_trip_agent_connection",
      args: {
        p_connection_id: "connection-1",
        p_expected_updated_at: connection.updated_at,
        p_provider: "hermes",
        p_pairing_digest: digestTripAgentSecret(body.pairingCode),
        p_pairing_expires_at: expect.any(String),
        p_actor_id: "organizer-1",
        p_now: expect.any(String),
      },
    });
  });

  it("rejects a stale pending reissue instead of overwriting a connection paired concurrently", async () => {
    queue(
      "trip_agent_connections",
      { data: { ...connection, status: "pending" }, error: null },
      { data: null, error: null },
    );

    const response = await POST(request("POST", { provider: "hermes" }), { params });

    expect(response.status).toBe(409);
    expect(writes()[0].filters).toContainEqual(["updated_at", connection.updated_at]);
  });

  it.each(["paired", "active", "paused"])("does not silently replace a %s connector", async (status) => {
    queue("trip_agent_connections", { data: { ...connection, status }, error: null });
    const response = await POST(request("POST", { provider: "hermes" }), { params });
    expect(response.status).toBe(409);
    expect(writes()).toHaveLength(0);
  });
});

describe("GET /api/trips/[slug]/agent-connection", () => {
  it("returns an explicit redacted projection", async () => {
    queue("trip_agent_connections", {
      data: {
        ...connection,
        credential_digest: "credential-secret-digest",
        pairing_code_digest: "pairing-secret-digest",
        whatsapp_group_digest: "group-secret-digest",
        normalized_request: { private: true },
        preview: { private: true },
        result: { private: true },
        reservation_payload: { private: true },
      },
      error: null,
    }, { data: connection, error: null });

    const response = await GET(request("GET"), { params });
    const body = await response.json();
    const serialized = JSON.stringify(body);

    expect(response.status).toBe(200);
    expect(body).toMatchObject({ connection: { id: "connection-1", status: "paired", provider: "openclaw" } });
    for (const privateValue of ["credential-secret-digest", "pairing-secret-digest", "group-secret-digest", "normalized_request", "reservation_payload"]) {
      expect(serialized).not.toContain(privateValue);
    }
    // Group/notice digests are read server-side only to derive booleans.
    expect(mocks.interactions[0].projection).not.toMatch(/credential_digest|pairing_code_digest/);
    expect(body.connection.groupRegistered).toBe(true);
  });

  it("returns only current-generation redacted mappings and bounded newest-first action summaries", async () => {
    const proposalId = "30000000-0000-4000-8000-000000000001";
    queue("trip_agent_connections", { data: connection, error: null }, { data: connection, error: null });
    queue("trip_agent_participant_mappings", { data: [{
      id: "mapping-1",
      lifecycle_generation: 1,
      display_name_hint: "Sam",
      traveler_id: "traveler-1",
      status: "confirmed",
      confirmed_by: "organizer-1",
      confirmed_at: "2026-09-01T10:01:00.000Z",
      revoked_at: null,
      created_at: "2026-09-01T10:00:00.000Z",
      updated_at: "2026-09-01T10:01:00.000Z",
      external_participant_digest: "must-not-leak",
    }], error: null });
    queue("trip_agent_actions", { data: [{
      id: "action-1",
      lifecycle_generation: 1,
      mapped_traveler_id: "traveler-1",
      operation: "preview_change",
      authority_decision: "allowed",
      status: "succeeded",
      error_code: null,
      announcement_status: "delivered",
      proposal_id: proposalId,
      canonical_reference: { kind: "plan_proposal", id: proposalId, private: "drop" },
      created_at: "2026-09-01T10:02:00.000Z",
      updated_at: "2026-09-01T10:03:00.000Z",
      executed_at: "2026-09-01T10:03:00.000Z",
      normalized_request: { note: "private" },
      preview: { private: true },
      result: { private: true },
      external_actor_digest: "must-not-leak",
    }], error: null });

    const response = await GET(request("GET"), { params });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(body).toEqual({
      connection: expect.objectContaining({ id: "connection-1", lifecycleGeneration: 1 }),
      mappings: [{
        id: "mapping-1", displayNameHint: "Sam", travelerId: "traveler-1", status: "confirmed",
        confirmedBy: "organizer-1", confirmedAt: "2026-09-01T10:01:00.000Z", revokedAt: null,
        createdAt: "2026-09-01T10:00:00.000Z", updatedAt: "2026-09-01T10:01:00.000Z",
      }],
      recentActions: [{
        id: "action-1", mappedTravelerId: "traveler-1", operation: "preview_change",
        authorityDecision: "allowed", status: "succeeded", errorCode: null,
        announcementStatus: "delivered", proposalId,
        canonicalReference: { kind: "plan_proposal", id: proposalId },
        createdAt: "2026-09-01T10:02:00.000Z", updatedAt: "2026-09-01T10:03:00.000Z",
        executedAt: "2026-09-01T10:03:00.000Z",
      }],
    });
    const mappingRead = mocks.interactions.find((item) => item.table === "trip_agent_participant_mappings");
    const actionRead = mocks.interactions.find((item) => item.table === "trip_agent_actions");
    expect(mappingRead?.filters).toContainEqual(["lifecycle_generation", 1]);
    expect(actionRead?.filters).toContainEqual(["lifecycle_generation", 1]);
    expect(actionRead?.order).toEqual(["created_at", { ascending: false }]);
    expect(actionRead?.limit).toBe(25);
    expect(`${mappingRead?.projection} ${actionRead?.projection}`).not.toMatch(/external_participant_digest|external_actor_digest|normalized_request|preview|result/);
    expect(JSON.stringify(body)).not.toMatch(/must-not-leak|private/);
  });

  it("nulls malformed or unapproved action references instead of echoing stored JSON", async () => {
    const validId = "30000000-0000-4000-8000-000000000001";
    const baseAction = {
      lifecycle_generation: 1,
      mapped_traveler_id: null,
      operation: "preview_change",
      authority_decision: "allowed",
      status: "succeeded",
      error_code: null,
      announcement_status: "pending",
      created_at: "2026-09-01T10:02:00.000Z",
      updated_at: "2026-09-01T10:03:00.000Z",
      executed_at: "2026-09-01T10:03:00.000Z",
    };
    queue("trip_agent_connections", { data: connection, error: null }, { data: connection, error: null });
    queue("trip_agent_participant_mappings", { data: [], error: null });
    queue("trip_agent_actions", { data: [
      {
        ...baseAction,
        id: "action-unknown-kind",
        proposal_id: "private-proposal-value",
        canonical_reference: { kind: "private_note", id: validId, private: "unknown-kind-secret" },
      },
      {
        ...baseAction,
        id: "action-invalid-id",
        proposal_id: null,
        canonical_reference: { kind: "plan_proposal", id: "private-reference-value" },
      },
      {
        ...baseAction,
        id: "action-array",
        proposal_id: null,
        canonical_reference: [{ kind: "plan_proposal", id: validId }, "array-secret"],
      },
    ], error: null });

    const response = await GET(request("GET"), { params });
    const body = await response.json() as {
      recentActions: Array<{ proposalId: string | null; canonicalReference: unknown }>;
    };

    expect(response.status).toBe(200);
    expect(body.recentActions.map(({ proposalId, canonicalReference }) => ({ proposalId, canonicalReference })))
      .toEqual([
        { proposalId: null, canonicalReference: null },
        { proposalId: null, canonicalReference: null },
        { proposalId: null, canonicalReference: null },
      ]);
    expect(JSON.stringify(body)).not.toMatch(/private-proposal-value|private-reference-value|unknown-kind-secret|array-secret/);
  });

  it("summarizes durable setup commands without exposing normalized identifiers or stored results", async () => {
    queue("trip_agent_connections", { data: connection, error: null }, { data: connection, error: null });
    queue("trip_agent_participant_mappings", { data: [], error: null });
    queue("trip_agent_actions", { data: [{
      id: "action-register",
      mapped_traveler_id: null,
      operation: "register_group",
      authority_decision: "allowed",
      status: "succeeded",
      error_code: null,
      announcement_status: "pending",
      proposal_id: null,
      canonical_reference: null,
      created_at: "2026-09-01T10:02:00.000Z",
      updated_at: "2026-09-01T10:03:00.000Z",
      executed_at: "2026-09-01T10:03:00.000Z",
      normalized_request: { groupDigest: "private-group-digest" },
      result: { private: "stored-command-result" },
      external_actor_digest: "private-actor-digest",
    }], error: null });

    const response = await GET(request("GET"), { params });
    const body = await response.json() as { recentActions: Array<Record<string, unknown>> };

    expect(response.status).toBe(200);
    expect(body.recentActions).toEqual([expect.objectContaining({
      id: "action-register",
      operation: "register_group",
      status: "succeeded",
    })]);
    expect(JSON.stringify(body)).not.toMatch(/private-group-digest|stored-command-result|private-actor-digest|normalized_request/);
  });

  it("fails closed instead of returning mappings and actions from a changed lifecycle snapshot", async () => {
    queue(
      "trip_agent_connections",
      { data: connection, error: null },
      { data: { ...connection, lifecycle_generation: 2, updated_at: "2026-09-01T10:05:00.000Z" }, error: null },
    );
    queue("trip_agent_participant_mappings", { data: [{
      id: "stale-mapping",
      display_name_hint: "Old identity",
      traveler_id: null,
      status: "suggested",
      confirmed_by: null,
      confirmed_at: null,
      revoked_at: null,
      created_at: "2026-09-01T10:00:00.000Z",
      updated_at: "2026-09-01T10:00:00.000Z",
    }], error: null });
    queue("trip_agent_actions", { data: [], error: null });

    const response = await GET(request("GET"), { params });
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(409);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(serialized).not.toContain("stale-mapping");
  });

  it("returns explicit empty aggregate lists when no connection exists", async () => {
    queue("trip_agent_connections", { data: null, error: null });

    const response = await GET(request("GET"), { params });

    expect(await response.json()).toEqual({ connection: null, mappings: [], recentActions: [] });
    expect(mocks.interactions.filter((item) => item.table !== "trip_agent_connections")).toHaveLength(0);
  });

  it.each(["trip_agent_participant_mappings", "trip_agent_actions"])("fails closed when aggregate %s loading fails", async (table) => {
    queue("trip_agent_connections", { data: connection, error: null });
    queue("trip_agent_participant_mappings", table === "trip_agent_participant_mappings"
      ? { data: null, error: { message: "offline" } }
      : { data: [], error: null });
    if (table === "trip_agent_actions") queue("trip_agent_actions", { data: null, error: { message: "offline" } });

    const response = await GET(request("GET"), { params });

    expect(response.status).toBe(500);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

describe("PATCH /api/trips/[slug]/agent-connection", () => {
  it("strictly advances the CAS version when the wall clock equals the observed timestamp", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(connection.updated_at));
    queue(
      "trip_agent_connections",
      { data: { ...connection, status: "active" }, error: null },
      { data: { ...connection, status: "paused", updated_at: "2026-09-01T10:00:00.001Z" }, error: null },
    );

    const response = await PATCH(request("PATCH", { action: "pause" }), { params });

    expect(response.status).toBe(200);
    expect(writes()[0].payload).toMatchObject({ updated_at: "2026-09-01T10:00:00.001Z" });
  });

  it("persists pause before returning", async () => {
    queue("trip_agent_connections", { data: { ...connection, status: "active", activated_at: "2026-09-01T11:00:00.000Z" }, error: null }, { data: { ...connection, status: "paused" }, error: null });
    const response = await PATCH(request("PATCH", { action: "pause" }), { params });
    expect(response.status).toBe(200);
    expect(writes()[0].payload).toMatchObject({
      status: "paused",
      paused_at: expect.any(String),
      updated_at: expect.any(String),
    });
    expect(writes()[0].filters).toContainEqual(["updated_at", connection.updated_at]);
  });

  it("returns a conflict when a lifecycle compare-and-set observes a newer state", async () => {
    queue(
      "trip_agent_connections",
      { data: { ...connection, status: "active" }, error: null },
      { data: null, error: null },
    );

    const response = await PATCH(request("PATCH", { action: "pause" }), { params });

    expect(response.status).toBe(409);
    expect(writes()[0].filters).toContainEqual(["updated_at", connection.updated_at]);
  });

  it.each([
    [null, "paired"],
    ["2026-09-01T11:00:00.000Z", "active"],
  ])("resumes a paused connector according to activation history", async (activatedAt, status) => {
    queue("trip_agent_connections", { data: { ...connection, status: "paused", activated_at: activatedAt }, error: null }, { data: { ...connection, status }, error: null });
    const response = await PATCH(request("PATCH", { action: "resume" }), { params });
    expect(response.status).toBe(200);
    expect(writes()[0].payload).toMatchObject({ status, paused_at: null });
  });

  it.each(["revoked", "archived"])("refuses to resume a terminal %s connector", async (status) => {
    queue("trip_agent_connections", { data: { ...connection, status }, error: null });
    const response = await PATCH(request("PATCH", { action: "resume" }), { params });
    expect(response.status).toBe(409);
    expect(writes()).toHaveLength(0);
  });

  it("rotates atomically with its audit, preserves state, and returns plaintext once", async () => {
    queue("trip_agent_connections", { data: { ...connection, status: "active" }, error: null });
    queueRpc("rotate_trip_agent_credential", { data: [{ ...connection, status: "active" }], error: null });

    const response = await PATCH(request("PATCH", { action: "rotate" }), { params });
    const body = await response.json() as { credential: string; connection: { status: string } };

    expect(response.status).toBe(200);
    expect(body.connection.status).toBe("active");
    expect(mocks.rpcCalls).toHaveLength(1);
    expect(mocks.rpcCalls[0]).toMatchObject({
      name: "rotate_trip_agent_credential",
      args: expect.objectContaining({
        p_connection_id: "connection-1",
        p_expected_updated_at: connection.updated_at,
        p_credential_digest: digestTripAgentSecret(body.credential),
        p_actor_id: "organizer-1",
      }),
    });
    expect(writes()).toHaveLength(0);
    expect(JSON.stringify(mocks.rpcCalls)).not.toContain(body.credential);
  });

  it("preserves group and receipt flags when rotation RPC returns only its public columns", async () => {
    queue("trip_agent_connections", { data: { ...connection, status: "active", whatsapp_group_digest: "private-group", privacy_notice_version: "v1", privacy_notice_message_digest: "private-receipt" }, error: null });
    queueRpc("rotate_trip_agent_credential", { data: [{ ...connection, status: "active" }], error: null });
    const response = await PATCH(request("PATCH", { action: "rotate" }), { params });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.connection).toMatchObject({ groupRegistered: true, privacyNoticeDelivered: true });
    expect(JSON.stringify(body)).not.toContain("private-group");
    expect(JSON.stringify(body)).not.toContain("private-receipt");
  });

  it("passes a version strictly after the observed timestamp to same-clock rotation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(connection.updated_at));
    queue("trip_agent_connections", { data: { ...connection, status: "active" }, error: null });
    queueRpc("rotate_trip_agent_credential", { data: [{ ...connection, status: "active", updated_at: "2026-09-01T10:00:00.001Z" }], error: null });

    const response = await PATCH(request("PATCH", { action: "rotate" }), { params });

    expect(response.status).toBe(200);
    expect(mocks.rpcCalls[0]).toMatchObject({
      args: expect.objectContaining({ p_now: "2026-09-01T10:00:00.001Z" }),
    });
  });

  it("does not issue a plaintext credential when atomic rotation or its audit fails", async () => {
    queue("trip_agent_connections", { data: { ...connection, status: "active" }, error: null });
    queueRpc("rotate_trip_agent_credential", { data: null, error: { message: "audit failed" } });

    const response = await PATCH(request("PATCH", { action: "rotate" }), { params });

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not manage trip agent connection" });
    expect(writes()).toHaveLength(0);
  });

  it("returns a conflict for the loser of concurrent credential rotations", async () => {
    queue(
      "trip_agent_connections",
      { data: { ...connection, status: "active" }, error: null },
      { data: { ...connection, status: "active" }, error: null },
    );
    queueRpc(
      "rotate_trip_agent_credential",
      { data: [{ ...connection, status: "active" }], error: null },
      { data: [], error: null },
    );

    const responses = await Promise.all([
      PATCH(request("PATCH", { action: "rotate" }), { params }),
      PATCH(request("PATCH", { action: "rotate" }), { params }),
    ]);

    expect(responses.map((response) => response.status).sort()).toEqual([200, 409]);
    const bodies = await Promise.all(
      responses.map(async (response): Promise<{ credential?: string }> => response.json()),
    );
    expect(bodies.filter((body) => body.credential)).toHaveLength(1);
  });

  it("archives terminally, clears all credentials, and records the polling stop time", async () => {
    queue("trip_agent_connections", { data: connection, error: null }, { data: { ...connection, status: "archived" }, error: null });
    const response = await PATCH(request("PATCH", { action: "archive" }), { params });
    expect(response.status).toBe(200);
    expect(writes()[0].payload).toMatchObject({
      status: "archived",
      credential_digest: null,
      pairing_code_digest: null,
      pairing_expires_at: null,
      archived_at: expect.any(String),
    });
  });

  it("writes only the two policy booleans and known granted scopes", async () => {
    queue("trip_agent_connections", { data: connection, error: null }, { data: connection, error: null });
    const response = await PATCH(request("PATCH", {
      action: "update_policy",
      travelerCanAddSuggestion: false,
      travelerCanProposeChange: true,
      grantedScopes: ["connector.setup", "trip.read"],
    }), { params });
    expect(response.status).toBe(200);
    expect(writes()[0].payload).toEqual({
      authority_policy: { travelerCanAddSuggestion: false, travelerCanProposeChange: true },
      granted_scopes: ["connector.setup", "trip.read"],
      updated_at: expect.any(String),
    });
  });

  it("stores validated connection metadata", async () => {
    queue("trip_agent_connections", { data: connection, error: null }, { data: connection, error: null });
    const response = await PATCH(request("PATCH", {
      action: "update_metadata",
      agentPhoneE164: "+491701234567",
      whatsappGroupLabel: "Summer group",
    }), { params });
    expect(response.status).toBe(200);
    expect(writes()[0].payload).toEqual({
      agent_phone_e164: "+491701234567",
      whatsapp_group_label: "Summer group",
      updated_at: expect.any(String),
    });
  });
});

describe("DELETE /api/trips/[slug]/agent-connection", () => {
  it("revokes immediately and clears credential and pairing digests", async () => {
    queue("trip_agent_connections", { data: connection, error: null }, { data: { ...connection, status: "revoked" }, error: null });
    const response = await DELETE(request("DELETE"), { params });
    expect(response.status).toBe(200);
    expect(writes()[0].payload).toMatchObject({
      status: "revoked",
      credential_digest: null,
      pairing_code_digest: null,
      pairing_expires_at: null,
      revoked_at: expect.any(String),
      updated_at: expect.any(String),
    });
  });

  it("refuses to revoke an already revoked connection because revocation is terminal", async () => {
    queue("trip_agent_connections", { data: { ...connection, status: "revoked" }, error: null });

    const response = await DELETE(request("DELETE"), { params });

    expect(response.status).toBe(409);
    expect(writes()).toHaveLength(0);
  });
});

describe("trip-agent connection database failures", () => {
  it.each([
    ["GET", GET, undefined],
    ["POST", POST, { provider: "openclaw" }],
    ["PATCH", PATCH, { action: "pause" }],
    ["DELETE", DELETE, undefined],
  ] as const)("returns 500 when %s cannot read the connection", async (method, handler, body) => {
    queue("trip_agent_connections", { data: null, error: { message: "database unavailable" } });
    const response = await handler(request(method, body), { params });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not manage trip agent connection" });
  });

  it("returns 500 rather than a stale-write conflict when a lifecycle update errors", async () => {
    queue(
      "trip_agent_connections",
      { data: { ...connection, status: "active" }, error: null },
      { data: null, error: { message: "database unavailable" } },
    );

    const response = await PATCH(request("PATCH", { action: "pause" }), { params });

    expect(response.status).toBe(500);
  });
});
