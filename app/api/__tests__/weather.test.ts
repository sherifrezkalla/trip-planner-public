import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "@/app/api/weather/route";

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const currentTime = 1_786_444_800;

function providerResponse(init: ResponseInit = {}) {
  return new Response(JSON.stringify({
    current: { time: currentTime, temperature_2m: 24, weather_code: 2, precipitation: 0 },
    hourly: {
      time: Array.from({ length: 12 }, (_, h) => currentTime + h * 3600),
      precipitation_probability: [10, 75, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10],
      weather_code: Array.from({ length: 12 }, () => 2),
    },
  }), { status: 200, ...init });
}

describe("GET /api/weather", () => {
  it("rejects invalid coordinates before contacting the provider", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const missing = await GET(new Request("http://test/api/weather"));
    const response = await GET(new Request("http://test/api/weather?lat=999&lng=19"));
    expect(missing.status).toBe(400);
    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns normalized weather with a shared cache policy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(providerResponse());

    const response = await GET(new Request("http://test/api/weather?lat=41.3&lng=19.8"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("s-maxage=900");
    expect(await response.json()).toMatchObject({
      weather: { risk: "warning", maxPrecipitationProbability: 75, coverageHours: 6 },
    });
  });

  it("degrades cleanly when the provider fails", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("nope", { status: 503 }));
    const response = await GET(new Request("http://test/api/weather?lat=41.3&lng=19.8"));
    expect(response.status).toBe(502);
  });

  /**
   * The upstream fetch is cached for 15 minutes and this response may then be
   * served stale for 30 more. A timestamp read from the clock here would reset
   * on every cache hit and report a freshness the reading does not have, so it
   * comes from the provider response — which the cache carries with the body.
   */
  it("dates the reading from the provider response, not the request clock", async () => {
    const retrievedAt = new Date("2026-08-12T07:42:31.000Z");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T08:20:00.000Z")); // 38 minutes later
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      providerResponse({ headers: { date: retrievedAt.toUTCString() } }),
    );

    const body = await (await GET(new Request("http://test/api/weather?lat=41.3&lng=19.8"))).json();
    expect(body.weather.fetchedAt).toBe(retrievedAt.toISOString());
    expect(body.weather.observedAt).toBe(new Date(currentTime * 1000).toISOString());
  });

  it("falls back to the current time when the provider sends no usable date", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T08:20:00.000Z"));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      providerResponse({ headers: { date: "not a date" } }),
    );

    const body = await (await GET(new Request("http://test/api/weather?lat=41.3&lng=19.8"))).json();
    expect(body.weather.fetchedAt).toBe("2026-08-12T08:20:00.000Z");
  });
});
