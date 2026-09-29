import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authTraveler: vi.fn(),
  updateReservation: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ authTraveler: mocks.authTraveler }));
vi.mock("@/lib/db", () => ({ serviceClient: () => ({ rpc: vi.fn() }) }));
vi.mock("@/lib/persistence", () => ({ updateItineraryReservation: mocks.updateReservation }));
vi.mock("@/lib/realtime", () => ({ broadcastTripUpdate: mocks.broadcast }));

import { PATCH } from "@/app/api/items/[id]/reservation/route";

const payload = {
  token: "secret",
  slug: "summer",
  status: "confirmed",
  reservationAt: "2026-08-20T17:30:00.000Z",
  confirmationNumber: "ABC-123",
  bookingUrl: "https://booking.example/123",
  cancellationDeadline: "2026-08-18T17:30:00.000Z",
};

describe("reservation API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authTraveler.mockResolvedValue({
      trip: { id: "trip-1" },
      me: { id: "traveler-1", is_organizer: true },
    });
    mocks.updateReservation.mockResolvedValue(undefined);
    mocks.broadcast.mockResolvedValue(undefined);
  });

  it("lets the organizer save a confirmed reservation atomically", async () => {
    const response = await PATCH(new Request("http://test", {
      method: "PATCH",
      body: JSON.stringify(payload),
    }), { params: Promise.resolve({ id: "item-1" }) });

    expect(response.status).toBe(200);
    expect(mocks.updateReservation).toHaveBeenCalledWith(expect.anything(), {
      tripId: "trip-1",
      actorId: "traveler-1",
      itemId: "item-1",
      status: "confirmed",
      reservationAt: payload.reservationAt,
      confirmationNumber: "ABC-123",
      bookingUrl: "https://booking.example/123",
      cancellationDeadline: payload.cancellationDeadline,
      detailsSource: "organizer",
      organizerVerified: false,
    });
    expect(mocks.broadcast).toHaveBeenCalledWith("summer");
  });

  it("keeps reservation changes organizer-only", async () => {
    mocks.authTraveler.mockResolvedValue({
      trip: { id: "trip-1" },
      me: { id: "traveler-2", is_organizer: false },
    });
    const response = await PATCH(new Request("http://test", {
      method: "PATCH",
      body: JSON.stringify(payload),
    }), { params: Promise.resolve({ id: "item-1" }) });

    expect(response.status).toBe(403);
    expect(mocks.updateReservation).not.toHaveBeenCalled();
  });

  it("rejects a confirmed reservation without a date and time", async () => {
    const response = await PATCH(new Request("http://test", {
      method: "PATCH",
      body: JSON.stringify({ ...payload, reservationAt: null }),
    }), { params: Promise.resolve({ id: "item-1" }) });

    expect(response.status).toBe(400);
    expect(mocks.updateReservation).not.toHaveBeenCalled();
  });

  it("requires a confirmation reference or explicit organizer verification", async () => {
    const ungrounded = await PATCH(new Request("http://test", {
      method: "PATCH",
      body: JSON.stringify({ ...payload, confirmationNumber: null }),
    }), { params: Promise.resolve({ id: "item-1" }) });
    expect(ungrounded.status).toBe(400);

    const verified = await PATCH(new Request("http://test", {
      method: "PATCH",
      body: JSON.stringify({ ...payload, confirmationNumber: null, organizerVerified: true, detailsSource: "artifact" }),
    }), { params: Promise.resolve({ id: "item-1" }) });
    expect(verified.status).toBe(200);
    expect(mocks.updateReservation).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({
      detailsSource: "artifact",
      organizerVerified: true,
      confirmationNumber: null,
    }));
  });
});
