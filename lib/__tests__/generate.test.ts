import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { extractJson, validatePlan, travelWarnings, arrangePlan, arrangeSwap, filterSwapCandidates, isOpenForBlock, buildPrompt, venueAliases, resolveAliases, buildDayOptions, MAX_DAY_SPREAD_KM, PLANNED_BLOCKS } from "@/lib/generate";
import { haversineKm } from "@/lib/geo";
import type { PlaceCandidate } from "@/lib/places";
import type { TripMeta, TravelerPrefs, ItineraryPlan } from "@/lib/schema";

const trip: TripMeta = {
  destinationName: "Lisbon", startDate: "2026-09-10", endDate: "2026-09-11",
  budgetLevel: "mid", vibeNote: "", dayCount: 2,
};
const travelers: TravelerPrefs[] = [
  { displayName: "A", interests: ["food"], pace: "balanced", dietary: "vegetarian", constraintsNote: "" },
];
function cand(
  id: string,
  lat = 38.7,
  lng = -9.14,
  overrides: Partial<PlaceCandidate> = {},
): PlaceCandidate {
  return {
    placeId: id, name: `Venue ${id}`, category: "food", categories: ["food"], rating: 4.5, reviewCount: 10,
    priceLevel: null, openingHours: ["Open 24 hours"],
    openingPeriods: [{ open: { day: 0, hour: 0, minute: 0 } }],
    lat, lng, mapsUrl: "", area: "Lisbon", ...overrides,
  };
}
const candidates = [
  cand("c1"),
  cand("c2", 38.7, -9.14, { category: "restaurant", categories: ["restaurant"] }),
  cand("c3"),
  cand("c4", 38.7, -9.14, { category: "restaurant", categories: ["restaurant"] }),
  cand("c5"),
  cand("c6", 38.7, -9.14, { category: "restaurant", categories: ["restaurant"] }),
  cand("c7"),
  cand("c8", 38.7, -9.14, { category: "restaurant", categories: ["restaurant"] }),
];

function planJson(ids: [string, string, string, string, string, string, string, string]): string {
  return JSON.stringify({
    days: [
      { dayIndex: 0, area: "Lisbon", blocks: [
        { block: "morning", candidateId: ids[0], whyNote: "w", durationMin: 120 },
        { block: "lunch", candidateId: ids[1], whyNote: "w", durationMin: 60 },
        { block: "afternoon", candidateId: ids[2], whyNote: "w", durationMin: 120 },
        { block: "dinner", candidateId: ids[3], whyNote: "w", durationMin: 90 },
      ]},
      { dayIndex: 1, area: "Lisbon", blocks: [
        { block: "morning", candidateId: ids[4], whyNote: "w", durationMin: 120 },
        { block: "lunch", candidateId: ids[5], whyNote: "w", durationMin: 60 },
        { block: "afternoon", candidateId: ids[6], whyNote: "w", durationMin: 120 },
        { block: "dinner", candidateId: ids[7], whyNote: "w", durationMin: 90 },
      ]},
    ],
  });
}

const validIds = ["c1", "c2", "c3", "c4", "c5", "c6", "c7", "c8"] as const;

describe("extractJson", () => {
  it("parses JSON wrapped in markdown fences and prose", () => {
    const text = 'Here you go:\n```json\n{"a": 1}\n```\nEnjoy!';
    expect(extractJson(text)).toEqual({ a: 1 });
  });
  it("throws when no JSON object present", () => {
    expect(() => extractJson("no json here")).toThrow();
  });
});

