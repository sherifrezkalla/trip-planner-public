import { describe, expect, it } from "vitest";
import { haversineKm } from "@/lib/geo";
import { formatTripDateRange } from "@/lib/trip-dates";
import { venueRowToCandidate, type VenueCandidateRow } from "@/lib/places";
import { BLOCK_START_MINUTES, regularHoursCoverBlock, tripWeekday } from "@/lib/opening-hours";
import { TODAY_BLOCK_ORDER, TODAY_BLOCK_START_MINUTES } from "@/lib/today";
import { BLOCKS } from "@/lib/schema";
import { isOpenForBlock, PLANNED_BLOCKS } from "@/lib/generate";
import { regularHoursCoverBlock as viaPartialDay } from "@/lib/partial-day";

/**
 * These helpers each existed two or three times over, arrived at independently
 * and identically. The tests below cover the merged behaviour, and — more to the
 * point — pin the merge itself: an alias that quietly becomes a copy again would
 * pass every other test in the suite.
 */

describe("haversineKm", () => {
  it("measures a known distance", () => {
    // Two fixed geographic points with a known distance.
    expect(haversineKm({ lat: 43.5528, lng: 7.0174 }, { lat: 43.7102, lng: 7.2620 }))
      .toBeCloseTo(26.34, 1);
  });

  it("is zero for one place and symmetric between two", () => {
    const pointA = { lat: 43.5528, lng: 7.0174 };
    const pointB = { lat: 43.7102, lng: 7.2620 };

    expect(haversineKm(pointA, pointA)).toBe(0);
    expect(haversineKm(pointA, pointB)).toBeCloseTo(haversineKm(pointB, pointA), 10);
  });
});

describe("formatTripDateRange", () => {
  it("carries the year once, on the end of the range", () => {
    expect(formatTripDateRange("2026-09-01", "2026-09-07")).toBe("1 Sept – 7 Sept 2026");
  });

  it("spans months and years", () => {
    expect(formatTripDateRange("2026-12-29", "2027-01-03")).toBe("29 Dec – 3 Jan 2027");
  });
});

describe("venueRowToCandidate", () => {
  const row: VenueCandidateRow = {
    id: "cand-1",
    name: "Musee Picasso",
    category: "art",
    rating: 4.5,
    review_count: 1200,
    price_level: "PRICE_LEVEL_MODERATE",
    opening_hours: ["Monday: 10:00 AM – 6:00 PM"],
    opening_periods: [{ open: { day: 1, hour: 10, minute: 0 }, close: { day: 1, hour: 18, minute: 0 } }],
    lat: 43.57,
    lng: 7.12,
    maps_url: "https://maps.example/1",
    area: "Antibes",
    distance_km: 11,
    venue_candidate_categories: [{ category: "art" }, { category: "history" }],
  };

  it("reads a stored row as the planner's shape", () => {
    expect(venueRowToCandidate(row)).toMatchObject({
      placeId: "cand-1",
      name: "Musee Picasso",
      categories: ["art", "history"],
      reviewCount: 1200,
      area: "Antibes",
      distanceKm: 11,
    });
  });

  /** The subtle half, and the one most likely to be corrected in one copy only. */
  it("falls back to the single category when the join table is empty", () => {
    expect(venueRowToCandidate({ ...row, venue_candidate_categories: [] }).categories).toEqual(["art"]);
    expect(venueRowToCandidate({ ...row, venue_candidate_categories: null }).categories).toEqual(["art"]);
  });

  it("defaults an area-less, distance-less row rather than dropping the fields", () => {
    const candidate = venueRowToCandidate({ ...row, area: null, distance_km: null });

    expect(candidate.area).toBe("");
    expect(candidate.distanceKm).toBe(0);
  });
});

describe("one definition of a day's shape", () => {
  it("orders blocks from the schema, not a copy", () => {
    expect(TODAY_BLOCK_ORDER).toBe(BLOCKS);
  });

  it("times blocks from one clock", () => {
    expect(TODAY_BLOCK_START_MINUTES).toBe(BLOCK_START_MINUTES);
  });

  it("plans a subset of the blocks a day can hold", () => {
    // PLANNED_BLOCKS is deliberately not all of them — generated days skip
    // lunch — so it stays its own list, but every entry must be a real block.
    expect(PLANNED_BLOCKS.every((block) => BLOCKS.includes(block))).toBe(true);
    expect(PLANNED_BLOCKS).not.toContain("lunch");
  });
});

describe("one rule for regular opening hours", () => {
  const nineToFiveMonday = [
    { open: { day: 1, hour: 9, minute: 0 }, close: { day: 1, hour: 17, minute: 0 } },
  ];
  // 2026-09-07 is a Monday.
  const monday = "2026-09-07";

  it("resolves a trip day to a weekday in UTC", () => {
    expect(tripWeekday(monday, 0)).toBe(1);
    expect(tripWeekday(monday, 6)).toBe(0);
  });

  it("admits a visit the hours cover and refuses one they do not", () => {
    expect(regularHoursCoverBlock(nineToFiveMonday, monday, 0, "morning", 60)).toBe(true);
    expect(regularHoursCoverBlock(nineToFiveMonday, monday, 0, "dinner", 60)).toBe(false);
  });

  it("refuses a visit that would outlast the closing time", () => {
    // Opens 09:00, closes 17:00; the morning block starts at 09:00.
    expect(regularHoursCoverBlock(nineToFiveMonday, monday, 0, "morning", 8 * 60)).toBe(true);
    expect(regularHoursCoverBlock(nineToFiveMonday, monday, 0, "morning", 8 * 60 + 1)).toBe(false);
  });

  it("treats no known hours as closed, never as open", () => {
    expect(regularHoursCoverBlock([], monday, 0, "morning", 30)).toBe(false);
  });

  it("reads a lone Sunday-midnight open point as always open", () => {
    const alwaysOpen = [{ open: { day: 0, hour: 0, minute: 0 } }];

    expect(regularHoursCoverBlock(alwaysOpen, monday, 0, "evening", 120)).toBe(true);
  });

  it("handles a period that closes after midnight", () => {
    const lateBar = [
      { open: { day: 1, hour: 20, minute: 0 }, close: { day: 2, hour: 2, minute: 0 } },
    ];

    expect(regularHoursCoverBlock(lateBar, monday, 0, "evening", 120)).toBe(true);
    expect(regularHoursCoverBlock(lateBar, monday, 0, "morning", 30)).toBe(false);
  });

  it("answers the same for generation and for replanning", () => {
    const candidate = {
      placeId: "v1", name: "Bar", category: "nightlife", categories: ["nightlife"],
      rating: 4, reviewCount: 10, priceLevel: null, openingHours: [],
      openingPeriods: nineToFiveMonday, lat: 43.5, lng: 7, mapsUrl: "",
    };

    for (const block of BLOCKS) {
      expect(isOpenForBlock(candidate, monday, 0, block, 60))
        .toBe(viaPartialDay(nineToFiveMonday, monday, 0, block, 60));
    }
  });
});
