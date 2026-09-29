import { describe, it, expect } from "vitest";
import { mergeCandidateCategories, missingCategories } from "@/lib/venue-cache";
import type { PlaceCandidate } from "@/lib/places";

describe("missingCategories", () => {
  it("finds nothing missing when the cache already covers every category", () => {
    expect(missingCategories(["food", "history"], ["food", "history", "restaurant"])).toEqual([]);
  });

  it("reports categories a later traveller introduced", () => {
    // The cache was built for one person; two more joined wanting art and shopping.
    expect(
      missingCategories(["food", "art", "shopping"], ["food", "history", "restaurant"]),
    ).toEqual(["art", "shopping"]);
  });

  it("treats an empty cache as everything missing", () => {
    expect(missingCategories(["food", "art"], [])).toEqual(["food", "art"]);
  });

  it("does not report duplicates when a category is required twice", () => {
    expect(missingCategories(["art", "art"], [])).toEqual(["art"]);
  });

  it("ignores cached categories nobody asks for any more", () => {
    expect(missingCategories(["food"], ["food", "nightlife"])).toEqual([]);
  });
});

describe("mergeCandidateCategories", () => {
  const candidate = (placeId: string, category: string): PlaceCandidate => ({
    placeId,
    name: placeId,
    category,
    categories: [category],
    rating: 4.5,
    reviewCount: 10,
    priceLevel: null,
    openingHours: ["Open 24 hours"],
    openingPeriods: [{ open: { day: 0, hour: 0, minute: 0 } }],
    lat: 1,
    lng: 2,
    mapsUrl: "",
    area: "Lisbon",
  });

  it("keeps one venue while retaining every category Google returned it for", () => {
    const merged = mergeCandidateCategories([
      candidate("same-place", "food"),
      candidate("same-place", "restaurant"),
      candidate("other-place", "history"),
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0].candidate.placeId).toBe("same-place");
    expect(merged[0].categories).toEqual(["food", "restaurant"]);
  });
});
