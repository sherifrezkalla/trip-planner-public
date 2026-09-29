import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
vi.mock("server-only", () => ({}));
const mocks = vi.hoisted(() => ({ serviceClient: vi.fn() }));
vi.mock("@/lib/db", () => mocks);
import { POST } from "@/app/api/trips/[slug]/agent-actions/[actionId]/confirm/route";
import { previewTripChange, commitTripChange } from "@/lib/trip-agent-change-service";
import { actionWorld, envelope, ids, now } from "@/lib/__tests__/helpers/trip-agent-action-db";

beforeEach(() => { vi.stubEnv("TRIP_AGENT_IDENTITY_PEPPER", "test-secret"); vi.clearAllMocks(); });
afterEach(() => vi.unstubAllEnvs());
async function fixture() {
  const w = actionWorld(); mocks.serviceClient.mockReturnValue(w.context.db);
  Object.assign(w.rows.trips[0], { slug: "trip" });
  Object.assign(w.rows.travelers[0], { token: "private-token" });
  const change = { ...envelope, kind: "reservation_prepare", itemId: ids.item, partySize: 4, requestedAt: now.toISOString() };
  await previewTripChange(w.context, change, { now: () => now });
  await commitTripChange(w.context, { actionId: ids.action, externalGroupId: envelope.externalGroupId, externalParticipantId: envelope.externalParticipantId }, { now: () => now });
  w.rows.trip_agent_actions[0].confirmation_expires_at = new Date(Date.now() + 900_000).toISOString();
  const safe = { action: { id: ids.action, status: "succeeded" }, attempt: { id: ids.request, state: "awaiting_approval" }, item: { id: ids.item, venueName: "Museum" } };
  w.rpc.mockReset();
  w.rpc.mockResolvedValue({ data: { ...safe, normalized_request: "PRIVATE", credential_digest: "PRIVATE", attempt: { ...safe.attempt, contact_email: "PRIVATE", proof: "PRIVATE" } }, error: null });
  const call = (body: unknown = { decision: "confirm" }, token: string | null = "private-token", slug = "trip") => POST(new Request("https://trip.test/confirm?token=private-token", {
    method: "POST", headers: { "content-type": "application/json", ...(token === null ? {} : { "x-trip-token": token }) }, body: JSON.stringify(body),
  }), { params: Promise.resolve({ slug, actionId: ids.action }) });
  return { ...w, safe, call };
}
describe("private trip-agent confirmation", () => {
  it("uses strict header authentication and an explicit safe organizer response", async () => {
    const w = await fixture(); const response = await w.call();
    expect(response.status).toBe(200); expect(await response.json()).toEqual(w.safe);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(w.rpc).toHaveBeenCalledWith("confirm_trip_agent_action", expect.objectContaining({ p_trip_id: ids.trip, p_actor_id: ids.actor, p_action_id: ids.action, p_decision: "confirm", p_expected_state: expect.objectContaining({ privateReservation: expect.objectContaining({ organizerName: "Private Organizer" }) }) }));
  });
  it.each([null, "wrong"])("rejects absent/invalid header %s even with query token", async token => {
    const w = await fixture(); expect((await w.call(undefined, token)).status).toBe(401); expect(w.rpc).not.toHaveBeenCalled();
  });
  it.each(["traveler", "bot"])("denies a %s before reading private action state", async role => {
    const w = await fixture(); Object.assign(w.rows.travelers[0], role === "bot" ? { is_bot: true } : { is_organizer: false });
    expect((await w.call()).status).toBe(403); expect(w.rpc).not.toHaveBeenCalled();
  });
  it.each([{ decision: "approve" }, { decision: "confirm", contactEmail: "private@test.test" }, { decision: "reject", token: "x" }])("rejects extra or invalid body fields", async body => {
    const w = await fixture(); expect((await w.call(body)).status).toBe(400); expect(w.rpc).not.toHaveBeenCalled();
  });
  it("cannot resolve an action from another trip", async () => {
    const w = await fixture(); w.rows.trip_agent_actions[0].trip_id = "other";
    expect((await w.call()).status).toBe(404); expect(w.rpc).not.toHaveBeenCalled();
  });
  it("cannot resolve an action id retained from a prior connector lifecycle", async () => {
    const w = await fixture();
    w.rows.trip_agent_connections[0].lifecycle_generation = 2;

    expect((await w.call()).status).toBe(404);
    expect(w.rpc).not.toHaveBeenCalled();
  });
  it.each(["confirmation_used", "confirmation_expired", "reservation_attempt_active", "booking_route_unavailable", "plan_changed"])("returns a safe stable %s conflict", async code => {
    const w = await fixture(); w.rpc.mockResolvedValue({ data: { code, message: "PRIVATE" }, error: null });
    const result = await w.call(); expect(result.status).toBe(409); expect(await result.json()).toEqual({ error: { code } });
  });
  it("rejects without requiring an available venue route", async () => {
    const w = await fixture(); w.rows.venue_candidates = [];
    w.rpc.mockResolvedValue({ data: { action: { id: ids.action, status: "rejected" } }, error: null });
    expect((await w.call({ decision: "reject" })).status).toBe(200);
    expect(w.rpc).toHaveBeenCalledWith("confirm_trip_agent_action", expect.objectContaining({ p_decision: "reject", p_expected_state: null }));
  });
  it("recovers a lost successful internal database response by rereading the durable action", async () => {
    const w = await fixture(); w.rpc.mockImplementation(async () => {
      Object.assign(w.rows.trip_agent_actions[0], { status: "succeeded", result: w.safe });
      return { data: null, error: { message: "PRIVATE transport detail" } };
    });
    const response = await w.call(); expect(response.status).toBe(200); expect(await response.json()).toEqual(w.safe);
    expect(w.rows.trip_agent_actions[0].status).toBe("succeeded"); expect(w.rpc).toHaveBeenCalledOnce();
  });
  it("does not mark internal uncertainty unknown or retry an existing unknown action", async () => {
    const w = await fixture(); w.rpc.mockRejectedValue(new Error("PRIVATE"));
    const response = await w.call(); expect(response.status).toBe(503); expect(await response.json()).toEqual({error:{code:"database_unavailable"}});
    expect(w.rows.trip_agent_actions[0].status).toBe("awaiting_confirmation");
    w.rows.trip_agent_actions[0].status = "unknown"; w.rpc.mockClear();
    expect((await w.call()).status).toBe(409); expect(w.rpc).not.toHaveBeenCalled();
  });
});
