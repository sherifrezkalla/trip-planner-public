import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authTraveler: vi.fn(),
  readSingle: vi.fn(),
  update: vi.fn(),
  updateResult: { error: null as { code?: string; message: string } | null },
  itineraryResult: { data: [] as object[], error: null as { message: string } | null },
  applyReshuffle: vi.fn(),
  applyPartialDay: vi.fn(),
  broadcast: vi.fn(),
  trackEvent: vi.fn(),
}));

function thenableQuery(result: () => object) {
  const query = {
    eq: () => query,
    order: () => query,
    single: mocks.readSingle,
    then: (resolve: (value: object) => unknown) => Promise.resolve(result()).then(resolve),
  };
  return query;
}

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, authTraveler: mocks.authTraveler };
});
vi.mock("@/lib/realtime", () => ({ broadcastTripUpdate: mocks.broadcast }));
vi.mock("@/lib/instrumentation", () => ({ trackEvent: mocks.trackEvent }));
vi.mock("@/lib/persistence", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/persistence")>();
  return {
    ...actual,
    applyItineraryReshuffle: mocks.applyReshuffle,
    applyPartialDayReplan: mocks.applyPartialDay,
  };
});
vi.mock("@/lib/db", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => thenableQuery(() => mocks.itineraryResult),
      update: (updates: object) => {
        mocks.update(updates);
        return thenableQuery(() => mocks.updateResult);
      },
    }),
  }),
}));

import { PATCH as updateStatus } from "@/app/api/items/[id]/status/route";
import { POST as reshuffle } from "@/app/api/trips/[slug]/reshuffle/route";

const auth = {
  trip: { id: "trip-1", start_date: "2026-08-07", end_date: "2026-08-19" },
  me: { id: "traveler-1", is_organizer: true },
};

