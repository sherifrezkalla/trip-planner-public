import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authTraveler: vi.fn(),
  askConcierge: vi.fn(),
  searchPlaces: vi.fn(),
  usageInsert: vi.fn(),
  requestCount: 0,
  itineraryData: undefined as unknown[] | undefined,
}));

function queryResult(result: object) {
  const query = {
    eq: () => query,
    gte: () => query,
    order: () => query,
    then: (resolve: (value: object) => unknown) => Promise.resolve(result).then(resolve),
  };
  return query;
}

vi.mock("@/lib/auth", () => ({ authTraveler: mocks.authTraveler }));
vi.mock("@/lib/llm", () => ({ askConcierge: mocks.askConcierge }));
vi.mock("@/lib/places", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/places")>();
  return { ...actual, searchPlaces: mocks.searchPlaces };
});
vi.mock("@/lib/db", () => ({
  serviceClient: () => ({
    from: (table: string) => {
      if (table === "concierge_requests") {
        return {
          select: () => queryResult({ count: mocks.requestCount, error: null }),
          insert: mocks.usageInsert,
        };
      }
      if (table === "travelers") {
        return {
          select: () => queryResult({
            data: [{ interests: ["water"], pace: "balanced", dietary: "none", constraints_note: "" }],
            error: null,
          }),
        };
      }
      if (table === "itinerary_items") {
        return {
          select: () => queryResult({
            data: (mocks.itineraryData ?? [{
              id: "item-old-town",
              day_index: 0,
              block: "morning",
              status: "planned",
              candidate_id: "cand-old-town",
              venue_candidates: {
                name: "Old Town",
                area: "Vlorë",
                maps_url: "https://maps.example/old-town",
                venue_candidate_categories: [{ category: "history" }],
              },
            }]),
            error: null,
          }),
        };
      }
      return {
        select: () => queryResult({ data: [{ text: "Blue Eye" }], error: null }),
      };
    },
  }),
}));

import { POST } from "@/app/api/trips/[slug]/concierge/route";

const auth = {
  trip: {
    id: "trip-1",
    destination_name: "Vlorë",
    start_date: "2026-08-07",
    end_date: "2026-08-19",
    budget_level: "mid",
    vibe_note: "family holiday",
    explore_radius_km: 15,
    lat: 40.47,
    lng: 19.49,
  },
  me: { id: "traveler-1" },
};

function request(question = "Find a boat trip") {
  return new Request("http://test", {
    method: "POST",
    body: JSON.stringify({
      token: "secret",
      messages: [{ role: "user", content: question }],
    }),
  });
}

