import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ client: vi.fn(), authTraveler: vi.fn() }));

vi.mock("@/lib/db", () => ({ serviceClient: () => mocks.client() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, authTraveler: mocks.authTraveler };
});

import { POST } from "@/app/api/trips/[slug]/weather-scan/route";

type QueryResult = { data: Record<string, unknown>[]; error: null };

/** A minimal PostgREST query builder for the two reads made by the scan. */
function builder(result: QueryResult) {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq"]) query[method] = () => query;
  query.then = (resolve: (value: QueryResult) => unknown) => Promise.resolve(result).then(resolve);
  return query;
}

function databaseFor(dayIndex: number) {
  const item = {
    id: "item-1",
    day_index: dayIndex,
    block: "morning",
    area: "Example Coast",
    candidate_id: "beach-1",
    status: "planned",
    is_locked: false,
    reservation_status: "none",
  };
  const candidates = [
    {
      id: "beach-1", name: "Plage du Midi", area: "Example Coast", category: "nature",
      rating: 4.6, review_count: 2_000, lat: 43.55, lng: 7.01, exposure: "outdoor",
    },
    {
      id: "museum-1", name: "Musée des Explorations", area: "Example Coast", category: "museum",
      rating: 4.5, review_count: 1_500, lat: 43.55, lng: 7.01, exposure: "indoor",
    },
  ];

  return {
    from: (table: string) => builder({
      data: table === "itinerary_items" ? [item] : candidates,
      error: null,
    }),
  };
}

function request() {
  return new Request("https://trip-planner.test/api/trips/example-coast/weather-scan", {
    method: "POST",
    body: JSON.stringify({ slug: "example-coast", token: "traveler-token" }),
  });
}

function forecastFor(date: string) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    daily: {
      time: [date],
      weather_code: [63],
      temperature_2m_max: [20],
      precipitation_probability_max: [80],
    },
  }), { status: 200 })));
}

function signedInFor(startDate: string, endDate: string) {
  mocks.authTraveler.mockResolvedValue({
    trip: {
      id: "trip-1", slug: "example-coast", start_date: startDate, end_date: endDate,
      destination_name: "Example Coast", destination_place_id: "place-1", lat: 43.55,
      lng: 7.01, budget_level: "mid", vibe_note: "", explore_radius_km: 10,
      title: "Example Coast", photo_ref: "",
    },
    me: { id: "organizer-1", is_organizer: true },
  });
}

async function scanWarning() {
  const response = await POST(request(), { params: Promise.resolve({ slug: "example-coast" }) });
  expect(response.status).toBe(200);
  const body = await response.json() as { swaps: { beyondConfidentForecast: boolean }[] };
  expect(body.swaps).toHaveLength(1);
  return body.swaps[0].beyondConfidentForecast;
}

describe("POST /api/trips/[slug]/weather-scan forecast confidence", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("marks trip day zero as uncertain when its forecast is more than three days away", async () => {
    vi.setSystemTime(new Date("2026-09-01T12:00:00Z"));
    mocks.client.mockReturnValue(databaseFor(0));
    signedInFor("2026-09-10", "2026-09-10");
    forecastFor("2026-09-10");

    expect(await scanWarning()).toBe(true);
  });

  it("keeps trip day four confident when it is tomorrow during the trip", async () => {
    vi.setSystemTime(new Date("2026-09-13T12:00:00Z"));
    mocks.client.mockReturnValue(databaseFor(4));
    signedInFor("2026-09-10", "2026-09-14");
    forecastFor("2026-09-14");

    expect(await scanWarning()).toBe(false);
  });
});
