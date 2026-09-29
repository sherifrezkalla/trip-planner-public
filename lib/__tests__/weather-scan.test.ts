import { describe, expect, it } from "vitest";
import { planWeatherSwaps, type ScannableCandidate, type ScannableItem } from "@/lib/weather-scan";
import { dayThreatensOutdoorPlans, parseDailyForecast, type DayOutlook } from "@/lib/weather";

function outlook(over: Partial<DayOutlook> = {}): DayOutlook {
  return {
    date: "2026-08-24",
    maxPrecipitationProbability: 76,
    weatherCode: 51,
    temperatureMaxC: 30,
    severe: false,
    ...over,
  };
}

function item(over: Partial<ScannableItem> = {}): ScannableItem {
  return {
    id: "item-1", dayIndex: 2, block: "afternoon", area: "Monaco",
    candidateId: "square", candidateName: "Place du Palais", category: "history",
    exposure: "outdoor", isLocked: false, reservationStatus: "none", status: "planned",
    ...over,
  };
}

const museum: ScannableCandidate = {
  id: "museum", name: "Musée océanographique", area: "Monaco",
  category: "history", rating: 4.5, reviewCount: 9000, exposure: "indoor",
};
const gallery: ScannableCandidate = {
  id: "gallery", name: "Opera Gallery", area: "Monaco",
  category: "art", rating: 4.9, reviewCount: 400, exposure: "indoor",
};
const boutique: ScannableCandidate = {
  id: "boutique", name: "Vilebrequin La Plage", area: "Monaco",
  category: "shopping", rating: 5, reviewCount: 40, exposure: "indoor",
};
const brasserie: ScannableCandidate = {
  id: "brasserie", name: "Chez Pierre", area: "Monaco",
  category: "food", rating: 4.4, reviewCount: 1200, exposure: "indoor",
};

function scan(over: Partial<Parameters<typeof planWeatherSwaps>[0]> = {}) {
  return planWeatherSwaps({
    items: [item()],
    candidates: [museum, gallery],
    outlookByDayIndex: new Map([[2, outlook()]]),
    alreadyPlanned: [],
    ...over,
  });
}

describe("dayThreatensOutdoorPlans", () => {
  it("ignores a merely cloudy day", () => {
    expect(dayThreatensOutdoorPlans(outlook({ maxPrecipitationProbability: 30, weatherCode: 2 })))
      .toBe(false);
  });

  it("acts on a high chance of rain, or on rain itself, or on storms", () => {
    expect(dayThreatensOutdoorPlans(outlook({ maxPrecipitationProbability: 60 }))).toBe(true);
    expect(dayThreatensOutdoorPlans(outlook({ maxPrecipitationProbability: 10, weatherCode: 63 })))
      .toBe(true);
    expect(dayThreatensOutdoorPlans(outlook({ maxPrecipitationProbability: 0, severe: true })))
      .toBe(true);
  });
});

describe("planWeatherSwaps", () => {
  it("prefers the better-rated destination", () => {
    const [swap] = scan();
    expect(swap.replacement.id).toBe("gallery"); // art and history both rank as destinations; 4.9 > 4.5
    expect(swap.reason).toBe("2026-08-24: 76% chance of rain. Indoors instead of Place du Palais.");
  });

  /**
   * The swap this rule exists to stop: a five-star swimwear shop with forty
   * reviews beat a museum for a rained-out beach morning on the test trip.
   */
  it("refuses a highly rated venue almost nobody has reviewed", () => {
    expect(scan({ candidates: [boutique] })).toEqual([]);
  });

  it("ranks retail below a destination even when it clears the floor", () => {
    const shop = { ...boutique, reviewCount: 5000 };
    expect(scan({ candidates: [shop, museum] })[0].replacement.id).toBe("museum");
    // Still offered when it is the only thing indoors nearby.
    expect(scan({ candidates: [shop] })[0].replacement.id).toBe("boutique");
  });

  /** A museum is not a dinner, whatever the forecast says. */
  it("replaces a meal with a meal, or not at all", () => {
    const dinner = item({ block: "dinner", candidateName: "Beach restaurant" });
    expect(scan({ items: [dinner], candidates: [brasserie, museum] })[0].replacement.id)
      .toBe("brasserie");
    expect(scan({ items: [dinner], candidates: [museum, gallery] })).toEqual([]);
  });

  it("proposes nothing rather than something poor", () => {
    expect(scan({ candidates: [{ ...museum, reviewCount: 3 }] })).toEqual([]);
  });

  it("leaves an indoor activity alone on a wet day", () => {
    expect(scan({ items: [item({ exposure: "indoor" })] })).toEqual([]);
  });

  /** A roofed market is fine in drizzle; only a storm should move it. */
  it("moves a covered venue only for thunderstorms", () => {
    expect(scan({ items: [item({ exposure: "covered" })] })).toEqual([]);
    expect(scan({
      items: [item({ exposure: "covered" })],
      outlookByDayIndex: new Map([[2, outlook({ severe: true })]]),
    })).toHaveLength(1);
  });

  /** Unclassified is skipped, never guessed. */
  it("skips a venue that was never classified", () => {
    expect(scan({ items: [item({ exposure: null })] })).toEqual([]);
  });

  it("respects everything the proposal flow would refuse anyway", () => {
    expect(scan({ items: [item({ isLocked: true })] })).toEqual([]);
    expect(scan({ items: [item({ reservationStatus: "confirmed" })] })).toEqual([]);
    expect(scan({ items: [item({ status: "done" })] })).toEqual([]);
  });

  it("does nothing on a dry day", () => {
    expect(scan({ outlookByDayIndex: new Map([[2, outlook({ maxPrecipitationProbability: 5, weatherCode: 1 })]]) }))
      .toEqual([]);
  });

  it("will not propose a venue the plan already holds", () => {
    expect(scan({ alreadyPlanned: ["museum"] })[0].replacement.id).toBe("gallery");
    expect(scan({ alreadyPlanned: ["museum", "gallery"] })).toEqual([]);
  });

  /** Two wet slots on one day must not both be sent to the same museum. */
  it("never sends two activities to the same replacement", () => {
    const swaps = scan({
      items: [item(), item({ id: "item-2", block: "morning", candidateId: "gardens" })],
    });
    expect(swaps).toHaveLength(2);
    expect(swaps[0].replacement.id).not.toBe(swaps[1].replacement.id);
  });

  it("will not send the group to another town", () => {
    expect(scan({ candidates: [{ ...museum, area: "Nice" }] })).toEqual([]);
  });
});

describe("parseDailyForecast", () => {
  it("reads the provider's daily block", () => {
    expect(parseDailyForecast({
      daily: {
        time: ["2026-08-24", "2026-08-25"],
        weather_code: [95, 51],
        temperature_2m_max: [24.4, 31.2],
        precipitation_probability_max: [71, null],
      },
    })).toEqual([
      { date: "2026-08-24", maxPrecipitationProbability: 71, weatherCode: 95, temperatureMaxC: 24, severe: true },
      { date: "2026-08-25", maxPrecipitationProbability: 0, weatherCode: 51, temperatureMaxC: 31, severe: false },
    ]);
  });

  it("drops a day the provider could not answer", () => {
    expect(parseDailyForecast({
      daily: { time: ["2026-08-24"], weather_code: [null], temperature_2m_max: [20], precipitation_probability_max: [10] },
    })).toEqual([]);
    expect(parseDailyForecast({})).toEqual([]);
  });
});
