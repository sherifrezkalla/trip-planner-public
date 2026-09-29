import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), insert: vi.fn(), client: vi.fn() }));

vi.mock("@/lib/db", () => ({ serviceClient: () => mocks.client() }));
vi.mock("@/lib/photos", () => ({ fetchPlacePhotoRef: vi.fn(async () => "photo-ref") }));

import { fetchPlacePhotoRef } from "@/lib/photos";
import { POST } from "@/app/api/trips/route";
import { TRIP_CREATE_LIMIT, TRIP_CREATE_WINDOW_SECONDS } from "@/lib/public-request-limit";

const body = {
  title: "Example Coast",
  destinationName: "Example Coast, France",
  destinationPlaceId: "place-example-coast",
  lat: 43.55,
  lng: 7.01,
  startDate: "2026-09-01",
  endDate: "2026-09-07",
  budgetLevel: "mid",
  exploreRadiusKm: 15,
  vibeNote: "",
};

function request(overrides: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
  return new Request("https://trip-planner.test/api/trips", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ ...body, ...overrides }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  mocks.insert.mockResolvedValue({ error: null });
  mocks.client.mockImplementation(() => ({
    rpc: mocks.rpc,
    from: () => ({ insert: mocks.insert }),
  }));
});
afterEach(() => vi.restoreAllMocks());

/**
 * Creating a trip is unauthenticated by design — there is no traveller until the
 * link this returns is opened. It was also uncapped, while fetching a photo from
 * the same billed Places API the destination search proxies. The architecture
 * note described two public routes; this was the third.
 */
describe("POST /api/trips", () => {
  it("creates a trip when the caller is within the ceiling", async () => {
    const response = await POST(request());

    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({ slug: expect.any(String) });
    expect(mocks.insert).toHaveBeenCalledOnce();
  });

  it("counts the caller against a trip-create bucket of its own", async () => {
    await POST(request({}, { "x-forwarded-for": "203.0.113.9" }));

    expect(mocks.rpc).toHaveBeenCalledWith("record_place_lookup", {
      p_client_hash: expect.any(String),
      p_limit: TRIP_CREATE_LIMIT,
      p_window_seconds: TRIP_CREATE_WINDOW_SECONDS,
    });
  });

  it("gives the same caller a different bucket than their destination searches", async () => {
    const { clientHash } = await import("@/lib/public-request-limit");
    const headers = new Headers({ "x-forwarded-for": "203.0.113.9" });

    expect(clientHash(headers, "trip-create")).not.toBe(clientHash(headers, "place-lookup"));
  });

  it("refuses once the caller is over the ceiling, before spending a photo lookup", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe(String(TRIP_CREATE_WINDOW_SECONDS));
    expect(fetchPlacePhotoRef).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  /** A limiter that fails open is not a limiter. */
  it("refuses when the ledger cannot be reached", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "unreachable" } });

    const response = await POST(request());

    expect(response.status).toBe(429);
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("charges no slot for a body that was never going to be accepted", async () => {
    const response = await POST(request({ startDate: "not-a-date" }));

    expect(response.status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
