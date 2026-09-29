import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(), itemEq: vi.fn(), itemTripEq: vi.fn(), itemMaybeSingle: vi.fn(),
  insert: vi.fn(), single: vi.fn(), readSingle: vi.fn(), update: vi.fn(), updateSingle: vi.fn(),
  confirm: vi.fn(), broadcast: vi.fn(),
}));
vi.mock("@/lib/auth", () => ({ authTraveler: mocks.auth }));
vi.mock("@/lib/realtime", () => ({ broadcastTripUpdate: mocks.broadcast }));
vi.mock("@/lib/persistence", () => ({ confirmReservationAttempt: mocks.confirm }));
vi.mock("@/lib/db", () => ({ serviceClient: () => ({
  from: (table: string) => table === "itinerary_items" ? {
    select: () => ({ eq: mocks.itemEq }),
  } : {
    insert: mocks.insert,
    select: () => ({ eq: () => ({ eq: () => ({ single: mocks.readSingle }) }) }),
    update: mocks.update,
  },
}) }));

import { PATCH, POST } from "@/app/api/items/[id]/reservation-assistance/route";

const payload = { token: "secret", slug: "example-coast", partySize: 8, requestedAt: "2026-08-25T18:30:00.000Z",
  bookingName: "Alex", contactEmail: "organizer@example.com", contactPhone: null,
  alternatives: ["2026-08-25T19:00:00.000Z"], routes: ["https://www.thefork.com/r/example"] };
const row = { id: "attempt-1", state: "awaiting_approval", party_size: 8, requested_at: payload.requestedAt,
  booking_name: "Alex", contact_email: payload.contactEmail, contact_phone: null, alternatives: payload.alternatives,
  routes: payload.routes, route_index: 0, route_provider: "thefork", confirmation_reference: null,
  confirmation_url: null, handoff: null, approved_at: null, attempted_at: null, confirmed_at: null };

