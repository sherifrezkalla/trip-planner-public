import { describe, expect, it } from "vitest";
import {
  buildAdjustTodayPreview,
  fingerprintPreview,
  parseAdjustIntent,
  type AdjustItem,
} from "@/lib/adjust-today";
import type { PlaceCandidate } from "@/lib/places";

const emptyPeriods: PlaceCandidate["openingPeriods"] = [];

function item(overrides: Partial<AdjustItem> = {}): AdjustItem {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    dayIndex: 0,
    block: "afternoon",
    position: 0,
    status: "planned",
    isLocked: false,
    reservationLocked: false,
    venueName: "City Museum",
    durationMin: 90,
    openingPeriods: emptyPeriods,
    categories: ["art"],
    lat: 50,
    lng: 6,
    area: "Center",
    candidateId: "21111111-1111-4111-8111-111111111111",
    ...overrides,
  };
}

function intent(reason: string) {
  return parseAdjustIntent(reason);
}

describe("adjust-today intent parsing", () => {
  it("maps pace, duration, accessibility, activity type, and must-keep constraints", () => {
    const parsed = parseAdjustIntent('Low energy, museums, under 60 minutes, step-free; keep "City Museum"');

    expect(parsed.constraint.energy).toBe("low");
    expect(parsed.constraint.maxDurationMin).toBe(60);
    expect(parsed.constraint.activityType).toBe("art");
    expect(parsed.constraint.accessibility).toBe("step-free");
    expect(parsed.constraint.mustKeepNames).toEqual(["city museum"]);
    expect(parsed.unmapped).toEqual([]);
  });

  it("does not silently accept an unsupported instruction", () => {
    const parsed = parseAdjustIntent("make the day magical with a surprise boat");
    expect(parsed.unmapped).toContain("make the day magical with a surprise boat");
  });
});