describe("POST /api/trips/[slug]/concierge", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.requestCount = 0;
    mocks.itineraryData = undefined;
    process.env.OLLAMA_API_KEY = "test-key";
    mocks.authTraveler.mockResolvedValue(auth);
    mocks.usageInsert.mockResolvedValue({ error: null });
    mocks.searchPlaces.mockResolvedValue([{
      placeId: "boat-1",
      name: "Vlorë Boat Tours",
      category: "concierge",
      categories: ["concierge"],
      rating: 4.8,
      reviewCount: 200,
      priceLevel: null,
      openingHours: [],
      openingPeriods: [],
      lat: 40.471,
      lng: 19.491,
      mapsUrl: "https://maps.example/boat",
      area: "Vlorë",
    }]);
    mocks.askConcierge.mockResolvedValue("Try Vlorë Boat Tours and confirm availability.");
  });

  it("grounds an authenticated question with trip and Google Places context", async () => {
    const response = await POST(request(), { params: Promise.resolve({ slug: "example-region" }) });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.answer).toContain("Vlorë Boat Tours");
    expect(body.places).toMatchObject([{ name: "Vlorë Boat Tours", rating: 4.8 }]);
    expect(mocks.searchPlaces).toHaveBeenCalledWith(expect.objectContaining({
      query: "Find a boat trip in Vlorë",
      radiusKm: 15,
    }));
    expect(mocks.askConcierge).toHaveBeenCalledWith(expect.objectContaining({
      instructions: expect.stringContaining("CURRENT ITINERARY"),
    }));
  });

  it("stops requests at the hourly member limit before calling external services", async () => {
    mocks.requestCount = 20;
    const response = await POST(request(), { params: Promise.resolve({ slug: "example-region" }) });
    expect(response.status).toBe(429);
    expect(mocks.searchPlaces).not.toHaveBeenCalled();
    expect(mocks.askConcierge).not.toHaveBeenCalled();
  });

  it("answers a locator question from the itinerary without calling Google Places", async () => {
    mocks.itineraryData = [{
      id: "item-gym",
      day_index: 2,
      block: "morning",
      status: "planned",
      candidate_id: "cand-gym",
      venue_candidates: {
        name: "Fitness First Antibes",
        area: "Antibes",
        maps_url: "https://maps.example/gym",
        venue_candidate_categories: [{ category: "active" }],
      },
    }];
    const response = await POST(request("Where is the gym?"), {
      params: Promise.resolve({ slug: "example-region" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(mocks.searchPlaces).not.toHaveBeenCalled();
    expect(body.itineraryMatches).toHaveLength(1);
    expect(body.itineraryMatches[0]).toMatchObject({
      name: "Fitness First Antibes",
      area: "Antibes",
      categoryLabel: "active",
      mapsUrl: "https://maps.example/gym",
    });
    expect(body.itineraryMatches[0].occurrences).toEqual([
      { dayIndex: 2, date: "2026-08-09", block: "morning", status: "planned" },
    ]);
    expect(body.places).toEqual([]);
  });

  it.each([
    {
      label: "English restaurant",
      question: "Where is our restaurant?",
      name: "Chez Marcel",
      category: "restaurant",
    },
    {
      label: "English boat-trip",
      question: "When is our boat trip?",
      name: "Example Coast Boat Tour",
      category: "water",
    },
    {
      label: "French restaurant",
      question: "Où est notre restaurant ?",
      name: "Chez Marcel",
      category: "restaurant",
    },
    {
      label: "French boat-trip",
      question: "Quand est notre excursion en bateau ?",
      name: "Croisière Example Coast",
      category: "water",
    },
    {
      label: "German restaurant",
      question: "Wo ist unser Restaurant?",
      name: "Restaurant Hafenblick",
      category: "restaurant",
    },
    {
      label: "German boat-trip",
      question: "Wann ist unsere Bootstour?",
      name: "Croisière Example Coast",
      category: "water",
    },
  ])("keeps $label locator questions off Google Places", async ({
    question,
    name,
    category,
  }) => {
    mocks.itineraryData = [{
      id: `item-${category}`,
      day_index: 2,
      block: "afternoon",
      status: "planned",
      candidate_id: `candidate-${category}`,
      venue_candidates: {
        name,
        area: "Example Coast",
        maps_url: `https://maps.example/${category}`,
        venue_candidate_categories: [{ category }],
      },
    }];

    const response = await POST(request(question), {
      params: Promise.resolve({ slug: "example-coast" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mocks.searchPlaces).not.toHaveBeenCalled();
    expect(body.itineraryMatches).toMatchObject([{ name, categoryLabel: category }]);
    expect(body.places).toEqual([]);
  });

  it("falls through to Google Places when the itinerary has no answer", async () => {
    const response = await POST(request("Find a boat trip"), {
      params: Promise.resolve({ slug: "example-region" }),
    });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(mocks.searchPlaces).toHaveBeenCalled();
    expect(body.itineraryMatches).toEqual([]);
    expect(body.places).toMatchObject([{ name: "Vlorë Boat Tours" }]);
  });

  it("labels skipped and duplicate occurrences rather than presenting them as current", async () => {
    mocks.itineraryData = [
      {
        id: "item-gym-1",
        day_index: 1,
        block: "morning",
        status: "skipped",
        candidate_id: "cand-gym",
        venue_candidates: {
          name: "City Gym",
          area: "Antibes",
          maps_url: "https://maps.example/gym",
          venue_candidate_categories: [{ category: "active" }],
        },
      },
      {
        id: "item-gym-2",
        day_index: 3,
        block: "evening",
        status: "planned",
        candidate_id: "cand-gym",
        venue_candidates: {
          name: "City Gym",
          area: "Antibes",
          maps_url: "https://maps.example/gym",
          venue_candidate_categories: [{ category: "active" }],
        },
      },
    ];
    const response = await POST(request("where is the gym?"), {
      params: Promise.resolve({ slug: "example-region" }),
    });
    const body = await response.json();
    expect(mocks.searchPlaces).not.toHaveBeenCalled();
    expect(body.itineraryMatches).toHaveLength(1);
    expect(body.itineraryMatches[0].occurrences).toEqual([
      { dayIndex: 1, date: "2026-08-08", block: "morning", status: "skipped" },
      { dayIndex: 3, date: "2026-08-10", block: "evening", status: "planned" },
    ]);
  });

  it("understands a multilingual synonym without an external search", async () => {
    mocks.itineraryData = [{
      id: "item-chateau",
      day_index: 4,
      block: "afternoon",
      status: "planned",
      candidate_id: "cand-chateau",
      venue_candidates: {
        name: "Château Grimaldi",
        area: "Antibes",
        maps_url: "https://maps.example/chateau",
        venue_candidate_categories: [{ category: "history" }],
      },
    }];
    const response = await POST(request("wo ist das Schloss?"), {
      params: Promise.resolve({ slug: "example-region" }),
    });
    const body = await response.json();
    expect(mocks.searchPlaces).not.toHaveBeenCalled();
    expect(body.itineraryMatches[0]).toMatchObject({
      name: "Château Grimaldi",
      categoryLabel: "history",
    });
  });
});