describe("validatePlan", () => {
  it("returns no errors for a valid plan", () => {
    const plan = JSON.parse(planJson([...validIds])) as ItineraryPlan;
    expect(validatePlan(plan, candidates, 2, trip.startDate)).toEqual([]);
  });
  it("flags unknown candidate ids", () => {
    const plan = JSON.parse(planJson(["cX", "c2", "c3", "c4", "c5", "c6", "c7", "c8"])) as ItineraryPlan;
    expect(validatePlan(plan, candidates, 2, trip.startDate).join(" ")).toContain("cX");
  });
  it("flags duplicate venues and wrong day count", () => {
    const plan = JSON.parse(planJson(["c1", "c2", "c3", "c4", "c1", "c6", "c7", "c8"])) as ItineraryPlan;
    const errors = validatePlan(plan, candidates, 3, trip.startDate);
    expect(errors.some((e) => e.includes("Duplicate"))).toBe(true);
    expect(errors.some((e) => e.includes("Expected 3 days"))).toBe(true);
  });
  it("rejects missing, duplicate, and out-of-order core blocks", () => {
    const plan = JSON.parse(planJson([...validIds])) as ItineraryPlan;
    plan.days[0].blocks = [
      plan.days[0].blocks[1],
      plan.days[0].blocks[1],
      plan.days[0].blocks[2],
    ];
    const errors = validatePlan(plan, candidates, 2, trip.startDate).join(" ");
    expect(errors).toContain("missing required block");
    expect(errors).toContain("duplicate block");
    expect(errors).toContain("block order");
  });
  it("rejects duplicate or out-of-range day indexes", () => {
    const plan = JSON.parse(planJson([...validIds])) as ItineraryPlan;
    plan.days[1].dayIndex = 0;
    const errors = validatePlan(plan, candidates, 2, trip.startDate).join(" ");
    expect(errors).toContain("dayIndex sequence");
  });
  it("rejects a sight booked as dinner", () => {
    const sight = cand("sight", 38.7, -9.14, { category: "history", categories: ["history"] });
    const plan = JSON.parse(planJson([...validIds])) as ItineraryPlan;
    plan.days[0].blocks[3].candidateId = "sight"; // the dinner block
    expect(validatePlan(plan, [...candidates, sight], 2, trip.startDate).join(" ")).toContain("meal block");
  });
  it("no longer polices what a lunch block contains", () => {
    // Lunch is not planned any more, but old plans still carry one and must
    // keep loading rather than turning into a wall of errors.
    const sight = cand("sight2", 38.7, -9.14, { category: "history", categories: ["history"] });
    const plan = JSON.parse(planJson([...validIds])) as ItineraryPlan;
    plan.days[0].blocks[1].candidateId = "sight2";
    expect(validatePlan(plan, [...candidates, sight], 2, trip.startDate).join(" "))
      .not.toContain("meal block");
  });
  it("rejects a venue that is closed at the block time", () => {
    const closedAtDinner = cand("closed", 38.7, -9.14, {
      category: "restaurant",
      categories: ["restaurant"],
      openingPeriods: [{
        open: { day: 4, hour: 8, minute: 0 },
        close: { day: 4, hour: 17, minute: 0 },
      }],
    });
    const plan = JSON.parse(planJson([...validIds])) as ItineraryPlan;
    plan.days[0].blocks[3].candidateId = "closed";
    expect(validatePlan(plan, [...candidates, closedAtDinner], 2, trip.startDate).join(" ")).toContain("closed for dinner");
  });
  it("rejects venues without structured opening hours", () => {
    const unknown = cand("unknown", 38.7, -9.14, { openingPeriods: [] });
    const plan = JSON.parse(planJson([...validIds])) as ItineraryPlan;
    plan.days[0].blocks[0].candidateId = "unknown";
    expect(validatePlan(plan, [...candidates, unknown], 2, trip.startDate).join(" ")).toContain("no structured opening hours");
  });
  it("rejects a day area that does not match its venues", () => {
    const plan = JSON.parse(planJson([...validIds])) as ItineraryPlan;
    plan.days[0].area = "Porto";
    expect(validatePlan(plan, candidates, 2, trip.startDate).join(" ")).toContain("area");
  });
});

describe("validatePlan light days", () => {
  /** One day trimmed to lunch, an afternoon stop, and dinner. */
  function lightDayPlan(blocks: { block: string; candidateId: string }[]): ItineraryPlan {
    return {
      days: [
        {
          dayIndex: 0,
          area: "Lisbon",
          blocks: blocks.map((entry) => ({
            block: entry.block as ItineraryPlan["days"][0]["blocks"][0]["block"],
            candidateId: entry.candidateId,
            whyNote: "w",
            durationMin: 90,
          })),
        },
      ],
    };
  }

  it("accepts a day with only lunch and dinner", () => {
    const plan = lightDayPlan([
      { block: "lunch", candidateId: "c2" },
      { block: "dinner", candidateId: "c4" },
    ]);
    expect(validatePlan(plan, candidates, 1, trip.startDate)).toEqual([]);
  });

  it("accepts a day that drops the morning but keeps an afternoon stop", () => {
    const plan = lightDayPlan([
      { block: "lunch", candidateId: "c2" },
      { block: "afternoon", candidateId: "c1" },
      { block: "dinner", candidateId: "c4" },
    ]);
    expect(validatePlan(plan, candidates, 1, trip.startDate)).toEqual([]);
  });

  it("accepts a morning and a dinner, with no lunch at all", () => {
    const plan = lightDayPlan([
      { block: "morning", candidateId: "c1" },
      { block: "dinner", candidateId: "c4" },
    ]);
    expect(validatePlan(plan, candidates, 1, trip.startDate)).toEqual([]);
  });

  it("still requires dinner", () => {
    const plan = lightDayPlan([
      { block: "lunch", candidateId: "c2" },
      { block: "afternoon", candidateId: "c1" },
    ]);
    expect(validatePlan(plan, candidates, 1, trip.startDate).join(" ")).toContain('missing required block "dinner"');
  });

  it("keeps enforcing block order on a light day", () => {
    const plan = lightDayPlan([
      { block: "dinner", candidateId: "c4" },
      { block: "lunch", candidateId: "c2" },
    ]);
    expect(validatePlan(plan, candidates, 1, trip.startDate).join(" ")).toContain("block order");
  });
});

