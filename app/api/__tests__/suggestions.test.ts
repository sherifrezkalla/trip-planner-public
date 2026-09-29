import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authTraveler: vi.fn(),
  insert: vi.fn(),
  readSingle: vi.fn(),
  deleteResult: vi.fn(),
  broadcast: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ authTraveler: mocks.authTraveler }));
vi.mock("@/lib/realtime", () => ({ broadcastTripUpdate: mocks.broadcast }));
vi.mock("@/lib/db", () => ({
  serviceClient: () => ({
    from: () => ({
      insert: mocks.insert,
      select: () => ({
        eq: () => ({ eq: () => ({ single: mocks.readSingle }) }),
      }),
      delete: () => ({
        eq: () => ({ eq: mocks.deleteResult }),
      }),
    }),
  }),
}));

import { POST } from "@/app/api/trips/[slug]/suggestions/route";
import { DELETE } from "@/app/api/trips/[slug]/suggestions/[suggestionId]/route";

const auth = {
  trip: { id: "trip-1" },
  me: { id: "traveler-1", is_organizer: false },
};

describe("trip suggestions API", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.authTraveler.mockResolvedValue(auth);
    mocks.insert.mockResolvedValue({ error: null });
    mocks.readSingle.mockResolvedValue({
      data: { id: "suggestion-1", traveler_id: "traveler-1" },
      error: null,
    });
    mocks.deleteResult.mockResolvedValue({ error: null });
    mocks.broadcast.mockResolvedValue(undefined);
  });

  it("saves a trimmed suggestion under the authenticated member", async () => {
    const res = await POST(new Request("http://test", {
      method: "POST",
      body: JSON.stringify({ token: "secret", text: "  Visit the Blue Eye  " }),
    }), { params: Promise.resolve({ slug: "summer" }) });

    expect(res.status).toBe(201);
    expect(mocks.insert).toHaveBeenCalledWith({
      trip_id: "trip-1",
      traveler_id: "traveler-1",
      text: "Visit the Blue Eye",
    });
    expect(mocks.broadcast).toHaveBeenCalledWith("summer");
  });

  it("rejects a blank suggestion before writing", async () => {
    const res = await POST(new Request("http://test", {
      method: "POST",
      body: JSON.stringify({ token: "secret", text: "   " }),
    }), { params: Promise.resolve({ slug: "summer" }) });

    expect(res.status).toBe(400);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("lets a member remove their own suggestion", async () => {
    const res = await DELETE(new Request("http://test", {
      method: "DELETE",
      body: JSON.stringify({ token: "secret" }),
    }), { params: Promise.resolve({ slug: "summer", suggestionId: "suggestion-1" }) });

    expect(res.status).toBe(200);
    expect(mocks.deleteResult).toHaveBeenCalledWith("trip_id", "trip-1");
    expect(mocks.broadcast).toHaveBeenCalledWith("summer");
  });
});
