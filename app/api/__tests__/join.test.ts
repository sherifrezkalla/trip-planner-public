import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  single: vi.fn(),
  rpc: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  serviceClient: () => ({
    from: () => ({
      select: () => ({
        eq: () => ({ single: mocks.single }),
      }),
    }),
    rpc: mocks.rpc,
  }),
}));

vi.mock("@/lib/realtime", () => ({ broadcastTripUpdate: mocks.broadcast }));

import { POST } from "@/app/api/trips/[slug]/join/route";

const payload = {
  displayName: "Alex",
  interests: ["food"],
  pace: "balanced",
  dietary: "none",
  constraintsNote: "",
};

function request() {
  return new Request("http://test/api/trips/abc/join", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

describe("POST /api/trips/[slug]/join", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.single.mockResolvedValue({ data: { id: "trip-1" }, error: null });
    mocks.rpc.mockResolvedValue({
      data: [{ traveler_id: "traveler-1", is_organizer: true }],
      error: null,
    });
    mocks.broadcast.mockResolvedValue(undefined);
  });

  it("delegates first-join organizer assignment to one atomic database function", async () => {
    const res = await POST(request(), { params: Promise.resolve({ slug: "abc" }) });
    expect(res.status).toBe(201);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
    expect(mocks.rpc).toHaveBeenCalledWith(
      "join_trip",
      expect.objectContaining({ p_slug: "abc", p_display_name: "Alex" }),
    );
    expect(await res.json()).toMatchObject({ travelerId: "traveler-1", isOrganizer: true });
  });

  it("returns 404 when the database function finds no matching trip", async () => {
    mocks.rpc.mockResolvedValue({ data: [], error: null });
    const res = await POST(request(), { params: Promise.resolve({ slug: "missing" }) });
    expect(res.status).toBe(404);
  });
});