describe("validatePlan day spread", () => {
  it("rejects a day whose stops sprawl across the region", () => {
    const near = cand("c1");
    const far = cand("c2", 40.1, -9.14); // ~150 km away
    const plan = {
      days: [{ dayIndex: 0, area: "Somewhere", blocks: [
        { block: "morning", candidateId: "c1", whyNote: "", durationMin: 60 },
        { block: "lunch", candidateId: "c2", whyNote: "", durationMin: 60 },
      ]}],
    } as ItineraryPlan;
    const errors = validatePlan(plan, [near, far], 1, trip.startDate);
    expect(errors.join(" ")).toMatch(/Day 0 spans \d+ km/);
  });

  it("accepts a day whose stops sit in one area", () => {
    const a = cand("c1", 40.4661, 19.4914);
    const b = cand("c2", 40.4700, 19.5000); // ~1 km away
    const plan = {
      days: [{ dayIndex: 0, area: "Vlorë", blocks: [
        { block: "morning", candidateId: "c1", whyNote: "", durationMin: 60 },
        { block: "lunch", candidateId: "c2", whyNote: "", durationMin: 60 },
      ]}],
    } as ItineraryPlan;
    const errors = validatePlan(plan, [a, b], 1, trip.startDate);
    expect(errors.some((e) => e.includes("spans"))).toBe(false);
  });
});

describe("haversineKm", () => {
  it("computes ~0 for identical points and a sane city-scale distance", () => {
    expect(haversineKm({ lat: 38.7, lng: -9.14 }, { lat: 38.7, lng: -9.14 })).toBeCloseTo(0);
    const km = haversineKm({ lat: 38.7071, lng: -9.1355 }, { lat: 38.7223, lng: -9.1393 });
    expect(km).toBeGreaterThan(1);
    expect(km).toBeLessThan(3);
  });
});

describe("travelWarnings", () => {
  it("flags a leg longer than 5 km", () => {
    const far = cand("c2", 39.0, -9.14); // ~33 km north — a real transfer
    const byId = new Map([["c1", cand("c1")], ["c2", far]]);
    const plan = {
      days: [{ dayIndex: 0, blocks: [
        { block: "morning", candidateId: "c1", whyNote: "", durationMin: 60 },
        { block: "lunch", candidateId: "c2", whyNote: "", durationMin: 60 },
      ]}],
    } as ItineraryPlan;
    expect(travelWarnings(plan, byId)).toEqual(new Set(["c2"]));
  });
});

describe("filterSwapCandidates", () => {
  it("keeps only unused, open venues in the same area and near the day's other stops", () => {
    const sameArea = cand("same", 38.71, -9.14);
    const used = cand("used", 38.71, -9.14);
    const wrongArea = cand("porto", 38.71, -9.14, { area: "Porto" });
    const far = cand("far", 40.1, -9.14);
    const closed = cand("closed", 38.71, -9.14, { openingPeriods: [] });
    const allowed = filterSwapCandidates({
      candidates: [sameArea, used, wrongArea, far, closed],
      usedIds: new Set(["used"]),
      area: "Lisbon",
      otherDayStops: [cand("neighbor")],
      startDate: trip.startDate,
      dayIndex: 0,
      block: "morning",
    });
    expect(allowed.map((c) => c.placeId)).toEqual(["same"]);
  });
});

describe("isOpenForBlock", () => {
  it("requires the full visit duration to fit before closing", () => {
    const restaurant = cand("dinner", 38.7, -9.14, {
      openingPeriods: [{
        open: { day: 4, hour: 18, minute: 0 },
        close: { day: 4, hour: 20, minute: 0 },
      }],
    });
    expect(isOpenForBlock(restaurant, trip.startDate, 0, "dinner", 60)).toBe(true);
    expect(isOpenForBlock(restaurant, trip.startDate, 0, "dinner", 120)).toBe(false);
  });

  it("handles opening periods that cross the end of the week", () => {
    const late = cand("late", 38.7, -9.14, {
      openingPeriods: [{
        open: { day: 6, hour: 20, minute: 0 },
        close: { day: 0, hour: 2, minute: 0 },
      }],
    });
    expect(isOpenForBlock(late, "2026-09-13", 0, "morning", 30)).toBe(false);
    expect(isOpenForBlock(late, "2026-09-12", 0, "evening", 90)).toBe(true);
  });
});

