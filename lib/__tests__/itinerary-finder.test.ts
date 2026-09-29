import { describe, expect, it } from "vitest";
import {
  findItineraryMatches,
  formatOccurrenceDate,
  lookupTokens,
  normalizeLookupText,
  tripDateForDayIndex,
  type ItineraryLookupItem,
} from "@/lib/itinerary-finder";

let counter = 0;
function item(overrides: Partial<ItineraryLookupItem>): ItineraryLookupItem {
  counter += 1;
  return {
    itemId: `item-${counter}`,
    candidateKey: `candidate-${counter}`,
    dayIndex: 0,
    date: "2026-08-07",
    block: "morning",
    status: "planned",
    name: "Old Town",
    area: "Vlorë",
    mapsUrl: "https://maps.example/old-town",
    categories: ["history"],
    ...overrides,
  };
}

describe("text normalization", () => {
  it("folds case, accents, and ß so stored names meet typed words", () => {
    expect(normalizeLookupText("  Musée Océanographique ")).toBe("musee oceanographique");
    expect(normalizeLookupText("Großer Garten")).toBe("grosser garten");
  });

  it("drops the question frame and singularizes plurals", () => {
    expect(lookupTokens("Where is the gym?")).toEqual(["gym"]);
    expect(lookupTokens("Where are the museums?")).toEqual(["museum"]);
    expect(lookupTokens("show me the beaches again")).toEqual(["beach"]);
    expect(lookupTokens("wo ist das Museum?")).toEqual(["museum"]);
  });

  it("keeps multi-word names as separate meaningful tokens", () => {
    expect(lookupTokens("when do we visit Musée Picasso")).toEqual(["visit", "musee", "picasso"]);
  });
});

describe("findItineraryMatches — name matching", () => {
  it("matches a venue by a distinctive name token", () => {
    const gyms = [item({ name: "Fitness First Antibes", categories: ["active"] })];
    const result = findItineraryMatches("where is Fitness First?", gyms, "Example Coast");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0]).toMatchObject({
      name: "Fitness First Antibes",
      area: "Vlorë",
      mapsUrl: "https://maps.example/old-town",
    });
  });

  it("matches across all days, not just day one", () => {
    const items = [
      item({ name: "Sunset Beach", categories: ["water"], dayIndex: 4, date: "2026-08-11" }),
    ];
    const result = findItineraryMatches("where is the beach?", items, "Vlorë");
    expect(result.matches[0].occurrences[0]).toMatchObject({ dayIndex: 4, date: "2026-08-11" });
  });

  it("matches a partial name token inside a longer question", () => {
    const items = [item({ name: "Musée Picasso", categories: ["art"] })];
    const result = findItineraryMatches("when do we visit picasso again?", items, "Antibes");
    expect(result.matches[0].name).toBe("Musée Picasso");
  });

  it("does not let two unrelated venues tie on a shared generic token alone", () => {
    const items = [
      item({ name: "Le Maschou", categories: ["restaurant"] }),
      item({ name: "La Plage", categories: ["water"] }),
    ];
    const result = findItineraryMatches("when is lunch at le maschou?", items, "Example Coast");
    expect(result.matches.map((match) => match.name)).toEqual(["Le Maschou"]);
  });
});

describe("findItineraryMatches — category and synonym matching", () => {
  it("resolves 'the gym' against the stored active category", () => {
    const items = [
      item({ name: "Salle d'Escalade", categories: ["active"] }),
      item({ name: "Blue Bay Beach", categories: ["water"] }),
    ];
    const result = findItineraryMatches("where is the gym?", items, "Antibes");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].name).toBe("Salle d'Escalade");
    expect(result.matches[0].categoryLabel).toBe("active");
  });

  it("resolves plurals like 'museums' and 'beaches' via singularized synonyms", () => {
    const items = [
      item({ name: "Picasso Museum", categories: ["history"] }),
      item({ name: "Plage du Midi", categories: ["water"] }),
    ];
    expect(findItineraryMatches("any museums on the plan?", items, "Example Coast").matches[0].name)
      .toBe("Picasso Museum");
    expect(findItineraryMatches("do we have beaches planned?", items, "Example Coast").matches[0].name)
      .toBe("Plage du Midi");
  });

  it("understands French synonyms without a translation step", () => {
    const items = [
      item({ name: "Château Grimaldi", categories: ["history"] }),
      item({ name: "Plage de la Garoupe", categories: ["water"] }),
    ];
    expect(findItineraryMatches("où est le château ?", items, "Antibes").matches[0].name)
      .toBe("Château Grimaldi");
    expect(findItineraryMatches("ou est la plage", items, "Antibes").matches[0].name)
      .toBe("Plage de la Garoupe");
    expect(findItineraryMatches("quand est-ce qu'on va au musee ?", items, "Antibes").matches[0].name)
      .toBe("Château Grimaldi");
  });

  it("understands German synonyms without a translation step", () => {
    const items = [
      item({ name: "Burg Eltz Day Trip", categories: ["history"] }),
      item({ name: "Fitnessloft", categories: ["active"] }),
    ];
    expect(findItineraryMatches("wo ist das Schloss?", items, "Koblenz").matches[0].name)
      .toBe("Burg Eltz Day Trip");
    expect(findItineraryMatches("wo ist das Fitnessstudio?", items, "Koblenz").matches[0].name)
      .toBe("Fitnessloft");
  });

  it("treats a purely generic ideas question as external search, not a locator", () => {
    const items = [item({ name: "Chez Marcel", categories: ["restaurant"] })];
    const result = findItineraryMatches("restaurant?", items, "Example Coast");
    expect(result.matches).toEqual([]);
  });

  it("still resolves a generic category when the question asks 'when are we eating there'", () => {
    const items = [item({ name: "Chez Marcel", categories: ["restaurant"] })];
    // "restaurant" alone is generic, but here a named token carries the match.
    expect(findItineraryMatches("when are we eating at Chez Marcel?", items, "Example Coast").matches[0].name)
      .toBe("Chez Marcel");
  });

  const genericIntentCases = [
    {
      label: "English restaurant",
      category: "restaurant",
      name: "Chez Marcel",
      locator: "Where is our restaurant?",
      discovery: "Find a restaurant nearby",
    },
    {
      label: "English boat-trip",
      category: "water",
      name: "Example Coast Boat Tour",
      locator: "When is our boat trip?",
      discovery: "Boat trips?",
    },
    {
      label: "French restaurant",
      category: "restaurant",
      name: "Chez Marcel",
      locator: "Où est notre restaurant ?",
      discovery: "Trouve un restaurant à proximité",
    },
    {
      label: "French boat-trip",
      category: "water",
      name: "Croisière Example Coast",
      locator: "Quand est notre excursion en bateau ?",
      discovery: "Excursions en bateau ?",
    },
    {
      label: "German restaurant",
      category: "restaurant",
      name: "Restaurant Hafenblick",
      locator: "Wo ist unser Restaurant?",
      discovery: "Finde ein Restaurant in der Nähe",
    },
    {
      label: "German boat-trip",
      category: "water",
      name: "Croisière Example Coast",
      locator: "Wann ist unsere Bootstour?",
      discovery: "Bootstouren?",
    },
  ];

  it.each(genericIntentCases)(
    "uses the itinerary for $label locator questions",
    ({ category, name, locator }) => {
      const result = findItineraryMatches(
        locator,
        [item({ name, categories: [category] })],
        "Example Coast",
      );

      expect(result.matches.map((match) => match.name)).toEqual([name]);
    },
  );

  it.each(genericIntentCases)(
    "keeps $label discovery questions on external search",
    ({ category, name, discovery }) => {
      const result = findItineraryMatches(
        discovery,
        [item({ name, categories: [category] })],
        "Example Coast",
      );

      expect(result.matches).toEqual([]);
    },
  );
});

