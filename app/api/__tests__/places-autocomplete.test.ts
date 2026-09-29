import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ rpc: vi.fn(), client: vi.fn() }));

vi.mock("@/lib/db", () => ({ serviceClient: () => mocks.client() }));

import { GET } from "@/app/api/places/autocomplete/route";

const HOST = "trip-planner.test";

function request(query: string, headers: Record<string, string> = {}) {
  return new Request(`https://${HOST}/api/places/autocomplete?q=${encodeURIComponent(query)}`, {
    headers,
  });
}

/** A fresh Response per call; a body can only be read once. */
function googleReturns(name: string) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(JSON.stringify({
    places: [{
      id: "place-1",
      displayName: { text: name },
      formattedAddress: "Somewhere",
      location: { latitude: 1, longitude: 2 },
    }],
  }), { status: 200 }));
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.rpc.mockResolvedValue({ data: true, error: null });
  mocks.client.mockImplementation(() => ({ rpc: mocks.rpc }));
});
afterEach(() => vi.restoreAllMocks());

describe("GET /api/places/autocomplete", () => {
  it("serves a same-origin request", async () => {
    googleReturns("Example Coast");
    const response = await GET(request("example-coast", { referer: `https://${HOST}/` }));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      results: [{ placeId: "place-1", name: "Example Coast" }],
    });
  });

  /**
   * The guard used to run only when a header was present, so anything not
   * driven by a browser — curl, a script, a scraper — skipped it entirely and
   * spent the Google key freely.
   */
  it("refuses a request that claims no origin at all", async () => {
    const google = googleReturns("Example Coast");
    const response = await GET(request("example-coast"));

    expect(response.status).toBe(403);
    expect(google).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses another site's origin", async () => {
    const google = googleReturns("Example Coast");
    const response = await GET(request("example-coast", { origin: "https://evil.example.com" }));

    expect(response.status).toBe(403);
    expect(google).not.toHaveBeenCalled();
  });

  it("refuses an unparseable origin", async () => {
    const google = googleReturns("Example Coast");
    const response = await GET(request("example-coast", { origin: "not-a-url" }));

    expect(response.status).toBe(403);
    expect(google).not.toHaveBeenCalled();
  });

  it("spends nothing on a query too short to search", async () => {
    const google = googleReturns("Example Coast");
    const response = await GET(request("c", { referer: `https://${HOST}/` }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ results: [] });
    expect(google).not.toHaveBeenCalled();
    // Not charged against the caller's quota either.
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("stops calling Google once the caller is over their ceiling", async () => {
    mocks.rpc.mockResolvedValue({ data: false, error: null });
    const google = googleReturns("Example Coast");
    const response = await GET(request("example-coast", { referer: `https://${HOST}/` }));

    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("60");
    expect(google).not.toHaveBeenCalled();
  });

  /** A limiter that fails open is not a limiter. */
  it("spends nothing when the ledger cannot be read", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { message: "down" } });
    const google = googleReturns("Example Coast");
    const response = await GET(request("example-coast", { referer: `https://${HOST}/` }));

    expect(response.status).toBe(429);
    expect(google).not.toHaveBeenCalled();
  });

  /**
   * `serviceClient()` throws outright when its environment is missing — which is
   * how preview deployments without Supabase credentials behave. Unhandled, that
   * surfaces as a 500 on the one endpoint a trip cannot be created without.
   */
  it("refuses rather than crashing when the database client cannot be built", async () => {
    mocks.client.mockImplementation(() => {
      throw new Error("supabaseUrl is required.");
    });
    const google = googleReturns("Example Coast");
    const response = await GET(request("example-coast", { referer: `https://${HOST}/` }));

    expect(response.status).toBe(429);
    expect(google).not.toHaveBeenCalled();
  });

  it("counts callers by their forwarded address, not the whole internet at once", async () => {
    googleReturns("Example Coast");
    await GET(request("example-coast", { referer: `https://${HOST}/`, "x-forwarded-for": "203.0.113.9, 10.0.0.1" }));
    await GET(request("example-coast", { referer: `https://${HOST}/`, "x-forwarded-for": "198.51.100.4" }));

    const [first, second] = mocks.rpc.mock.calls;
    expect(first[0]).toBe("record_place_lookup");
    expect(first[1].p_client_hash).not.toBe(second[1].p_client_hash);
    // The address itself is never handed to the database.
    expect(JSON.stringify(mocks.rpc.mock.calls)).not.toContain("203.0.113.9");
  });
});