describe("venue aliases", () => {
  /** Real candidate ids are UUIDs; the model could not copy them. */
  const uuidCandidates = [
    cand("78380144-3f6e-4a1e-9c2a-111111111111", 38.7, -9.14, { name: "Castle" }),
    cand("d5d8ec03-9b21-4f7a-8e3d-222222222222", 38.7, -9.14, {
      name: "Trattoria", category: "restaurant", categories: ["restaurant"],
    }),
    cand("2ee129e3-77aa-4c55-b0f1-333333333333", 38.7, -9.14, { name: "Museum" }),
    cand("6a7a166d-1234-4bcd-9999-444444444444", 38.7, -9.14, {
      name: "Bistro", category: "restaurant", categories: ["restaurant"],
    }),
  ];

  it("gives every venue a handle short enough to copy exactly", () => {
    const { aliasFor, placeIdFor } = venueAliases(uuidCandidates);
    expect(aliasFor.get("78380144-3f6e-4a1e-9c2a-111111111111")).toBe("v1");
    expect(placeIdFor.get("v1")).toBe("78380144-3f6e-4a1e-9c2a-111111111111");
    expect(placeIdFor.get("v4")).toBe("6a7a166d-1234-4bcd-9999-444444444444");
  });

  it("keeps UUIDs out of the prompt entirely", () => {
    const prompt = buildPrompt({ trip, travelers, candidates: uuidCandidates });
    expect(prompt).not.toContain("78380144-3f6e-4a1e-9c2a-111111111111");
    expect(prompt).toContain("v1 |");
  });

  it("states the block order the code actually plans, not a copy of it", () => {
    // The list used to be prose. PLANNED_BLOCKS could change and the prompt would
    // keep confidently naming the old slots, which the model has no way to doubt.
    const prompt = buildPrompt({ trip, travelers, candidates: [cand("a1", 43.55, 7.01)] });

    expect(prompt).toContain(`Blocks run in this order: ${PLANNED_BLOCKS.join(", ")}.`);
    expect(prompt).toContain("Blocks run in this order: morning, afternoon, dinner, evening.");
  });

  it("offers each day only its own area, so mixing towns is impossible", () => {
    // The model returned days spanning Example Coast, Nice and Saint-Tropez however
    // the rule was worded. Now a day is shown one area and nothing else.
    const mixed = [
      cand("a1", 43.55, 7.01, { name: "Croisette", area: "Example Coast", distanceKm: 0 }),
      cand("a2", 43.70, 7.26, { name: "Promenade", area: "Nice", distanceKm: 20 }),
      cand("a3", 43.55, 7.02, { name: "Le Suquet", area: "Example Coast", distanceKm: 0 }),
    ];
    const prompt = buildPrompt({ trip, travelers, candidates: mixed });

    expect(prompt).toContain("## DAY 0 — Example Coast");
    // Day 0 is a base day, so the Nice venue is not among its options at all.
    const day0 = prompt.slice(prompt.indexOf("## DAY 0"), prompt.indexOf("## DAY 1"));
    expect(day0).toContain("Croisette");
    expect(day0).not.toContain("Promenade");
  });

  it("never offers a venue that is closed at that slot", () => {
    // The check existed only after the fact: the model read "Monday: 10:00 AM –
    // 6:00 PM" from a list of 180 and was marked wrong for guessing.
    const closedForDinner = cand("shut", 38.7, -9.14, {
      name: "Lunch Only Bistro",
      category: "restaurant",
      categories: ["restaurant"],
      openingPeriods: [
        { open: { day: 4, hour: 8, minute: 0 }, close: { day: 4, hour: 17, minute: 0 } },
      ],
    });
    const openLate = cand("late", 38.7, -9.14, {
      name: "Evening Trattoria",
      category: "restaurant",
      categories: ["restaurant"],
    });
    const options = buildDayOptions({
      candidates: [closedForDinner, openLate], dayCount: 1, startDate: trip.startDate,
    });
    const dinner = options[0].blocks.find((b) => b.block === "dinner")!;

    // It may still be offered for a slot it is open for — just never for dinner.
    expect(dinner.options.map((c) => c.name)).toEqual(["Evening Trattoria"]);
  });

  it("offers only food for dinner", () => {
    const park = cand("park", 38.7, -9.14, { name: "Big Park", category: "nature", categories: ["nature"] });
    const bistro = cand("bistro", 38.7, -9.14, {
      name: "Corner Bistro", category: "restaurant", categories: ["restaurant"],
    });
    const options = buildDayOptions({
      candidates: [park, bistro], dayCount: 1, startDate: trip.startDate,
    });
    const dinner = options[0].blocks.find((b) => b.block === "dinner")!;

    expect(dinner.options.map((c) => c.name)).toEqual(["Corner Bistro"]);
  });

  it("deals venues out between days, so a trip cannot repeat itself", () => {
    const pool = Array.from({ length: 6 }, (_, i) =>
      cand(`p${i}`, 38.7, -9.14, {
        name: `Spot ${i}`, category: "restaurant", categories: ["restaurant"],
      }),
    );
    const options = buildDayOptions({ candidates: pool, dayCount: 3, startDate: trip.startDate });
    const offered = options.flatMap((d) => d.blocks.flatMap((b) => b.options.map((c) => c.placeId)));

    expect(new Set(offered).size).toBe(offered.length);
  });

  it("marks a slot with nothing available rather than offering something invalid", () => {
    const sightOnly = cand("s1", 38.7, -9.14, { name: "Ruins", category: "history", categories: ["history"] });
    const prompt = buildPrompt({ trip, travelers, candidates: [sightOnly] });

    expect(prompt).toContain("dinner: (nothing available — leave this block out)");
  });

  it("translates a plan written in aliases back to real ids", () => {
    const { placeIdFor } = venueAliases(uuidCandidates);
    const aliased = {
      days: [{
        dayIndex: 0,
        area: "Lisbon",
        blocks: [
          { block: "lunch" as const, candidateId: "v2", whyNote: "w", durationMin: 60 },
          { block: "dinner" as const, candidateId: "v4", whyNote: "w", durationMin: 90 },
        ],
      }],
    };
    const resolved = resolveAliases(aliased, placeIdFor);
    expect(resolved.days[0].blocks.map((b) => b.candidateId)).toEqual([
      "d5d8ec03-9b21-4f7a-8e3d-222222222222",
      "6a7a166d-1234-4bcd-9999-444444444444",
    ]);
  });

  it("leaves an invented handle alone so validation still rejects it", () => {
    // Silently dropping an unknown id would hand the group a plan with a
    // missing stop instead of an error naming the problem.
    const { placeIdFor } = venueAliases(uuidCandidates);
    const invented = {
      days: [{
        dayIndex: 0,
        area: "Lisbon",
        blocks: [
          { block: "lunch" as const, candidateId: "v999", whyNote: "w", durationMin: 60 },
          { block: "dinner" as const, candidateId: "v4", whyNote: "w", durationMin: 90 },
        ],
      }],
    };
    const resolved = resolveAliases(invented, placeIdFor);
    expect(resolved.days[0].blocks[0].candidateId).toBe("v999");
    expect(validatePlan(resolved, uuidCandidates, 1, trip.startDate).join(" "))
      .toContain('Unknown candidateId "v999"');
  });

  it("accepts a whole plan answered in aliases, which is what broke Example Coast", async () => {
    // The model returned truncated UUIDs, every stop was rejected as unknown,
    // both attempts failed, and the time budget was gone before the fallback.
    const aliasPlan = JSON.stringify({
      days: [{
        dayIndex: 0,
        area: "Lisbon",
        blocks: [
          { block: "lunch", candidateId: "v2", whyNote: "w", durationMin: 60 },
          { block: "dinner", candidateId: "v4", whyNote: "w", durationMin: 90 },
        ],
      }],
    });
    const callers = { primary: vi.fn().mockResolvedValue(aliasPlan), fallback: vi.fn() };
    const { plan } = await arrangePlan({
      trip: { ...trip, dayCount: 1 }, travelers, candidates: uuidCandidates, callers,
    });

    expect(callers.primary).toHaveBeenCalledTimes(1);
    expect(plan.days[0].blocks.map((b) => b.candidateId)).toEqual([
      "d5d8ec03-9b21-4f7a-8e3d-222222222222",
      "6a7a166d-1234-4bcd-9999-444444444444",
    ]);
  });
});

