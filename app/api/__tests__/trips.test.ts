import { describe, it, expect, vi, beforeEach } from "vitest";

const insertMock = vi.fn().mockResolvedValue({ error: null });
// Creating a trip now passes a per-caller ceiling first, and that limiter fails
// closed, so a client without `rpc` refuses every request. See
// app/api/__tests__/trips-create-limit.test.ts for the ceiling's own tests.
const rpcMock = vi.fn().mockResolvedValue({ data: true, error: null });
vi.mock("@/lib/db", () => ({
  serviceClient: () => ({ rpc: rpcMock, from: () => ({ insert: insertMock }) }),
}));

import { POST } from "@/app/api/trips/route";

beforeEach(() => {
  insertMock.mockClear();
  rpcMock.mockClear();
});

describe("POST /api/trips", () => {
  const valid = {
    destinationName: "Lisbon", destinationPlaceId: "ChIJ123", lat: 38.72, lng: -9.14,
    startDate: "2026-09-10", endDate: "2026-09-13", budgetLevel: "mid",
  };

  it("creates a trip and returns a 10-char slug", async () => {
    const res = await POST(new Request("http://test/api/trips", {
      method: "POST", body: JSON.stringify(valid),
    }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.slug).toHaveLength(10);
    expect(insertMock).toHaveBeenCalledOnce();
  });

  it("rejects an invalid payload with 400", async () => {
    const res = await POST(new Request("http://test/api/trips", {
      method: "POST", body: JSON.stringify({ ...valid, endDate: "2026-09-01" }),
    }));
    expect(res.status).toBe(400);
  });
});