describe("reservation assistance API", () => {
  beforeEach(() => {
    vi.clearAllMocks(); mocks.auth.mockResolvedValue({ trip: { id: "trip-1" }, me: { id: "organizer-1", is_organizer: true } });
    mocks.itemEq.mockReturnValue({ eq: mocks.itemTripEq });
    mocks.itemTripEq.mockReturnValue({ maybeSingle: mocks.itemMaybeSingle });
    mocks.itemMaybeSingle.mockResolvedValue({ data: { id: "item-1" }, error: null });
    mocks.insert.mockReturnValue({ select: () => ({ single: mocks.single }) });
    mocks.single.mockResolvedValue({ data: row, error: null });
    mocks.broadcast.mockResolvedValue(undefined);
    mocks.readSingle.mockResolvedValue({ data: { ...row, trip_id: "trip-1", itinerary_item_id: "item-1", itinerary_items: { venue_candidates: { name: "Il Terrazzino" } } }, error: null });
    mocks.update.mockReturnValue({ eq: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ select: () => ({ single: mocks.updateSingle }) }) }) }) }) });
    mocks.updateSingle.mockResolvedValue({ data: { ...row, state: "in_progress", approved_at: "2026-08-24T20:00:00.000Z", attempted_at: "2026-08-24T20:00:00.000Z" }, error: null });
    mocks.confirm.mockResolvedValue({ ...row, state: "confirmed", confirmation_reference: "ABC-1" });
  });
  it("prepares but does not submit an organizer request", async () => {
    const response = await POST(new Request("http://test", { method: "POST", body: JSON.stringify(payload) }), { params: Promise.resolve({ id: "item-1" }) });
    expect(response.status).toBe(201);
    expect(mocks.insert).toHaveBeenCalledWith(expect.objectContaining({ contact_email: payload.contactEmail, route_provider: "thefork" }));
    expect((await response.json()).attempt.state).toBe("awaiting_approval");
  });
  it("keeps preparation organizer-only", async () => {
    mocks.auth.mockResolvedValue({ trip: { id: "trip-1" }, me: { id: "traveler-1", is_organizer: false } });
    const response = await POST(new Request("http://test", { method: "POST", body: JSON.stringify(payload) }), { params: Promise.resolve({ id: "item-1" }) });
    expect(response.status).toBe(403); expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("rejects a known itinerary item from another trip before inserting", async () => {
    mocks.itemMaybeSingle.mockResolvedValue({ data: null, error: null });
    const response = await POST(new Request("http://test", { method: "POST", body: JSON.stringify(payload) }), { params: Promise.resolve({ id: "foreign-item" }) });
    expect(response.status).toBe(404);
    expect(mocks.itemEq).toHaveBeenCalledWith("id", "foreign-item");
    expect(mocks.itemTripEq).toHaveBeenCalledWith("trip_id", "trip-1");
    expect(mocks.insert).not.toHaveBeenCalled();
  });
  it("rejects duplicate active attempts", async () => {
    mocks.single.mockResolvedValue({ data: null, error: { code: "23505" } });
    const response = await POST(new Request("http://test", { method: "POST", body: JSON.stringify(payload) }), { params: Promise.resolve({ id: "item-1" }) });
    expect(response.status).toBe(409);
  });
  it("requires a separate organizer approval before opening the route", async () => {
    const response = await PATCH(new Request("http://test", { method: "PATCH", body: JSON.stringify({ token: "secret", slug: "example-coast", action: "approve" }) }), { params: Promise.resolve({ id: "attempt-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ state: "in_progress", approved_at: expect.any(String) }));
    expect((await response.json()).route).toBe(payload.routes[0]);
  });
  it.each([
    ["transition", { action: "approve" }],
    ["confirm", { action: "confirm", confirmationReference: "ABC-1" }],
  ])("does not %s an attempt owned by another trip", async (_label, action) => {
    mocks.readSingle.mockResolvedValue({ data: null, error: { code: "PGRST116" } });
    const response = await PATCH(new Request("http://test", { method: "PATCH", body: JSON.stringify({ token: "secret", slug: "example-coast", ...action }) }), { params: Promise.resolve({ id: "foreign-attempt" }) });
    expect(response.status).toBe(404);
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.confirm).not.toHaveBeenCalled();
  });
  it("advances to the fallback route without duplicating the attempt", async () => {
    const routes = [payload.routes[0], "https://resy.com/cities/example-coast/venues/example"];
    mocks.readSingle.mockResolvedValue({ data: { ...row, state: "in_progress", routes, route_index: 0 }, error: null });
    mocks.updateSingle.mockResolvedValue({ data: { ...row, state: "in_progress", routes, route_index: 1, route_provider: "resy" }, error: null });
    const response = await PATCH(new Request("http://test", { method: "PATCH", body: JSON.stringify({ token: "secret", slug: "example-coast", action: "route_failed" }) }), { params: Promise.resolve({ id: "attempt-1" }) });
    expect(response.status).toBe(200); expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ route_index: 1, route_provider: "resy" }));
    expect((await response.json()).route).toBe(routes[1]);
  });
  it("never accepts confirmation without evidence", async () => {
    const response = await PATCH(new Request("http://test", { method: "PATCH", body: JSON.stringify({ token: "secret", slug: "example-coast", action: "confirm" }) }), { params: Promise.resolve({ id: "attempt-1" }) });
    expect(response.status).toBe(400); expect(mocks.update).not.toHaveBeenCalled();
  });
  it("writes canonical confirmation and the audit row through one database transaction", async () => {
    mocks.readSingle.mockResolvedValue({ data: { ...row, state: "in_progress", itinerary_item_id: "item-1" }, error: null });
    const response = await PATCH(new Request("http://test", { method: "PATCH", body: JSON.stringify({ token: "secret", slug: "example-coast", action: "confirm", confirmationReference: "ABC-1" }) }), { params: Promise.resolve({ id: "attempt-1" }) });
    expect(response.status).toBe(200);
    expect(mocks.confirm).toHaveBeenCalledWith(expect.anything(), {
      tripId: "trip-1", actorId: "organizer-1", attemptId: "attempt-1",
      confirmationReference: "ABC-1", confirmationUrl: null,
    });
    expect(mocks.update).not.toHaveBeenCalled();
  });
  it("ends an active handoff so the organizer can start over", async () => {
    mocks.readSingle.mockResolvedValue({ data: { ...row, state: "handoff", itinerary_item_id: "item-1" }, error: null });
    mocks.updateSingle.mockResolvedValue({ data: { ...row, state: "failed" }, error: null });
    const response = await PATCH(new Request("http://test", { method: "PATCH", body: JSON.stringify({ token: "secret", slug: "example-coast", action: "fail" }) }), { params: Promise.resolve({ id: "attempt-1" }) });
    expect(response.status).toBe(200);
    expect((await response.json()).attempt).toBeNull();
  });
});