describe("arrangePlan", () => {
  it("returns the plan from the primary on the first valid answer", async () => {
    const callers = {
      primary: vi.fn().mockResolvedValue(planJson([...validIds])),
      fallback: vi.fn(),
    };
    const { plan, usedFallback } = await arrangePlan({ trip, travelers, candidates, callers });
    expect(usedFallback).toBe(false);
    expect(plan.days).toHaveLength(2);
    expect(callers.primary).toHaveBeenCalledTimes(1);
  });

  it("retries the primary once with validation errors, then succeeds", async () => {
    const callers = {
      primary: vi.fn()
        .mockResolvedValueOnce(planJson(["cX", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]))
        .mockResolvedValueOnce(planJson([...validIds])),
      fallback: vi.fn(),
    };
    const { usedFallback } = await arrangePlan({ trip, travelers, candidates, callers });
    expect(usedFallback).toBe(false);
    expect(callers.primary).toHaveBeenCalledTimes(2);
    const retryPrompt = callers.primary.mock.calls[1][0] as string;
    expect(retryPrompt).toContain("cX"); // errors fed back
  });

  it("falls back to the fallback model when the primary keeps failing validation", async () => {
    const callers = {
      primary: vi.fn().mockResolvedValue(planJson(["cX", "c2", "c3", "c4", "c5", "c6", "c7", "c8"])),
      fallback: vi.fn().mockResolvedValue(planJson([...validIds])),
    };
    const { usedFallback } = await arrangePlan({ trip, travelers, candidates, callers });
    expect(usedFallback).toBe(true);
  });

  it("falls back when the primary throws (transport error)", async () => {
    const callers = {
      primary: vi.fn().mockRejectedValue(new Error("timeout")),
      fallback: vi.fn().mockResolvedValue(planJson([...validIds])),
    };
    const { usedFallback } = await arrangePlan({ trip, travelers, candidates, callers });
    expect(usedFallback).toBe(true);
    expect(callers.primary).toHaveBeenCalledTimes(1); // no retry after transport error
  });

  it("fails rather than substituting a plan built without a model", async () => {
    // A plan was briefly assembled in code here — valid, but ranked on rating
    // alone, and returned 200 like a real success, so a group could be handed a
    // mechanical itinerary without being told. Product decision: say it failed.
    const callers = {
      primary: vi.fn().mockResolvedValue("not json"),
      fallback: vi.fn().mockResolvedValue("still not json"),
    };
    await expect(
      arrangePlan({ trip, travelers, candidates, callers }),
    ).rejects.toThrow(/PLAN_GENERATION_FAILED/);
  });

  it("carries why both models were turned down into the failure", async () => {
    // The reason is the actionable half. "The model named a venue we never
    // offered" and "the model answered nothing usable" need different responses,
    // and the person who pressed the button is the one who has to choose.
    const callers = {
      primary: vi.fn().mockResolvedValue(planJson(["cX", "c2", "c3", "c4", "c5", "c6", "c7", "c8"])),
      fallback: vi.fn().mockResolvedValue(planJson(["cX", "c2", "c3", "c4", "c5", "c6", "c7", "c8"])),
    };
    await expect(
      arrangePlan({ trip, travelers, candidates, callers }),
    ).rejects.toThrow(/cX/);
  });
});

