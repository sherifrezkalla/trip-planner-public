import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { computeTrafficAwareRoute, parseTrafficAwareRoute } from "@/lib/routes";

const origin = { lat: 43.55, lng: 7.01 };
const destination = { lat: 43.7, lng: 7.27 };
const payload = { routes: [{ duration: "900.5s", staticDuration: "600.5s", distanceMeters: 25000, polyline: { encodedPolyline: "abc" } }] };

afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("traffic route parser", () => {
  it("preserves fractional seconds and derives minutes and a nonnegative delay", () => {
    expect(parseTrafficAwareRoute(payload)).toEqual({
      status: "available", durationSeconds: 900.5, staticDurationSeconds: 600.5,
      durationMinutes: 900.5 / 60, trafficDelayMinutes: 5, distanceMeters: 25000,
      encodedPolyline: "abc", dataSource: "google_routes", verifyLiveAvailability: true,
    });
    expect(parseTrafficAwareRoute({ routes: [{ duration: "0.000000001s", staticDuration: "1s", distanceMeters: 0 }] }))
      .toMatchObject({ status: "available", durationSeconds: 0.000000001, trafficDelayMinutes: 0 });
  });

  it.each([undefined, null, {}, [], { routes: [] }, { routes: null }])("returns unavailable for absent routes: %j", (input) => {
    expect(parseTrafficAwareRoute(input)).toEqual({ status: "unavailable", reason: "invalid_response" });
  });

  it.each(["60", "60s garbage", "-1s", "1e3s", " 60s", "60.1234567890s", "1.s", ".5s", "Infinitys", "315576000001s", 60, null])("refuses malformed duration %j", (duration) => {
    for (const field of ["duration", "staticDuration"]) {
      expect(parseTrafficAwareRoute({ routes: [{ ...payload.routes[0], [field]: duration }] }))
        .toEqual({ status: "unavailable", reason: "invalid_response" });
    }
  });

  it.each([undefined, -1, 1.5, "100", NaN, Infinity])("refuses malformed distance %j", (distanceMeters) => {
    expect(parseTrafficAwareRoute({ routes: [{ ...payload.routes[0], distanceMeters }] }))
      .toEqual({ status: "unavailable", reason: "invalid_response" });
  });
});

describe("Google Routes client", () => {
  it("uses the dedicated server key, exact v2 endpoint, traffic-aware driving and bounded field mask", async () => {
    vi.stubEnv("GOOGLE_ROUTES_API_KEY", "routes-secret");
    const fetchImpl = vi.fn().mockResolvedValue(Response.json(payload));
    expect(await computeTrafficAwareRoute({ origin, destination, fetchImpl })).toMatchObject({ status: "available", trafficDelayMinutes: 5 });
    expect(fetchImpl).toHaveBeenCalledWith("https://routes.googleapis.com/directions/v2:computeRoutes", expect.objectContaining({
      method: "POST", cache: "no-store", signal: expect.any(AbortSignal),
      headers: {
        "Content-Type": "application/json", "X-Goog-Api-Key": "routes-secret",
        "X-Goog-FieldMask": "routes.duration,routes.staticDuration,routes.distanceMeters,routes.polyline.encodedPolyline",
      },
    }));
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({
      origin: { location: { latLng: { latitude: 43.55, longitude: 7.01 } } },
      destination: { location: { latLng: { latitude: 43.7, longitude: 7.27 } } },
      travelMode: "DRIVE", routingPreference: "TRAFFIC_AWARE",
    });
  });

  it("reports a missing Routes key without falling back to the Places key or making a request", async () => {
    vi.stubEnv("GOOGLE_ROUTES_API_KEY", " ");
    vi.stubEnv("GOOGLE_MAPS_API_KEY", "places-only-secret");
    const fetchImpl = vi.fn();
    expect(await computeTrafficAwareRoute({ origin, destination, fetchImpl }))
      .toEqual({ status: "unavailable", reason: "not_configured" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each(["http", "network", "json"])("sanitizes %s failures", async (kind) => {
    vi.stubEnv("GOOGLE_ROUTES_API_KEY", "routes-secret");
    const fetchImpl = vi.fn().mockImplementation(async () => {
      if (kind === "network") throw new Error("routes-secret private payload");
      return new Response("routes-secret private payload", { status: kind === "http" ? 403 : 200 });
    });
    expect(await computeTrafficAwareRoute({ origin, destination, fetchImpl }))
      .toEqual({ status: "unavailable", reason: "upstream_unavailable" });
  });

  it("aborts a stalled request after ten seconds", async () => {
    vi.useFakeTimers();
    vi.stubEnv("GOOGLE_ROUTES_API_KEY", "routes-secret");
    let signal: AbortSignal;
    const fetchImpl = vi.fn().mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      signal = init.signal;
      signal.addEventListener("abort", () => reject(new Error("aborted")));
    }));
    const pending = computeTrafficAwareRoute({ origin, destination, fetchImpl });
    await vi.advanceTimersByTimeAsync(10000);
    expect(signal!.aborted).toBe(true);
    expect(await pending).toEqual({ status: "unavailable", reason: "upstream_unavailable" });
    expect(vi.getTimerCount()).toBe(0);
  });
});
