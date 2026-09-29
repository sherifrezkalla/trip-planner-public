import { describe, it, expect, vi } from "vitest";
import {
  buildCategoryQueries, searchPlaces, filterByRating, placeCategories, biasRadiusMetres,
  type PlaceCandidate,
} from "@/lib/places";

function cand(overrides: Partial<PlaceCandidate>): PlaceCandidate {
  return {
    placeId: "p1", name: "Place", category: "food", categories: ["food"], rating: 4.5, reviewCount: 100,
    priceLevel: null, openingHours: [], openingPeriods: [], lat: 0, lng: 0, mapsUrl: "", ...overrides,
  };
}

describe("buildCategoryQueries", () => {
  it("dedupes interests and adds restaurant, the only meal that is planned", () => {
    // Breakfast is wherever the group is staying and lunch is wherever they
    // happen to be, so neither is searched for any more.
    const qs = buildCategoryQueries(["food", "food", "history"], ["none"]);
    const categories = qs.map((q) => q.category);
    expect(categories).toEqual(["food", "history", "restaurant"]);
  });
  it("uses vegetarian-friendly restaurant query when any traveler is vegetarian or vegan", () => {
    const qs = buildCategoryQueries(["food"], ["none", "vegan"]);
    const restaurant = qs.find((q) => q.category === "restaurant")!;
    expect(restaurant.query).toContain("vegetarian");
  });
});

describe("biasRadiusMetres", () => {
  it("converts kilometres to metres for a city-sized search", () => {
    expect(biasRadiusMetres(15)).toBe(15_000);
  });

  it("defaults to a city radius when none is given", () => {
    expect(biasRadiusMetres(undefined)).toBe(15_000);
  });

  it("caps the regional radii Google rejects outright", () => {
    // A trip may declare a 60 or 100 km explore radius. Sent as-is, Google
    // answers 400 Invalid circle.radius and the whole generation dies — which
    // is exactly what happened to a regional trip.
    expect(biasRadiusMetres(60)).toBe(50_000);
    expect(biasRadiusMetres(100)).toBe(50_000);
  });

  it("never exceeds the documented maximum, whatever it is handed", () => {
    for (const km of [15, 20, 50, 51, 60, 100, 1000]) {
      expect(biasRadiusMetres(km)).toBeLessThanOrEqual(50_000);
    }
  });
});

