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
  }>,
  results: new Map<string, Array<{ data: unknown; error: unknown }>>(),
  rpc: vi.fn(),
  rpcCalls: [] as Array<{ name: string; args: unknown }>,
  rpcResults: [] as Array<{ data: unknown; error: unknown }>,
}));

vi.mock("@/lib/db", () => ({ serviceClient: () => mocks.client() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, authTraveler: mocks.authTraveler };
});

import { TRIP_TOKEN_HEADER } from "@/lib/auth";
import { PATCH } from "@/app/api/trips/[slug]/agent-participants/[mappingId]/route";

type DbResult = { data: unknown; error: unknown };

const params = Promise.resolve({ slug: "summer", mappingId: "mapping-1" });
const auth = {
  trip: { id: "trip-1", slug: "summer" },
  me: { id: "organizer-1", is_organizer: true, is_bot: false },
};
const suggested = {
  id: "mapping-1",
  connection_id: "connection-1",
  trip_id: "trip-1",
  lifecycle_generation: 1,
  display_name_hint: "Sam",
  traveler_id: null,
  status: "suggested",
  confirmed_by: null,
  confirmed_at: null,
  revoked_at: null,
  created_at: "2026-09-01T09:00:00.000Z",
  updated_at: "2026-09-01T09:00:00.000Z",
};

function queue(table: string, ...queued: DbResult[]) {
  mocks.results.set(table, [...(mocks.results.get(table) ?? []), ...queued]);
}

function queueMapping(data: unknown, error: unknown = null) {
  queue("trip_agent_connections", { data: { id: "connection-1", lifecycle_generation: 1 }, error: null });
  queue("trip_agent_participant_mappings", { data, error });
}

function next(table: string): DbResult {
  return mocks.results.get(table)?.shift() ?? { data: null, error: null };
}

function queueRpc(...queued: DbResult[]) {
  mocks.rpcResults.push(...queued);
}

function query(table: string) {
  const record = { table, operation: "read", filters: [] as Array<[string, unknown]> } as (typeof mocks.interactions)[number];
  mocks.interactions.push(record);
  const builder: Record<string, unknown> = {};
  builder.select = (projection: string) => {
    record.projection = projection;
    return builder;
  };
  builder.update = (payload: unknown) => {
    record.operation = "update";
    record.payload = payload;
    return builder;
  };
  builder.insert = (payload: unknown) => {
    record.operation = "insert";
    record.payload = payload;
    return builder;
  };
  builder.eq = (column: string, value: unknown) => {
    record.filters.push([column, value]);
    return builder;
  };
  builder.maybeSingle = () => Promise.resolve(next(table));
  builder.then = (resolve: (value: DbResult) => unknown, reject?: (reason: unknown) => unknown) =>
    Promise.resolve(next(table)).then(resolve, reject);
  return builder;
}