describe("buildPrompt suggestions", () => {
  it("attributes member suggestions and tells the planner to prioritize matching venues", () => {
    const prompt = buildPrompt({
      trip,
      travelers,
      candidates,
      suggestions: [{ displayName: "Blair", text: "Visit the Blue Eye" }],
    });
    expect(prompt).toContain("Blair: Visit the Blue Eye");
    expect(prompt).toContain("Treat member suggestions as strong requests");
    expect(prompt).toContain("Never invent a place");
  });
});

describe("arrangeSwap", () => {
  it("returns a validated swap from the primary", async () => {
    const callers = {
      primary: vi.fn().mockResolvedValue('{"candidateId":"c3","whyNote":"better fit","durationMin":90}'),
      fallback: vi.fn(),
    };
    const { swap, usedFallback } = await arrangeSwap({
      trip, travelers, allowed: [cand("c3"), cand("c4")], block: "lunch", dayIndex: 0, callers,
    });
    expect(usedFallback).toBe(false);
    expect(swap.candidateId).toBe("c3");
  });

  it("uses the fallback when the primary picks a disallowed venue", async () => {
    const callers = {
      primary: vi.fn().mockResolvedValue('{"candidateId":"c9","whyNote":"x","durationMin":90}'),
      fallback: vi.fn().mockResolvedValue('{"candidateId":"c4","whyNote":"y","durationMin":60}'),
    };
    const { swap, usedFallback } = await arrangeSwap({
      trip, travelers, allowed: [cand("c3"), cand("c4")], block: "lunch", dayIndex: 0, callers,
    });
    expect(usedFallback).toBe(true);
    expect(swap.candidateId).toBe("c4");
  });
});

