import { describe, it, expect, vi } from "vitest";
import { buildAreaPrompt, parseAreas, proposeAreas, areaBudget, MAX_AREAS } from "@/lib/areas";
import type { Callers } from "@/lib/llm";

const BASE = { name: "Vlorë", lat: 40.4661, lng: 19.4914 };

function callersReturning(text: string): Callers {
  return { primary: vi.fn().mockResolvedValue(text), fallback: vi.fn().mockResolvedValue(text) };
}

describe("buildAreaPrompt", () => {
  it("states the base, the radius and the group's interests", () => {
    const prompt = buildAreaPrompt({ base: BASE, radiusKm: 60, interests: ["food", "history"] });
    expect(prompt).toContain("Vlorë");
    expect(prompt).toContain("60");
    expect(prompt).toContain("food");
  });

  it("puts the group's own requests in front of the model verbatim", () => {
    const prompt = buildAreaPrompt({
      base: BASE, radiusKm: 60, interests: ["food"], requests: ["Himarë", "a good fish grill"],
    });
    expect(prompt).toContain("Himarë");
    expect(prompt).toContain("a good fish grill");
    // Translation has to be invited explicitly: "Nizza" must come back as Nice.
    expect(prompt).toContain("Translate");
  });

  it("says nothing about requests when there are none", () => {
    const prompt = buildAreaPrompt({ base: BASE, radiusKm: 60, interests: ["food"] });
    expect(prompt).not.toContain("explicitly asked");
  });
});

describe("parseAreas", () => {
  const valid = JSON.stringify({
    areas: [
      { name: "Himarë", lat: 40.1018, lng: 19.7449, why: "Riviera beaches" },
      { name: "Berat", lat: 40.7058, lng: 19.9522, why: "Ottoman old town" },
    ],
  });

  it("parses a valid area list", () => {
    expect(parseAreas(valid)).toEqual([
      { name: "Himarë", lat: 40.1018, lng: 19.7449, why: "Riviera beaches" },
      { name: "Berat", lat: 40.7058, lng: 19.9522, why: "Ottoman old town" },
    ]);
  });

  it("reads JSON wrapped in prose or code fences", () => {
    expect(parseAreas("Sure!\n```json\n" + valid + "\n```")).toHaveLength(2);
  });

  it("returns null when the output is not usable", () => {
    expect(parseAreas("no json here")).toBeNull();
    expect(parseAreas('{"areas":[{"name":"X"}]}')).toBeNull();
  });

  it(`caps the list at ${MAX_AREAS} areas`, () => {
    const many = {
      areas: Array.from({ length: MAX_AREAS + 5 }, (_, i) => ({
        name: `Area ${i}`, lat: 40 + i / 100, lng: 19 + i / 100, why: "reason",
      })),
    };
    expect(parseAreas(JSON.stringify(many))).toHaveLength(MAX_AREAS);
  });
});

describe("proposeAreas", () => {
  it("always includes the base itself as the first area", async () => {
    const callers = callersReturning(
      JSON.stringify({ areas: [{ name: "Himarë", lat: 40.1, lng: 19.74, why: "beaches" }] }),
    );
    const areas = await proposeAreas({ base: BASE, radiusKm: 60, interests: ["food"], callers });
    expect(areas[0]).toMatchObject({ name: "Vlorë" });
    expect(areas.map((a) => a.name)).toContain("Himarë");
  });

  it("falls back to the base alone when the model returns nothing usable", async () => {
    const callers = callersReturning("the model rambled without JSON");
    const areas = await proposeAreas({ base: BASE, radiusKm: 60, interests: ["food"], callers });
    expect(areas).toEqual([{ name: "Vlorë", lat: BASE.lat, lng: BASE.lng, why: "" }]);
  });

  it("falls back to the base alone when the model call throws", async () => {
    const callers: Callers = {
      primary: vi.fn().mockRejectedValue(new Error("timeout")),
      fallback: vi.fn().mockRejectedValue(new Error("timeout")),
    };
    const areas = await proposeAreas({ base: BASE, radiusKm: 60, interests: ["food"], callers });
    expect(areas).toHaveLength(1);
    expect(areas[0].name).toBe("Vlorë");
  });

  it("drops areas that fall outside the requested radius", async () => {
    // Sarandë is ~79km from Vlorë — beyond a 60km day-trip range.
    const callers = callersReturning(
      JSON.stringify({
        areas: [
          { name: "Himarë", lat: 40.1018, lng: 19.7449, why: "close" },
          { name: "Sarandë", lat: 39.8756, lng: 20.0053, why: "too far" },
        ],
      }),
    );
    const areas = await proposeAreas({ base: BASE, radiusKm: 60, interests: ["food"], callers });
    expect(areas.map((a) => a.name)).toEqual(["Vlorë", "Himarë"]);
  });
});

