import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authTraveler: vi.fn(),
  applyReshuffle: vi.fn(),
  broadcast: vi.fn(),
  takeAdjustAttribution: vi.fn(),
  trackEvent: vi.fn(),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, authTraveler: mocks.authTraveler };
});
vi.mock("@/lib/realtime", () => ({ broadcastTripUpdate: mocks.broadcast }));
vi.mock("@/lib/instrumentation", () => ({
  takeAdjustAttribution: mocks.takeAdjustAttribution,
  trackEvent: mocks.trackEvent,
}));
vi.mock("@/lib/persistence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/persistence")>();
  return { ...actual, applyItineraryReshuffle: mocks.applyReshuffle };
});
vi.mock("@/lib/db", () => ({ serviceClient: () => ({}) }));

import { POST as moveItem } from "@/app/api/items/[id]/move/route";

const ITEM_ID = "11111111-1111-4111-8111-111111111111";
const params = Promise.resolve({ id: ITEM_ID });

/** Trip runs 2026-08-07 to 2026-08-19, so dayCount is 13. */
const trip = { id: "trip-1", start_date: "2026-08-07", end_date: "2026-08-19" };

function request(body: Record<string, unknown> = {}) {
  return new Request("http://localhost/api/items/x/move", {
    method: "POST",
    body: JSON.stringify({
      slug: "trip-slug",
      token: "traveler-token",
      fromDayIndex: 2,
      fromBlock: "afternoon",
      toDayIndex: 3,
      toBlock: "morning",
      ...body,
    }),
  });
}

function signedInAs(isOrganizer: boolean) {
  mocks.authTraveler.mockResolvedValue({
    trip,
    me: { id: "traveler-1", is_organizer: isOrganizer },
  });
}

describe("hand-picked activity move", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    mocks.applyReshuffle.mockResolvedValue(undefined);
    mocks.broadcast.mockResolvedValue(undefined);
    mocks.takeAdjustAttribution.mockResolvedValue(null);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("as the organiser", () => {
    beforeEach(() => {
      vi.setSystemTime(new Date(2026, 7, 14, 10, 0, 0));
      signedInAs(true);
    });

    it("moves one activity to a free slot on another day", async () => {
      const res = await moveItem(request(), { params });

      expect(res.status).toBe(200);
      expect(mocks.applyReshuffle).toHaveBeenCalledWith({}, "trip-1", [
        {
          itemId: ITEM_ID,
          fromDayIndex: 2,
          fromBlock: "afternoon",
          toDayIndex: 3,
          toBlock: "morning",
        },
      ]);
      expect(mocks.broadcast).toHaveBeenCalledWith("trip-slug");
      expect(mocks.trackEvent).not.toHaveBeenCalled();
    });

    it("attributes a follow-through move only when the item carries an accepted revision", async () => {
      mocks.takeAdjustAttribution.mockResolvedValue("revision-1");

      const res = await moveItem(request(), { params });

      expect(res.status).toBe(200);
      expect(mocks.takeAdjustAttribution).toHaveBeenCalledWith(expect.anything(), {
        tripId: "trip-1",
        itemId: ITEM_ID,
      });
      expect(mocks.trackEvent).toHaveBeenCalledWith(expect.anything(), {
        tripId: "trip-1",
        actorId: "traveler-1",
        kind: "activity_changed_after_adjust",
        detail: {
          itemId: ITEM_ID,
          fromDayIndex: 2,
          fromBlock: "afternoon",
          toDayIndex: 3,
          toBlock: "morning",
          revisionId: "revision-1",
        },
      });
    });

    it("moves an activity to a different block on the same day", async () => {
      const res = await moveItem(
        request({ toDayIndex: 2, toBlock: "evening" }),
        { params },
      );

      expect(res.status).toBe(200);
      expect(mocks.applyReshuffle.mock.calls[0][2][0]).toMatchObject({
        toDayIndex: 2,
        toBlock: "evening",
      });
    });

    it("refuses a move onto an occupied slot", async () => {
      mocks.applyReshuffle.mockRejectedValue(
        new Error("reshuffle destination is already occupied"),
      );
      const res = await moveItem(request(), { params });

      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: "Something is already in that slot" });
    });

    it("refuses a completed, skipped, or locked activity", async () => {
      mocks.applyReshuffle.mockRejectedValue(
        new Error("reshuffle preview is stale or contains an invalid move"),
      );
      const res = await moveItem(request(), { params });

      expect(res.status).toBe(409);
      expect(mocks.broadcast).not.toHaveBeenCalled();
    });

    it("refuses a destination day beyond the end of the trip", async () => {
      const res = await moveItem(request({ toDayIndex: 13 }), { params });

      expect(res.status).toBe(400);
      expect(mocks.applyReshuffle).not.toHaveBeenCalled();
    });

    it("refuses a move that changes nothing", async () => {
      const res = await moveItem(
        request({ toDayIndex: 2, toBlock: "afternoon" }),
        { params },
      );

      expect(res.status).toBe(400);
      expect(mocks.applyReshuffle).not.toHaveBeenCalled();
    });

    it("rejects a malformed block name", async () => {
      const res = await moveItem(request({ toBlock: "brunch" }), { params });

      expect(res.status).toBe(400);
      expect(mocks.applyReshuffle).not.toHaveBeenCalled();
    });
  });

  describe("as a traveller who is not the organiser", () => {
    beforeEach(() => {
      signedInAs(false);
    });

    it("refuses to write to the shared plan, whatever the trip phase", async () => {
      for (const now of [
        new Date(2026, 7, 1, 10, 0, 0), // before departure
        new Date(2026, 7, 14, 10, 0, 0), // mid-trip
        new Date(2026, 8, 1, 10, 0, 0), // after the trip
      ]) {
        vi.setSystemTime(now);
        const res = await moveItem(request(), { params });

        expect(res.status).toBe(403);
        expect(mocks.applyReshuffle).not.toHaveBeenCalled();
      }
    });
  });
});