describe("findItineraryMatches — duplicates, status, and dates", () => {
  it("groups occurrences that share a venue ID and keeps every slot", () => {
    const candidate = "candidate-gym";
    const items = [
      item({ name: "City Gym", candidateKey: candidate, dayIndex: 1, date: "2026-08-08", block: "morning" }),
      item({ name: "City Gym", candidateKey: candidate, dayIndex: 3, date: "2026-08-10", block: "evening", status: "done" }),
    ];
    const result = findItineraryMatches("where is the gym?", items, "Example Coast");
    expect(result.matches).toHaveLength(1);
    expect(result.matches[0].occurrences).toEqual([
      { dayIndex: 1, date: "2026-08-08", block: "morning", status: "planned" },
      { dayIndex: 3, date: "2026-08-10", block: "evening", status: "done" },
    ]);
  });

  it("keeps same-named venues separate when their stored IDs differ", () => {
    const items = [
      item({ name: "Blue Bar", candidateKey: "blue-a", dayIndex: 0 }),
      item({ name: "Blue Bar", candidateKey: "blue-b", dayIndex: 2, date: "2026-08-09" }),
    ];
    expect(findItineraryMatches("where is the blue bar?", items, "Example Coast").matches).toHaveLength(2);
  });

  it("labels removed stops instead of hiding or inventing them", () => {
    const items = [
      item({ name: "Coastal Path", categories: ["nature"], status: "skipped", dayIndex: 2, date: "2026-08-09" }),
    ];
    const result = findItineraryMatches("where is the coastal path?", items, "Antibes");
    expect(result.matches[0].occurrences[0].status).toBe("skipped");
  });

  it("returns done status for finished stops so the concierge can say so", () => {
    const items = [item({ name: "Old Town", status: "done" })];
    expect(findItineraryMatches("where was the old town?", items, "Vlorë").matches[0]
      .occurrences[0].status).toBe("done");
  });

  it("caps the result and never fabricates matches for unknown things", () => {
    const items = [
      item({ name: "Beach One", categories: ["water"] }),
      item({ name: "Beach Two", categories: ["water"] }),
      item({ name: "Beach Three", categories: ["water"] }),
      item({ name: "Beach Four", categories: ["water"] }),
    ];
    expect(findItineraryMatches("where can we swim?", items, "Vlorë").matches).toHaveLength(3);
    expect(findItineraryMatches("where is the helipad?", items, "Vlorë").matches).toEqual([]);
  });

  it("matches the matched category label, not an arbitrary first category", () => {
    const items = [item({ name: "Marché Forville", categories: ["restaurant", "food"] })];
    // "market" is a generic-only term; with no distinctive token it's search-only.
    expect(findItineraryMatches("where is the market?", items, "Example Coast").matches).toEqual([]);
    // Adding the venue name makes the label follow the word that matched.
    expect(findItineraryMatches("when do we go to the Marché food market?", items, "Example Coast").matches[0].categoryLabel)
      .toBe("food");
  });
});

describe("date formatting", () => {
  it("maps a day index onto the calendar", () => {
    expect(tripDateForDayIndex("2026-08-07", 18)).toBe("2026-08-25");
    expect(formatOccurrenceDate("2026-08-25")).toBe("Tue, 25 Aug");
  });

  it("returns an empty string rather than a wrong date for bad input", () => {
    expect(tripDateForDayIndex("not-a-date", 2)).toBe("");
    expect(formatOccurrenceDate("")).toBe("");
  });
});