describe("searchPlaces", () => {
  it("aborts a stalled fetch at exactly ten seconds and clears its timer", async () => {
    vi.useFakeTimers();
    try {
      let signal: AbortSignal | undefined;
      const fetchImpl = vi.fn((_url, init) => new Promise<Response>((_resolve, reject) => {
        signal = init.signal;
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as unknown as typeof fetch;
      const pending = searchPlaces({ query: "q", category: "place", lat: 1, lng: 1, apiKey: "k", fetchImpl });
      const rejected = expect(pending).rejects.toThrow("aborted");
      expect(signal).toBeInstanceOf(AbortSignal);
      await vi.advanceTimersByTimeAsync(9999);
      expect(signal?.aborted).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await rejected;
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it.each(["success", "http", "parse", "rejection"])("clears its deadline after %s", async outcome => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn().mockImplementation(async (_url, init) => {
        expect(init.signal).toBeInstanceOf(AbortSignal);
        expect(vi.getTimerCount()).toBe(1);
        if (outcome === "rejection") throw new Error("provider detail");
        return new Response(outcome === "success" ? '{"places":[]}' : "invalid", { status: outcome === "http" ? 503 : 200 });
      }) as unknown as typeof fetch;
      const pending = searchPlaces({ query: "q", category: "place", lat: 1, lng: 1, apiKey: "k", fetchImpl });
      if (outcome === "success") await expect(pending).resolves.toEqual([]);
      else await expect(pending).rejects.toThrow();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  const apiResponse = {
    places: [
      {
        id: "gp_1",
        displayName: { text: "Time Out Market" },
        rating: 4.6,
        userRatingCount: 90000,
        priceLevel: "PRICE_LEVEL_MODERATE",
        location: { latitude: 38.707, longitude: -9.146 },
        googleMapsUri: "https://maps.google.com/?cid=1",
        regularOpeningHours: {
          weekdayDescriptions: ["Monday: 10:00 AM – 12:00 AM"],
          periods: [{
            open: { day: 1, hour: 10, minute: 0 },
            close: { day: 2, hour: 0, minute: 0 },
          }],
        },
        businessStatus: "OPERATIONAL",
      },
      { id: "gp_2", displayName: { text: "Closed Spot" }, businessStatus: "CLOSED_PERMANENTLY" },
    ],
  };

  it("sends a radius Google will accept for a regional trip", async () => {
    // The Example Coast trip is 60 km. Sent unclamped this request came back
    // "400 Invalid circle.radius", which surfaced to the group as a failed
    // plan generation with no way forward.
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ places: [] }), { status: 200 }),
    ) as unknown as typeof fetch;
    await searchPlaces({
      query: "dinner", category: "food", lat: 43.55, lng: 7.01,
      apiKey: "k", radiusKm: 60, fetchImpl,
    });
    const [, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.locationBias.circle.radius).toBe(50_000);
  });

  it("maps the Places response and drops non-operational venues", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(apiResponse), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = await searchPlaces({
      query: "food market", category: "food", lat: 38.72, lng: -9.14, apiKey: "k", fetchImpl,
    });
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      placeId: "gp_1",
      name: "Time Out Market",
      category: "food",
      categories: ["food"],
      rating: 4.6,
      openingHours: ["Monday: 10:00 AM – 12:00 AM"],
      openingPeriods: [{
        open: { day: 1, hour: 10, minute: 0 },
        close: { day: 2, hour: 0, minute: 0 },
      }],
    });
    const [url, init] = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(url).toBe("https://places.googleapis.com/v1/places:searchText");
    expect((init.headers as Record<string, string>)["X-Goog-Api-Key"]).toBe("k");
    expect((init.headers as Record<string, string>)["X-Goog-FieldMask"]).toContain(
      "places.regularOpeningHours.periods",
    );
    expect(JSON.parse(init.body as string).languageCode).toBe("en");
  });

  it("drops provider rows without coordinates or a Maps URL instead of fabricating verified fields", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      places: [
        { id: "missing-location", displayName: { text: "No location" }, googleMapsUri: "https://maps.google.com/?cid=2" },
        { id: "missing-url", displayName: { text: "No map" }, location: { latitude: 43.55, longitude: 7.01 } },
        apiResponse.places[0],
      ],
    }), { status: 200 })) as unknown as typeof fetch;

    const result = await searchPlaces({
      query: "museum", category: "place", lat: 43.55, lng: 7.01, apiKey: "k", fetchImpl,
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      placeId: "gp_1", lat: 38.707, lng: -9.146, mapsUrl: "https://maps.google.com/?cid=1",
    });
  });

  it("throws on a non-OK response", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("quota", { status: 429 })) as unknown as typeof fetch;
    await expect(
      searchPlaces({ query: "q", category: "c", lat: 0, lng: 0, apiKey: "k", fetchImpl }),
    ).rejects.toThrow("Places API 429");
  });
});

describe("placeCategories", () => {
  it("recognizes a suggested restaurant so it can fill a meal block", () => {
    expect(placeCategories("suggestion", ["italian_restaurant", "food"])).toEqual([
      "suggestion",
      "restaurant",
    ]);
  });

  it("does not turn a suggested landmark into a meal venue", () => {
    expect(placeCategories("suggestion", ["tourist_attraction"])).toEqual(["suggestion"]);
  });
});

describe("filterByRating", () => {
  it("keeps only rating >= 4.0 when 3 or more qualify", () => {
    const cands = [cand({ placeId: "a", rating: 4.5 }), cand({ placeId: "b", rating: 4.0 }),
      cand({ placeId: "c", rating: 4.2 }), cand({ placeId: "d", rating: 3.6 })];
    expect(filterByRating(cands).map((c) => c.placeId)).toEqual(["a", "b", "c"]);
  });
  it("relaxes to 3.5 when fewer than 3 strong candidates", () => {
    const cands = [cand({ placeId: "a", rating: 4.1 }), cand({ placeId: "b", rating: 3.7 }),
      cand({ placeId: "c", rating: 3.2 })];
    expect(filterByRating(cands).map((c) => c.placeId)).toEqual(["a", "b"]);
  });
});