describe("itinerary progress API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authTraveler.mockResolvedValue(auth);
    mocks.readSingle.mockResolvedValue({
      data: {
        id: "item-1",
        day_index: 6,
        status: "planned",
        reservation_status: "none",
        adjust_today_revision_id: null,
      },
      error: null,
    });
    mocks.updateResult = { error: null };
    mocks.itineraryResult = { data: [], error: null };
    mocks.applyReshuffle.mockResolvedValue(undefined);
    mocks.applyPartialDay.mockResolvedValue(undefined);
    mocks.broadcast.mockResolvedValue(undefined);
  });

  it("records an early completion on the actual trip day", async () => {
    const response = await updateStatus(new Request("http://test", {
      method: "PATCH",
      body: JSON.stringify({
        token: "secret",
        slug: "example-region",
        action: "status",
        status: "done",
        completedDayIndex: 2,
      }),
    }), { params: Promise.resolve({ id: "item-1" }) });

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      status: "done",
      completed_day_index: 2,
      state_changed_by: "traveler-1",
      is_locked: false,
    }));
    expect(mocks.broadcast).toHaveBeenCalledWith("example-region");
    expect(mocks.trackEvent).not.toHaveBeenCalled();
  });

  it("attributes the first follow-through action to its accepted adjust-today revision", async () => {
    mocks.readSingle.mockResolvedValue({
      data: {
        id: "item-1",
        day_index: 6,
        status: "planned",
        reservation_status: "none",
        adjust_today_revision_id: "revision-1",
      },
      error: null,
    });

    const response = await updateStatus(new Request("http://test", {
      method: "PATCH",
      body: JSON.stringify({
        token: "secret",
        slug: "example-region",
        action: "status",
        status: "done",
        completedDayIndex: 2,
      }),
    }), { params: Promise.resolve({ id: "item-1" }) });

    expect(response.status).toBe(200);
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      adjust_today_revision_id: null,
    }));
    expect(mocks.trackEvent).toHaveBeenCalledWith(expect.anything(), {
      tripId: "trip-1",
      actorId: "traveler-1",
      kind: "activity_done_after_adjust",
      detail: { itemId: "item-1", status: "done", revisionId: "revision-1" },
    });
  });

  it("keeps booking locks organizer-only", async () => {
    mocks.authTraveler.mockResolvedValue({ ...auth, me: { id: "traveler-2", is_organizer: false } });
    const response = await updateStatus(new Request("http://test", {
      method: "PATCH",
      body: JSON.stringify({ token: "secret", slug: "example-region", action: "lock", isLocked: true }),
    }), { params: Promise.resolve({ id: "item-1" }) });

    expect(response.status).toBe(403);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("does not unlock or skip an active reservation", async () => {
    mocks.readSingle.mockResolvedValue({
      data: { id: "item-1", day_index: 2, status: "planned", reservation_status: "confirmed" },
      error: null,
    });

    const unlock = await updateStatus(new Request("http://test", {
      method: "PATCH",
      body: JSON.stringify({ token: "secret", slug: "example-region", action: "lock", isLocked: false }),
    }), { params: Promise.resolve({ id: "item-1" }) });
    const skip = await updateStatus(new Request("http://test", {
      method: "PATCH",
      body: JSON.stringify({ token: "secret", slug: "example-region", action: "status", status: "skipped" }),
    }), { params: Promise.resolve({ id: "item-1" }) });

    expect(unlock.status).toBe(409);
    expect(skip.status).toBe(409);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("previews the Day 7 to today displacement without writing", async () => {
    mocks.itineraryResult = {
      data: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          day_index: 6,
          block: "afternoon",
          status: "done",
          is_locked: false,
          completed_day_index: 2,
          venue_candidates: { name: "Boat trip" },
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          day_index: 2,
          block: "afternoon",
          status: "planned",
          is_locked: false,
          completed_day_index: null,
          venue_candidates: { name: "Museum" },
        },
      ],
      error: null,
    };
    const response = await reshuffle(new Request("http://test", {
      method: "POST",
      body: JSON.stringify({ token: "secret", action: "preview", currentDayIndex: 2 }),
    }), { params: Promise.resolve({ slug: "example-region" }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.moves).toEqual([expect.objectContaining({
      venueName: "Museum",
      fromDayIndex: 2,
      toDayIndex: 6,
    })]);
    expect(mocks.applyReshuffle).not.toHaveBeenCalled();
  });

  it("previews a running-late repair using votes and regular opening hours", async () => {
    mocks.itineraryResult = {
      data: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          day_index: 2,
          block: "morning",
          position: 0,
          duration_min: 60,
          status: "planned",
          is_locked: false,
          completed_day_index: null,
          venue_candidates: {
            name: "Popular museum",
            opening_periods: [{ open: { day: 0, hour: 0, minute: 0 } }],
          },
          votes: [{ value: 1 }, { value: 1 }],
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          day_index: 2,
          block: "afternoon",
          position: 1,
          duration_min: 60,
          status: "planned",
          is_locked: false,
          completed_day_index: null,
          venue_candidates: {
            name: "Quiet park",
            opening_periods: [{ open: { day: 0, hour: 0, minute: 0 } }],
          },
          votes: [{ value: -1 }],
        },
        {
          id: "33333333-3333-4333-8333-333333333333",
          day_index: 2,
          block: "evening",
          position: 2,
          duration_min: 90,
          status: "planned",
          is_locked: true,
          completed_day_index: null,
          venue_candidates: {
            name: "Booked show",
            opening_periods: [{ open: { day: 0, hour: 0, minute: 0 } }],
          },
          votes: [],
        },
      ],
      error: null,
    };
    const response = await reshuffle(new Request("http://test", {
      method: "POST",
      body: JSON.stringify({
        token: "secret",
        action: "preview-partial-day",
        currentDayIndex: 2,
        currentBlock: "afternoon",
      }),
    }), { params: Promise.resolve({ slug: "example-region" }) });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.kind).toBe("partial-day");
    expect(body.moves).toEqual([expect.objectContaining({
      itemId: "11111111-1111-4111-8111-111111111111",
      venueName: "Popular museum",
      toBlock: "afternoon",
    })]);
    expect(body.skips).toEqual([expect.objectContaining({
      itemId: "22222222-2222-4222-8222-222222222222",
      venueName: "Quiet park",
    })]);
    expect(mocks.applyPartialDay).not.toHaveBeenCalled();
  });

  it("applies a reviewed running-late repair atomically", async () => {
    const response = await reshuffle(new Request("http://test", {
      method: "POST",
      body: JSON.stringify({
        token: "secret",
        action: "apply-partial-day",
        dayIndex: 2,
        currentBlock: "afternoon",
        trigger: "running-late",
        moves: [{
          itemId: "11111111-1111-4111-8111-111111111111",
          fromDayIndex: 2,
          fromBlock: "morning",
          toDayIndex: 2,
          toBlock: "afternoon",
        }],
        skips: [{
          itemId: "22222222-2222-4222-8222-222222222222",
          fromDayIndex: 2,
          fromBlock: "afternoon",
        }],
      }),
    }), { params: Promise.resolve({ slug: "example-region" }) });

    expect(response.status).toBe(200);
    expect(mocks.applyPartialDay).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      tripId: "trip-1",
      actorId: "traveler-1",
      dayIndex: 2,
      currentBlock: "afternoon",
      trigger: "running-late",
    }));
    expect(mocks.broadcast).toHaveBeenCalledWith("example-region");
  });

  it("keeps partial-day planning organizer-only", async () => {
    mocks.authTraveler.mockResolvedValue({ ...auth, me: { id: "traveler-2", is_organizer: false } });
    const response = await reshuffle(new Request("http://test", {
      method: "POST",
      body: JSON.stringify({
        token: "secret",
        action: "preview-partial-day",
        currentDayIndex: 2,
        currentBlock: "afternoon",
      }),
    }), { params: Promise.resolve({ slug: "example-region" }) });

    expect(response.status).toBe(403);
    expect(mocks.applyPartialDay).not.toHaveBeenCalled();
  });
});
