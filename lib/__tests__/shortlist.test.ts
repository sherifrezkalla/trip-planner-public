import { describe, it, expect } from "vitest";
import { shortlistCandidates, PER_AREA_CATEGORY, PROMPT_CANDIDATE_CAP } from "@/lib/generate";
import type { PlaceCandidate } from "@/lib/places";

function cand(overrides: Partial<PlaceCandidate> & { placeId: string }): PlaceCandidate {
  const category = overrides.category ?? "food";
  return {
    name: `Venue ${overrides.placeId}`, category, categories: overrides.categories ?? [category], rating: 4.5, reviewCount: 100,
    priceLevel: null, openingHours: [], openingPeriods: [], lat: 40, lng: 19, mapsUrl: "", area: "Vlorë",
    distanceKm: 0, ...overrides,
  };
}

describe("shortlistCandidates", () => {
  it("keeps everything when the pool is already small", () => {
    const pool = [cand({ placeId: "a" }), cand({ placeId: "b" })];
    expect(shortlistCandidates(pool)).toHaveLength(2);
  });

  it("keeps only the best few per area and category", () => {
    const pool = Array.from({ length: 10 }, (_, i) =>
      cand({ placeId: `v${i}`, rating: 3.5 + i / 10, reviewCount: 100 }),
    );
    const result = shortlistCandidates(pool);
    expect(result).toHaveLength(PER_AREA_CATEGORY);
    // The highest-rated survive.
    expect(result.map((c) => c.placeId)).toEqual(["v9", "v8", "v7"].slice(0, PER_AREA_CATEGORY));
  });

  it("gives every area its own allowance rather than letting one dominate", () => {
    const pool = [
      ...Array.from({ length: 6 }, (_, i) => cand({ placeId: `vl${i}`, area: "Vlorë", rating: 4.9 })),
      ...Array.from({ length: 6 }, (_, i) => cand({ placeId: `hi${i}`, area: "Himarë", rating: 4.1 })),
    ];
    const areas = new Set(shortlistCandidates(pool).map((c) => c.area));
    expect(areas).toEqual(new Set(["Vlorë", "Himarë"]));
  });

  it("keeps categories separate so restaurants don't crowd out sights", () => {
    const pool = [
      ...Array.from({ length: 5 }, (_, i) => cand({ placeId: `r${i}`, category: "restaurant", rating: 4.9 })),
      ...Array.from({ length: 5 }, (_, i) => cand({ placeId: `h${i}`, category: "history", rating: 4.0 })),
    ];
    const categories = new Set(shortlistCandidates(pool).map((c) => c.category));
    expect(categories).toEqual(new Set(["restaurant", "history"]));
  });

  it("never exceeds the prompt cap", () => {
    const pool = Array.from({ length: 600 }, (_, i) =>
      cand({ placeId: `v${i}`, area: `Area ${i % 9}`, category: `cat ${i % 7}`, rating: 4 + (i % 10) / 10 }),
    );
    expect(shortlistCandidates(pool).length).toBeLessThanOrEqual(PROMPT_CANDIDATE_CAP);
  });
});