describe("proposeAreas honouring what the group asked for", () => {
  // A suggestion naming a town used to be searched as a venue near the base, so
  // "Monaco" produced a Example Coast boutique called APM Monaco Example Coast and the town was
  // never visited. A requested place now competes for the day-trip budget first.
  it("keeps a requested area even when nearer ones would fill the budget", async () => {
    const callers = callersReturning(
      JSON.stringify({
        areas: [
          { name: "Berat", lat: 40.7058, lng: 19.9522, why: "asked for", request: "Berat" },
          { name: "Himarë", lat: 40.1018, lng: 19.7449, why: "nearer" },
        ],
      }),
    );
    // Budget of one day trip, and the requested area is the further of the two.
    const areas = await proposeAreas({
      base: BASE, radiusKm: 60, interests: ["food"], callers, dayCount: 2, requests: ["Berat"],
    });

    expect(areas.map((a) => a.name)).toEqual(["Vlorë", "Berat"]);
  });

  it("carries the member's original wording through, translation included", async () => {
    const callers = callersReturning(
      JSON.stringify({
        areas: [{ name: "Himarë", lat: 40.1018, lng: 19.7449, why: "asked for", request: "Chimaera" }],
      }),
    );
    const areas = await proposeAreas({
      base: BASE, radiusKm: 60, interests: ["food"], callers, requests: ["Chimaera"],
    });

    // The caller needs the original text to know not to also search it as a venue.
    expect(areas[1]).toMatchObject({ name: "Himarë", request: "Chimaera" });
  });

  it("ignores a request the group never made", async () => {
    // Otherwise the model can mark every area as requested and take the whole
    // budget, which is exactly the priority the field grants.
    const callers = callersReturning(
      JSON.stringify({
        areas: [
          { name: "Berat", lat: 40.7058, lng: 19.9522, why: "invented", request: "Berat" },
          { name: "Himarë", lat: 40.1018, lng: 19.7449, why: "genuinely nearer" },
        ],
      }),
    );
    const areas = await proposeAreas({
      base: BASE, radiusKm: 60, interests: ["food"], callers, dayCount: 2, requests: ["somewhere else"],
    });

    // No real request, so the model's order stands and the budget takes the first.
    expect(areas.map((a) => a.name)).toEqual(["Vlorë", "Berat"]);
    expect(areas[1].request).toBeUndefined();
  });

  it("keeps every reachable request even past the budget, and stops adding its own", async () => {
    // Trimming a request is worse than losing the day trip: the caller then
    // searches it as a venue near the base, which is what put a massage parlour
    // in the pool for a group that asked for Saint-Tropez. The budget caps what
    // the model may add, not what the group may ask for.
    const callers = callersReturning(
      JSON.stringify({
        areas: [
          { name: "Himarë", lat: 40.1018, lng: 19.7449, why: "asked", request: "Himarë" },
          { name: "Orikum", lat: 40.3244, lng: 19.4714, why: "asked", request: "Orikum" },
          { name: "Radhimë", lat: 40.3733, lng: 19.4506, why: "asked", request: "Radhimë" },
          { name: "Kanina", lat: 40.4297, lng: 19.5183, why: "the model's own idea" },
        ],
      }),
    );
    const areas = await proposeAreas({
      base: BASE, radiusKm: 60, interests: ["food"], callers,
      dayCount: 2, // budget of one
      requests: ["Himarë", "Orikum", "Radhimë"],
    });

    expect(areas.map((a) => a.name)).toEqual(["Vlorë", "Himarë", "Orikum", "Radhimë"]);
    expect(areas.map((a) => a.name)).not.toContain("Kanina");
  });

  it("still refuses a requested area outside day-trip range", async () => {
    // Asking for it cannot make it reachable.
    const callers = callersReturning(
      JSON.stringify({
        areas: [{ name: "Sarandë", lat: 39.8756, lng: 20.0053, why: "asked for", request: "Sarandë" }],
      }),
    );
    const areas = await proposeAreas({
      base: BASE, radiusKm: 60, interests: ["food"], callers, requests: ["Sarandë"],
    });

    expect(areas.map((a) => a.name)).toEqual(["Vlorë"]);
  });
});

describe("areaBudget", () => {
  it("lets a week reach a handful of places, not a dozen", () => {
    // A synthetic regional trip is offered ten areas and 796 venues for seven days, and
    // the planner could not finish inside its time budget at all.
    expect(areaBudget(7)).toBe(4);
  });

  it("keeps a weekend to a single day trip", () => {
    expect(areaBudget(2)).toBe(1);
    expect(areaBudget(3)).toBe(2);
  });

  it("never proposes more than the hard ceiling on a long trip", () => {
    expect(areaBudget(30)).toBe(MAX_AREAS);
  });

  it("always leaves somewhere to go", () => {
    expect(areaBudget(1)).toBe(1);
    expect(areaBudget(0)).toBe(1);
  });
});