function request(body: unknown, token = "organizer-token", queryOnly = false) {
  const url = `https://trip-planner.test/api/trips/summer/agent-participants/mapping-1${queryOnly ? `?token=${token}` : ""}`;
  return new Request(url, {
    method: "PATCH",
    headers: { ...(queryOnly ? {} : { [TRIP_TOKEN_HEADER]: token }), "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function writes(table: string) {
  return mocks.interactions.filter((item) => item.table === table && item.operation !== "read");
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.interactions.length = 0;
  mocks.results.clear();
  mocks.rpcCalls.length = 0;
  mocks.rpcResults.length = 0;
  mocks.rpc.mockImplementation((name: string, args: unknown) => {
    mocks.rpcCalls.push({ name, args });
    return Promise.resolve(mocks.rpcResults.shift() ?? { data: null, error: null });
  });
  mocks.client.mockImplementation(() => ({ from: query, rpc: mocks.rpc }));
  mocks.authTraveler.mockResolvedValue(auth);
});

describe("PATCH /api/trips/[slug]/agent-participants/[mappingId]", () => {
  it("keeps every mapping transition organizer-only", async () => {
    mocks.authTraveler.mockResolvedValue({ ...auth, me: { ...auth.me, is_organizer: false } });

    const response = await PATCH(request({ action: "confirm", travelerId: "traveler-1" }), { params });

    expect(response.status).toBe(403);
    expect(mocks.authTraveler).toHaveBeenCalledWith(expect.anything(), "summer", "organizer-token");
    expect(writes("trip_agent_participant_mappings")).toHaveLength(0);
  });

  it("authenticates before revealing whether a mapping payload is valid", async () => {
    mocks.authTraveler.mockResolvedValue({ ...auth, me: { ...auth.me, is_organizer: false } });

    const response = await PATCH(request({ action: "not-a-real-action" }), { params });

    expect(response.status).toBe(403);
  });

  it("rejects query-only organizer authentication", async () => {
    mocks.authTraveler.mockResolvedValue({ status: 401, error: "Invalid traveler token" });

    const response = await PATCH(request({ action: "revoke" }, "organizer-token", true), { params });

    expect(response.status).toBe(401);
    expect(mocks.authTraveler).toHaveBeenCalledWith(expect.anything(), "summer", "");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("denies a malformed bot organizer before reading a mapping", async () => {
    mocks.authTraveler.mockResolvedValue({ ...auth, me: { ...auth.me, is_bot: true } });

    const response = await PATCH(request({ action: "revoke" }), { params });

    expect(response.status).toBe(403);
    expect(mocks.interactions).toHaveLength(0);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("accepts only strict confirm, remap, and revoke payloads", async () => {
    for (const body of [
      { action: "approve", travelerId: "traveler-1" },
      { action: "confirm" },
      { action: "revoke", travelerId: "traveler-1" },
      { action: "confirm", travelerId: "traveler-1", extra: true },
    ]) {
      const response = await PATCH(request(body), { params });
      expect(response.status).toBe(400);
    }
    expect(mocks.interactions).toHaveLength(0);
  });

  it("confirms a same-trip traveler and records an identifiers-only event", async () => {
    const confirmed = {
      ...suggested,
      traveler_id: "traveler-1",
      status: "confirmed",
      confirmed_by: "organizer-1",
      confirmed_at: "2026-09-04T12:00:00.000Z",
    };
    queueMapping(suggested);
    queue("travelers", { data: { id: "traveler-1", trip_id: "trip-1", is_bot: false }, error: null });
    queueRpc({ data: [confirmed], error: null });

    const response = await PATCH(request({ action: "confirm", travelerId: "traveler-1" }), { params });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.rpcCalls).toEqual([{
      name: "transition_trip_agent_participant_mapping",
      args: {
        p_connection_id: "connection-1",
        p_trip_id: "trip-1",
        p_lifecycle_generation: 1,
        p_mapping_id: "mapping-1",
        p_actor_id: "organizer-1",
        p_action: "confirm",
        p_traveler_id: "traveler-1",
        p_expected_updated_at: suggested.updated_at,
        p_expected_status: "suggested",
        p_expected_traveler_id: null,
        p_now: expect.any(String),
      },
    }]);
    expect(writes("trip_agent_participant_mappings")).toHaveLength(0);
    expect(writes("trip_events")).toHaveLength(0);
    expect(body).toEqual({ mapping: expect.objectContaining({ id: "mapping-1", travelerId: "traveler-1", status: "confirmed" }) });
  });

  it("refuses a traveler outside this trip before changing the mapping", async () => {
    queueMapping(suggested);
    queue("travelers", { data: null, error: null });

    const response = await PATCH(request({ action: "confirm", travelerId: "other-trip-traveler" }), { params });

    expect(response.status).toBe(400);
    expect(writes("trip_agent_participant_mappings")).toHaveLength(0);
    const travelerRead = mocks.interactions.find((item) => item.table === "travelers");
    expect(travelerRead?.filters).toContainEqual(["trip_id", "trip-1"]);
  });

  it("returns a conflict when another mapping already confirms that traveler", async () => {
    queueMapping(suggested);
    queue("travelers", { data: { id: "traveler-1", trip_id: "trip-1", is_bot: false }, error: null });
    queueRpc({ data: null, error: { code: "23505", message: "confirmed traveler unique" } });

    const response = await PATCH(request({ action: "confirm", travelerId: "traveler-1" }), { params });

    expect(response.status).toBe(409);
    expect(writes("trip_events")).toHaveLength(0);
  });

  it("requires the explicit remap action to change a confirmed mapping", async () => {
    queueMapping({ ...suggested, traveler_id: "traveler-1", status: "confirmed" });

    const response = await PATCH(request({ action: "confirm", travelerId: "traveler-2" }), { params });

    expect(response.status).toBe(409);
    expect(writes("trip_agent_participant_mappings")).toHaveLength(0);
  });

  it("remaps a confirmed participant and records both traveler identifiers", async () => {
    const current = { ...suggested, traveler_id: "traveler-1", status: "confirmed" };
    const changed = { ...current, traveler_id: "traveler-2" };
    queueMapping(current);
    queue("travelers", { data: { id: "traveler-2", trip_id: "trip-1", is_bot: true }, error: null });
    queueRpc({ data: [changed], error: null });

    const response = await PATCH(request({ action: "remap", travelerId: "traveler-2" }), { params });

    expect(response.status).toBe(200);
    expect(mocks.rpcCalls[0]).toMatchObject({
      name: "transition_trip_agent_participant_mapping",
      args: {
        p_action: "remap",
        p_traveler_id: "traveler-2",
        p_expected_status: "confirmed",
        p_expected_traveler_id: "traveler-1",
        p_expected_updated_at: suggested.updated_at,
      },
    });
  });

  it("revokes the mapping and records no provider identity", async () => {
    const current = {
      ...suggested,
      external_participant_digest: "secret-provider-digest",
      traveler_id: "traveler-1",
      status: "confirmed",
    };
    queueMapping(current);
    queueRpc({
      data: [{ ...current, status: "revoked", revoked_at: "2026-09-04T12:00:00.000Z" }],
      error: null,
    });

    const response = await PATCH(request({ action: "revoke" }), { params });
    const serialized = JSON.stringify(await response.json());

    expect(response.status).toBe(200);
    expect(mocks.rpcCalls[0]).toMatchObject({
      name: "transition_trip_agent_participant_mapping",
      args: {
        p_action: "revoke",
        p_traveler_id: null,
        p_expected_status: "confirmed",
        p_expected_traveler_id: "traveler-1",
        p_expected_updated_at: suggested.updated_at,
      },
    });
    expect(serialized).not.toContain("secret-provider-digest");
    expect(mocks.interactions.find((item) => item.table === "trip_agent_participant_mappings")?.projection)
      .not.toContain("external_participant_digest");
  });

  it("returns a conflict when the mapping CAS loses a concurrent transition", async () => {
    queueMapping(suggested);
    queue("travelers", { data: { id: "traveler-1", trip_id: "trip-1", is_bot: false }, error: null });
    queueRpc({ data: [], error: null });

    const response = await PATCH(request({ action: "confirm", travelerId: "traveler-1" }), { params });

    expect(response.status).toBe(409);
    expect(writes("trip_events")).toHaveLength(0);
  });

  it("returns 500 when the transactional mapping or audit RPC fails", async () => {
    queueMapping(suggested);
    queue("travelers", { data: { id: "traveler-1", trip_id: "trip-1", is_bot: false }, error: null });
    queueRpc({ data: null, error: { code: "P0001", message: "mapping audit refused" } });

    const response = await PATCH(request({ action: "confirm", travelerId: "traveler-1" }), { params });

    expect(response.status).toBe(500);
    expect(writes("trip_agent_participant_mappings")).toHaveLength(0);
    expect(writes("trip_events")).toHaveLength(0);
  });

  it("does not allow a prior-generation mapping id to cross a replacement boundary", async () => {
    queue("trip_agent_connections", { data: { id: "connection-1", lifecycle_generation: 2 }, error: null });
    queue("trip_agent_participant_mappings", { data: null, error: null });

    const response = await PATCH(request({ action: "revoke" }), { params });

    expect(response.status).toBe(404);
    const mappingRead = mocks.interactions.find((item) => item.table === "trip_agent_participant_mappings");
    expect(mappingRead?.filters).toContainEqual(["lifecycle_generation", 2]);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("returns no-store on a successful redacted mapping response", async () => {
    queueMapping(suggested);
    queue("travelers", { data: { id: "traveler-1", trip_id: "trip-1", is_bot: false }, error: null });
    queueRpc({ data: [{ ...suggested, traveler_id: "traveler-1", status: "confirmed" }], error: null });

    const response = await PATCH(request({ action: "confirm", travelerId: "traveler-1" }), { params });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
