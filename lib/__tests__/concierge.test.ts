import { describe, expect, it } from "vitest";
import {
  buildConciergeInstructions,
  conversationForModel,
  shortlistConciergePlaces,
  toConciergePlaces,
  type ConciergeContext,
} from "@/lib/concierge";
import type { PlaceCandidate } from "@/lib/places";

function candidate(id: string): PlaceCandidate {
  return {
    placeId: id,
    name: `Place ${id}`,
    category: "concierge",
    categories: ["concierge"],
    rating: 4.5,
    reviewCount: 100,
    priceLevel: null,
    openingHours: [],
    openingPeriods: [],
    lat: 40.47,
    lng: 19.49,
    mapsUrl: `https://maps.example/${id}`,
    area: "Vlorë",
  };
}

const context: ConciergeContext = {
  destinationName: "Vlorë",
  startDate: "2026-08-07",
  endDate: "2026-08-19",
  budgetLevel: "mid",
  vibeNote: "family holiday",
  travelers: [{
    interests: ["food", "water"],
    pace: "balanced",
    dietary: "vegetarian",
    constraintsNote: "travelling with children",
  }],
  itinerary: [{
    dayIndex: 0,
    date: "2026-08-07",
    block: "morning",
    status: "planned",
    name: "Old Town",
    area: "Vlorë",
  }],
  suggestions: ["Blue Eye"],
};

describe("concierge grounding", () => {
  it("keeps Google's relevance order and limits place cards", () => {
    const candidates = Array.from({ length: 7 }, (_, index) => candidate(String(index)));
    expect(shortlistConciergePlaces(candidates).map((place) => place.placeId)).toEqual([
      "0", "1", "2", "3", "4",
    ]);
  });

  it("builds trip-specific instructions with verified places and safety boundaries", () => {
    const instructions = buildConciergeInstructions(context, toConciergePlaces([candidate("boat")]));
    expect(instructions).toContain("Destination: Vlorë");
    expect(instructions).toContain("Day 1 (2026-08-07) morning: Old Town (Vlorë)");
    expect(instructions).toContain("Place boat");
    expect(instructions).toContain("Never claim live availability");
    expect(instructions).toContain("Do not change the itinerary");
  });

  it("marks non-planned stops so the concierge cannot present them as current", () => {
    const skipped: ConciergeContext = {
      ...context,
      itinerary: [{
        dayIndex: 2,
        date: "2026-08-09",
        block: "evening",
        status: "skipped",
        name: "Coastal Path",
        area: "Antibes",
      }],
    };
    expect(buildConciergeInstructions(skipped, [])).toContain("Day 3 (2026-08-09) evening: Coastal Path (Antibes) [skipped]");
    expect(buildConciergeInstructions(skipped, [])).toContain("removed from the plan");
  });

  it("keeps only the latest ten chat turns", () => {
    const messages = Array.from({ length: 12 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: String(index),
    }));
    expect(conversationForModel(messages).map((message) => message.content)).toEqual([
      "2", "3", "4", "5", "6", "7", "8", "9", "10", "11",
    ]);
  });
});