describe("adjust-today preview", () => {
  it("preserves completed, skipped, locked, reservation-locked, and must-keep items", () => {
    const items = [
      item({ id: "1", venueName: "Done", status: "done", block: "morning" }),
      item({ id: "2", venueName: "Skipped", status: "skipped", block: "lunch" }),
      item({ id: "3", venueName: "Locked", isLocked: true, block: "afternoon" }),
      item({ id: "4", venueName: "Reserved", reservationLocked: true, block: "dinner" }),
      item({ id: "5", venueName: "City Museum", block: "evening" }),
    ];
    const preview = buildAdjustTodayPreview({
      dayIndex: 0,
      items,
      pool: [],
      startDate: "2026-08-25",
      dayCount: 3,
      reason: 'low energy; keep "City Museum"',
      intent: intent('low energy; keep "City Museum"'),
    });

    expect(preview.impact.preserved.map((entry) => entry.reason)).toEqual([
      "completed", "skipped", "locked", "reservation", "must-keep",
    ]);
    expect(preview.impact.moves).toHaveLength(0);
    expect(preview.impact.skips).toHaveLength(0);
    expect(preview.impact.swaps).toHaveLength(0);
    expect(preview.hasChanges).toBe(false);
  });

  it("moves a flexible activity when no grounded replacement exists", () => {
    const preview = buildAdjustTodayPreview({
      dayIndex: 0,
      items: [item({ block: "morning", durationMin: 180 })],
      pool: [],
      startDate: "2026-08-25",
      dayCount: 3,
      reason: "low energy",
      intent: intent("low energy"),
    });

    expect(preview.impact.moves).toHaveLength(1);
    expect(preview.impact.moves[0].toBlock).toBe("afternoon");
    expect(preview.hasChanges).toBe(true);
  });

  it("skips a flexible activity when all later slots are occupied", () => {
    const preview = buildAdjustTodayPreview({
      dayIndex: 0,
      items: [
        item({ id: "1", block: "morning", durationMin: 180 }),
        item({ id: "2", block: "afternoon", isLocked: true }),
        item({ id: "3", block: "evening", isLocked: true }),
      ],
      pool: [],
      startDate: "2026-08-25",
      dayCount: 3,
      reason: "low energy",
      intent: intent("low energy"),
    });

    expect(preview.impact.skips).toHaveLength(1);
    expect(preview.impact.skips[0].venueName).toBe("City Museum");
    expect(preview.hasChanges).toBe(true);
  });

  it("leaves meals and already-matching activities alone for an activity-type request", () => {
    const preview = buildAdjustTodayPreview({
      dayIndex: 0,
      items: [
        item({ id: "1", block: "lunch", venueName: "Cafe Central", categories: ["restaurant", "food"] }),
        item({ id: "2", block: "afternoon", venueName: "Modern Art Museum", categories: ["art"] }),
      ],
      pool: [],
      startDate: "2026-08-25",
      dayCount: 3,
      reason: "museums",
      intent: intent("museums"),
    });

    expect(preview.hasChanges).toBe(false);
    expect(preview.impact.moves).toEqual([]);
    expect(preview.impact.skips).toEqual([]);
    expect(preview.impact.swaps).toEqual([]);
  });

  it("does not move into a slot occupied by an unchanged flexible activity", () => {
    const preview = buildAdjustTodayPreview({
      dayIndex: 0,
      items: [
        item({ id: "1", block: "morning", durationMin: 180 }),
        item({ id: "2", block: "afternoon", durationMin: 60 }),
        item({ id: "3", block: "evening", isLocked: true }),
      ],
      pool: [],
      startDate: "2026-08-25",
      dayCount: 3,
      reason: "low energy",
      intent: intent("low energy"),
    });

    expect(preview.impact.moves).toEqual([]);
    expect(preview.impact.skips.map((entry) => entry.itemId)).toEqual(["1"]);
  });

  it("may reuse a destination vacated by another move or skip in the same preview", () => {
    const preview = buildAdjustTodayPreview({
      dayIndex: 0,
      items: [
        item({ id: "1", block: "morning", durationMin: 180 }),
        item({ id: "2", block: "afternoon", durationMin: 180 }),
        item({ id: "3", block: "evening", isLocked: true }),
      ],
      pool: [],
      startDate: "2026-08-25",
      dayCount: 3,
      reason: "low energy",
      intent: intent("low energy"),
    });

    expect(preview.impact.moves).toEqual([expect.objectContaining({ itemId: "1", toBlock: "afternoon" })]);
    expect(preview.impact.skips.map((entry) => entry.itemId)).toEqual(["2"]);
  });

  it("stores replacement-derived metadata and reports the low-energy denominator accurately", () => {
    const replacement: PlaceCandidate = {
      placeId: "31111111-1111-4111-8111-111111111111",
      name: "Compact Art Gallery",
      category: "art",
      categories: ["art"],
      rating: 4.8,
      reviewCount: 250,
      priceLevel: null,
      openingHours: [],
      openingPeriods: [{ open: { day: 0, hour: 0, minute: 0 } }],
      lat: 50.01,
      lng: 6.01,
      mapsUrl: "https://maps.example/gallery",
      area: "Center",
      distanceKm: 1,
    };
    const preview = buildAdjustTodayPreview({
      dayIndex: 0,
      items: [item({ categories: ["history"], durationMin: 180 })],
      pool: [replacement],
      startDate: "2026-08-25",
      dayCount: 3,
      reason: "low energy, museums",
      intent: intent("low energy, museums"),
    });

    expect(preview.impact.swaps).toEqual([expect.objectContaining({
      toCandidateId: replacement.placeId,
      durationMin: 60,
      area: "Center",
    })]);
    expect(preview.impact.preferenceNotes).toContain(
      "Lower energy: the revision keeps 1 of 1 flexible stops, sets aside 0, and moves 0 later.",
    );
  });

  it("explains an already-matching replacement by the duration pressure that caused it", () => {
    const replacement: PlaceCandidate = {
      placeId: "31111111-1111-4111-8111-111111111111",
      name: "Short Art Gallery",
      category: "art",
      categories: ["art"],
      rating: 4.8,
      reviewCount: 250,
      priceLevel: null,
      openingHours: [],
      openingPeriods: [{ open: { day: 0, hour: 0, minute: 0 } }],
      lat: 50.01,
      lng: 6.01,
      mapsUrl: "https://maps.example/gallery",
      area: "Center",
      distanceKm: 1,
    };
    const preview = buildAdjustTodayPreview({
      dayIndex: 0,
      items: [item({ categories: ["art"], durationMin: 180 })],
      pool: [replacement],
      startDate: "2026-08-25",
      dayCount: 3,
      reason: "museums under 60 minutes",
      intent: intent("museums under 60 minutes"),
    });

    expect(preview.impact.swaps[0].reason).toContain("over the 60-minute cap");
    expect(preview.impact.swaps[0].reason).not.toContain("does not fit the requested art focus");
  });

  it("returns a visible conflict for an unknown must-keep stop", () => {
    const preview = buildAdjustTodayPreview({
      dayIndex: 0,
      items: [item()],
      pool: [],
      startDate: "2026-08-25",
      dayCount: 3,
      reason: 'keep "Aquarium"',
      intent: intent('keep "Aquarium"'),
    });

    expect(preview.impact.conflicts).toContain('No activity on today matches "aquarium" to keep');
  });
});

describe("adjust-today fingerprints", () => {
  it("is stable when impact arrays arrive in a different order", () => {
    const first = buildAdjustTodayPreview({
      dayIndex: 0,
      items: [item({ id: "1", block: "morning", durationMin: 180 }), item({ id: "2", block: "afternoon", durationMin: 180 })],
      pool: [], startDate: "2026-08-25", dayCount: 3, reason: "low energy", intent: intent("low energy"),
    });
    const second = { ...first, impact: { ...first.impact, moves: [...first.impact.moves].reverse(), skips: [...first.impact.skips].reverse(), swaps: [...first.impact.swaps].reverse() } };

    expect(fingerprintPreview(first)).toBe(fingerprintPreview(second));
  });
});