describe("arrangePlan budget", () => {
  const badPlan = () => planJson(["cX", "c2", "c3", "c4", "c5", "c6", "c7", "c8"]); // fails validation
  const goodPlan = () => planJson([...validIds]);
  const ATTEMPT = 100_000;

  /** A model call that costs its full slot, so the budget actually depletes. */
  function slowCaller(answer: () => string) {
    return vi.fn().mockImplementation(async () => {
      vi.setSystemTime(Date.now() + ATTEMPT);
      return answer();
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 7, 17, 12, 0, 0));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("gives the fallback its turn even when the primary has failed", async () => {
    // The Example Coast failure: two rejected GLM attempts spent the whole budget and
    // the stronger model — there for exactly this — was never called once.
    // With room for two attempts and the first already spent, the remaining
    // slot must go to the fallback rather than a second primary try.
    const callers = { primary: slowCaller(badPlan), fallback: slowCaller(goodPlan) };
    const { usedFallback } = await arrangePlan({
      trip, travelers, candidates, callers,
      budget: { endsAt: Date.now() + ATTEMPT * 2, attemptMs: ATTEMPT },
    });

    expect(usedFallback).toBe(true);
    expect(callers.primary).toHaveBeenCalledTimes(1);
    expect(callers.fallback).toHaveBeenCalledTimes(1);
  });

  it("retries the primary only when a fallback still fits afterwards", async () => {
    const callers = { primary: slowCaller(badPlan), fallback: slowCaller(goodPlan) };
    const { usedFallback } = await arrangePlan({
      trip, travelers, candidates, callers,
      budget: { endsAt: Date.now() + ATTEMPT * 3, attemptMs: ATTEMPT },
    });

    expect(callers.primary).toHaveBeenCalledTimes(2);
    expect(usedFallback).toBe(true);
  });

  it("fails cleanly, naming the rejections, when nothing more fits", async () => {
    const callers = {
      primary: vi.fn().mockResolvedValue(badPlan()),
      fallback: vi.fn().mockResolvedValue(goodPlan()),
    };
    await expect(
      arrangePlan({
        trip, travelers, candidates, callers,
        budget: { endsAt: Date.now() - 1, attemptMs: ATTEMPT },
      }),
    ).rejects.toThrow(/PLAN_GENERATION_TIMEOUT[\s\S]*rejected because/);

    expect(callers.primary).toHaveBeenCalledTimes(1);
    expect(callers.fallback).not.toHaveBeenCalled();
  });

  it("never calls a model at all when the primary already succeeded", async () => {
    const callers = {
      primary: vi.fn().mockResolvedValue(goodPlan()),
      fallback: vi.fn(),
    };
    const { usedFallback } = await arrangePlan({
      trip, travelers, candidates, callers,
      budget: { endsAt: Date.now() + ATTEMPT * 3, attemptMs: ATTEMPT },
    });

    expect(usedFallback).toBe(false);
    expect(callers.primary).toHaveBeenCalledTimes(1);
    expect(callers.fallback).not.toHaveBeenCalled();
  });

  it("gives the last attempt every second still on the clock", async () => {
    // The per-attempt slice came from day count alone, so a 7-day trip was
    // allowed 118s while a 13-day one got 202s and finished in 166. The shorter
    // trip was cut off for being shorter. The fallback has nothing to save time
    // for, so it gets whatever is left.
    const timeouts: number[] = [];
    // Quick primary attempts, so most of the budget is still unspent when the
    // fallback starts — the case where the old fixed slice wasted time.
    const callers = {
      primary: vi.fn().mockResolvedValue(badPlan()),
      fallback: vi.fn().mockResolvedValue(goodPlan()),
    };
    await arrangePlan({
      trip, travelers, candidates, callers,
      budget: { endsAt: Date.now() + ATTEMPT * 3, attemptMs: ATTEMPT },
      makeCallers: (ms) => {
        timeouts.push(ms);
        return callers;
      },
    });

    // Primary attempts stay capped at one slot; the fallback takes what is left.
    expect(timeouts.slice(0, 2)).toEqual([ATTEMPT, ATTEMPT]);
    expect(timeouts[2]).toBe(ATTEMPT * 3);
  });

  it("never lets an attempt outlive the budget", async () => {
    const timeouts: number[] = [];
    const callers = { primary: slowCaller(badPlan), fallback: slowCaller(goodPlan) };
    await arrangePlan({
      trip, travelers, candidates, callers,
      // Less than one full slot left from the start.
      budget: { endsAt: Date.now() + ATTEMPT / 2, attemptMs: ATTEMPT },
      makeCallers: (ms) => {
        timeouts.push(ms);
        return callers;
      },
    }).catch(() => {});

    for (const ms of timeouts) expect(ms).toBeLessThanOrEqual(ATTEMPT / 2);
  });

  it("behaves exactly as before when no budget is given", async () => {
    const callers = {
      primary: vi.fn().mockResolvedValue(goodPlan()),
      fallback: vi.fn(),
    };
    const { plan, usedFallback } = await arrangePlan({ trip, travelers, candidates, callers });
    expect(usedFallback).toBe(false);
    expect(plan.days).toHaveLength(2);
  });
});

describe("a day whose area cannot serve dinner", () => {
  // Dinner is the only required block, so such a day invalidates the whole plan.
  // A requested town now becomes a day trip because the group asked for it, not
  // because of how much it has open, so a village with no restaurant would
  // otherwise sink the generation outright now that nothing rescues it.
  const base = "Example Coast";
  const cityVenues = [
    cand("c-eat", 43.55, 7.01, { name: "Example Coast Bistro", area: base, category: "restaurant", categories: ["restaurant"] }),
    cand("c-eat2", 43.55, 7.01, { name: "Example Coast Cantina", area: base, category: "restaurant", categories: ["restaurant"] }),
    cand("c-see", 43.55, 7.01, { name: "Croisette", area: base }),
    cand("c-see2", 43.55, 7.01, { name: "Le Suquet", area: base }),
  ];

  it("falls back to the base rather than leaving the day without a meal", () => {
    // Théoule has a viewpoint and nowhere to eat.
    const village = cand("v-see", 43.51, 6.94, {
      name: "Village Viewpoint", area: "Théoule-sur-Mer", category: "nature", categories: ["nature"],
    });
    const options = buildDayOptions({
      candidates: [...cityVenues, village], dayCount: 2, startDate: "2026-08-22",
    });

    expect(options[1].area).toBe(base);
    expect(options[1].blocks.find((b) => b.block === "dinner")!.options).not.toHaveLength(0);
  });

  it("keeps an area that can serve dinner", () => {
    const town = [
      cand("t-eat", 43.58, 7.12, { name: "Antibes Table", area: "Antibes", category: "restaurant", categories: ["restaurant"] }),
      cand("t-see", 43.58, 7.12, { name: "Antibes Ramparts", area: "Antibes" }),
    ];
    const options = buildDayOptions({
      candidates: [...cityVenues, ...town], dayCount: 2, startDate: "2026-08-22",
    });

    expect(options[1].area).toBe("Antibes");
  });
});

describe("area outliers", () => {
  it("drops a venue that is tagged with an area but nowhere near it", () => {
    // The Example Coast pool contained a venue 9,817 km away, labelled "Example Coast" like
    // the rest, because locationBias biases rather than restricts. One of those
    // ranking well breaks the day-spread rule and sinks the whole plan.
    const local = [
      cand("n1", 43.55, 7.01, { name: "Croisette", area: "Example Coast" }),
      cand("n2", 43.56, 7.02, { name: "Le Suquet", area: "Example Coast" }),
      cand("n3", 43.54, 7.00, { name: "Old Port", area: "Example Coast", category: "restaurant", categories: ["restaurant"] }),
    ];
    const faraway = cand("far", -33.86, 151.2, {
      name: "Example Coast Bar Sydney", area: "Example Coast", rating: 5, reviewCount: 99999,
    });

    const options = buildDayOptions({
      candidates: [...local, faraway], dayCount: 1, startDate: trip.startDate,
    });
    const offered = options[0].blocks.flatMap((b) => b.options.map((c) => c.name));

    // It outranks everything local and would have been picked first.
    expect(offered).not.toContain("Example Coast Bar Sydney");
    expect(offered).toContain("Croisette");
  });

  it("keeps every venue in an area close enough to share a day", () => {
    const spread = [
      cand("a", 43.55, 7.01, { area: "Example Coast", category: "restaurant", categories: ["restaurant"] }),
      cand("b", 43.60, 7.10, { area: "Example Coast" }),
      cand("c", 44.30, 7.90, { area: "Example Coast" }), // ~100 km out
    ];
    const options = buildDayOptions({ candidates: spread, dayCount: 1, startDate: trip.startDate });
    const chosen = options[0].blocks.flatMap((b) => b.options);

    for (const x of chosen) {
      for (const y of chosen) expect(haversineKm(x, y)).toBeLessThanOrEqual(MAX_DAY_SPREAD_KM);
    }
  });
})

describe("offered stays match booked stays", () => {
  it("does not offer a venue that closes before the stay is over", () => {
    // The filter asked for 60 minutes and the assembler then booked 120, so a
    // venue open for exactly an hour was offered and then rejected by the very
    // check that offered it. Every assembled plan failed this way.
    const shortWindow = cand("brief", 38.7, -9.14, {
      name: "Closes At Ten",
      openingPeriods: [
        // Thursday 09:00–10:00 — covers a morning start, not a morning stay.
        { open: { day: 4, hour: 9, minute: 0 }, close: { day: 4, hour: 10, minute: 0 } },
      ],
    });
    const options = buildDayOptions({
      candidates: [shortWindow], dayCount: 1, startDate: trip.startDate,
    });
    const morning = options[0].blocks.find((b) => b.block === "morning")!;

    expect(morning.options.map((c) => c.name)).not.toContain("Closes At Ten");
  });

  it("guarantees every day a dinner before any optional slot takes a venue", () => {
    // Two restaurants and two days: the first day's morning slot accepts any
    // venue, so without reserving dinner first it would take one and leave the
    // second day unplannable.
    const pool = [
      cand("m1", 38.7, -9.14, { name: "Gallery", area: "Lisbon" }),
      cand("d1", 38.7, -9.14, {
        name: "Taverna", area: "Lisbon", category: "restaurant", categories: ["restaurant"],
      }),
      cand("d2", 38.7, -9.14, {
        name: "Cantina", area: "Lisbon", category: "restaurant", categories: ["restaurant"],
      }),
    ];
    const options = buildDayOptions({ candidates: pool, dayCount: 2, startDate: trip.startDate });

    for (const day of options) {
      expect(day.blocks.find((b) => b.block === "dinner")!.options).not.toHaveLength(0);
    }
  });
})

describe("the prompt and the resolver agree on what an id means", () => {
  // Closed at every slot, so it is never offered — but it sits first in the
  // candidate pool, so a resolver rebuilding its own map would call it "v1".
  const neverOffered = cand("ghost", 38.7, -9.14, {
    name: "Shut All Week",
    openingPeriods: [{ open: { day: 1, hour: 3, minute: 0 }, close: { day: 1, hour: 4, minute: 0 } }],
  });
  const dinner = cand("din", 38.7, -9.14, {
    name: "Taverna", area: "Lisbon", category: "restaurant", categories: ["restaurant"],
  });
  const sight = cand("see", 38.7, -9.14, { name: "Cathedral", area: "Lisbon" });
  const pool = [neverOffered, dinner, sight];

  it("resolves an alias to the venue the prompt offered under it", () => {
    const { aliasFor, placeIdFor } = venueAliases(
      buildDayOptions({ candidates: pool, dayCount: 1, startDate: trip.startDate })
        .flatMap((d) => d.blocks.flatMap((b) => b.options)),
    );

    expect(aliasFor.has("ghost")).toBe(false);
    expect(placeIdFor.get("v1")).not.toBe("ghost");
    // Rebuilding from the whole pool is what used to happen, and disagrees.
    expect(venueAliases(pool).placeIdFor.get("v1")).toBe("ghost");
  });

  it("keeps a correct answer correct, end to end", async () => {
    // The model picks the first venue offered for dinner. Under the old
    // mismatch this resolved to an unrelated venue and the plan was rejected
    // for an area or hours error the model never made.
    const options = buildDayOptions({ candidates: pool, dayCount: 1, startDate: trip.startDate });
    const { aliasFor } = venueAliases(options.flatMap((d) => d.blocks.flatMap((b) => b.options)));
    const dinnerOption = options[0].blocks.find((b) => b.block === "dinner")!.options[0];

    const answer = JSON.stringify({
      days: [{
        dayIndex: 0,
        area: "Lisbon",
        blocks: [{
          block: "dinner",
          candidateId: aliasFor.get(dinnerOption.placeId),
          whyNote: "w",
          durationMin: 90,
        }],
      }],
    });
    const callers = { primary: vi.fn().mockResolvedValue(answer), fallback: vi.fn() };
    const { plan, usedFallback } = await arrangePlan({
      trip: { ...trip, dayCount: 1 }, travelers, candidates: pool, callers,
    });

    expect(usedFallback).toBe(false); // the model's own answer was accepted
    expect(plan.days[0].blocks[0].candidateId).toBe(dinnerOption.placeId);
  });
})
