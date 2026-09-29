import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ auth: vi.fn(), rpc: vi.fn(), broadcast: vi.fn() }));
vi.mock("@/lib/db", () => ({ serviceClient: () => ({ rpc: mocks.rpc }) }));
vi.mock("@/lib/auth", () => ({ authTraveler: mocks.auth }));
vi.mock("@/lib/realtime", () => ({ broadcastTripUpdate: mocks.broadcast }));
import { DELETE } from "@/app/api/trips/[slug]/travelers/[travelerId]/route";

const remove = (travelerId = "target") => DELETE(new Request("https://trip.test", {
  method: "DELETE", body: JSON.stringify({ token: "secret" }),
}), { params: Promise.resolve({ slug: "trip", travelerId }) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({ trip: { id: "trip-id" }, me: { id: "organizer", is_organizer: true, is_bot: false } });
  mocks.rpc.mockResolvedValue({ data: "removed", error: null });
  mocks.broadcast.mockResolvedValue(undefined);
});

describe("guarded traveler removal", () => {
  it("uses the transactional removal RPC and broadcasts success", async () => {
    const response = await remove();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({});
    expect(mocks.rpc).toHaveBeenCalledWith("remove_trip_traveler_guarded", {
      p_trip_id: "trip-id", p_actor_id: "organizer", p_target_id: "target",
    });
    expect(mocks.broadcast).toHaveBeenCalledWith("trip");
  });
  it.each([["not_found", 404], ["forbidden", 403], ["self_removal", 400]])("preserves the %s response", async (data, status) => {
    mocks.rpc.mockResolvedValue({ data, error: null });
    expect((await remove()).status).toBe(status);
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
  it("retries a concurrent connection creation with a fresh transaction", async () => {
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { code: "TP009" } });
    expect((await remove()).status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledTimes(2);
  });
  it("bounds connection drift retries and never exposes database details", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "TP009", message: "internal secret" } });
    const response = await remove();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not remove traveller" });
    expect(mocks.rpc).toHaveBeenCalledTimes(3);
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
  it("bounds other database errors without retry", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "40P01", message: "internal secret" } });
    const response = await remove();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not remove traveller" });
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it("bounds a thrown transport failure", async () => {
    mocks.rpc.mockRejectedValue(new Error("private transport details"));
    const response = await remove();
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Could not remove traveller" });
    expect(mocks.broadcast).not.toHaveBeenCalled();
  });
  it("rejects a bot organizer before calling SQL", async () => {
    mocks.auth.mockResolvedValue({ trip: { id: "trip-id" }, me: { id: "organizer", is_organizer: true, is_bot: true } });
    expect((await remove()).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("preserves the self-removal refusal", async () => {
    expect((await remove("organizer")).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
