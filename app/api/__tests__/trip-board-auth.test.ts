import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ client: vi.fn(), auth: vi.fn() }));

vi.mock("@/lib/db", () => ({ serviceClient: () => mocks.client() }));
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, authTraveler: mocks.auth };
});

import { TRIP_TOKEN_HEADER } from "@/lib/auth";
import { GET } from "@/app/api/trips/[slug]/route";

/** Every chained query method returns itself; awaiting resolves to an empty read. */
function emptyBoard() {
  const query: Record<string, unknown> = {};
  for (const method of ["select", "eq", "order", "in"]) query[method] = () => query;
  query.then = (resolve: (value: unknown) => unknown) =>
    Promise.resolve({ data: [], error: null }).then(resolve);
  return { from: () => query };
}

function boardWithRows(rows: Record<string, unknown[]>) {
  return {
    from(table: string) {
      const query: Record<string, unknown> = {};
      for (const method of ["select", "eq", "order", "in"]) query[method] = () => query;
      query.then = (resolve: (value: unknown) => unknown) =>
        Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve);
      return query;
    },
  };
}

const params = Promise.resolve({ slug: "example-coast" });

beforeEach(() => {
  vi.clearAllMocks();
  mocks.client.mockReturnValue(emptyBoard());
  mocks.auth.mockResolvedValue({
    trip: {
      id: "trip-1", slug: "example-coast", title: "Example Coast", destination_name: "Example Coast",
      start_date: "2026-09-01", end_date: "2026-09-07", budget_level: "mid",
      vibe_note: "", lat: 43.55, lng: 7.01,
    },
    me: { id: "me", is_organizer: true },
  });
});

/**
 * The board is the read that used to carry a traveller's token in the query
 * string, so it is the one that put a non-expiring credential into every access
 * log the request passed through.
 */
describe("GET /api/trips/[slug] token source", () => {
  it("authenticates from the header", async () => {
    const request = new Request("https://trip-planner.test/api/trips/example-coast", {
      headers: { [TRIP_TOKEN_HEADER]: "tok" },
    });

    const response = await GET(request, { params });

    expect(response.status).toBe(200);
    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), "example-coast", "tok");
  });

  it("keeps the existing empty-board response contract exact", async () => {
    const request = new Request("https://trip-planner.test/api/trips/example-coast", {
      headers: { [TRIP_TOKEN_HEADER]: "tok" },
    });

    const response = await GET(request, { params });

    expect(await response.json()).toEqual({
      trip: {
        slug: "example-coast",
        title: "Example Coast",
        destinationName: "Example Coast",
        startDate: "2026-09-01",
        endDate: "2026-09-07",
        budgetLevel: "mid",
        vibeNote: "",
        lat: 43.55,
        lng: 7.01,
        dayCount: 7,
      },
      me: { id: "me", isOrganizer: true },
      travelers: [],
      proposals: [],
      latestAdjustTodayRevision: null,
      suggestions: [],
      items: [],
    });
  });

  it("keeps the existing populated board response byte-for-byte compatible", async () => {
    mocks.client.mockReturnValue(boardWithRows({
      travelers: [{
        id: "me", display_name: "Alex", interests: ["food"], pace: "balanced",
        dietary: "none", constraints_note: "", is_organizer: true, is_bot: false,
        created_at: "2026-08-01T10:00:00.000Z", arrives_on: null, departs_on: null,
      }],
      itinerary_items: [{
        id: "item-1", day_index: 0, block: "morning", why_note: "Good start", area: "Old Town",
        duration_min: 60, position: 0, travel_warning: false, status: "planned", is_locked: false,
        completed_at: null, completed_day_index: null, state_changed_by: null,
        reservation_status: "none", reservation_at: null, confirmation_number: null,
        booking_url: null, cancellation_deadline: null, reservation_auto_locked: false,
        reservation_details_source: "organizer", reservation_organizer_verified_at: null,
        votes: [{ traveler_id: "me", value: 1 }], reservation_proof_artifacts: [],
        venue_candidates: {
          name: "Market", rating: 4.5, review_count: 20, price_level: null,
          opening_hours: [], opening_periods: null, lat: 43.56, lng: 7.02,
          maps_url: "https://maps.example/market", fetched_at: "2026-08-01T09:00:00.000Z",
          venue_candidate_categories: [{ category: "food" }],
        },
      }],
      trip_suggestions: [],
      plan_proposals: [{
        id: "proposal-1", item_id: "item-1", proposed_by: "me", kind: "move",
        from_day_index: 0, from_block: "morning", to_day_index: 1, to_block: "afternoon",
        to_candidate_id: null, suggestion_text: null, note: "Later", created_at: "2026-08-01T11:00:00.000Z",
        plan_proposal_votes: [{ traveler_id: "me", value: 1 }],
      }],
      reservation_attempts: [],
      itinerary_revisions: [],
    }));
    const request = new Request("https://trip-planner.test/api/trips/example-coast", {
      headers: { [TRIP_TOKEN_HEADER]: "tok" },
    });

    const response = await GET(request, { params });

    expect(await response.text()).toBe(JSON.stringify({
      trip: {
        slug: "example-coast", title: "Example Coast", destinationName: "Example Coast",
        startDate: "2026-09-01", endDate: "2026-09-07", budgetLevel: "mid",
        vibeNote: "", lat: 43.55, lng: 7.01, dayCount: 7,
      },
      me: { id: "me", isOrganizer: true },
      travelers: [{
        id: "me", displayName: "Alex", interests: ["food"], pace: "balanced", dietary: "none",
        isOrganizer: true, isBot: false, constraintsNote: "", joinedAt: "2026-08-01T10:00:00.000Z",
        arrivesOn: null, departsOn: null, voteCount: 1,
      }],
      proposals: [{
        id: "proposal-1", itemId: "item-1", kind: "move", proposedByName: "Alex",
        fromDayIndex: 0, fromBlock: "morning", toDayIndex: 1, toBlock: "afternoon",
        replacementName: null, suggestionText: null, note: "Later",
        createdAt: "2026-08-01T11:00:00.000Z", yes: 1, no: 0, needed: 1, myVote: 1,
      }],
      latestAdjustTodayRevision: null,
      suggestions: [],
      items: [{
        id: "item-1", dayIndex: 0, block: "morning", whyNote: "Good start", area: "Old Town",
        durationMin: 60, position: 0, travelWarning: false, status: "planned", isLocked: false,
        completedAt: null, completedDayIndex: null, stateChangedByName: null,
        reservation: {
          status: "none", reservationAt: null, confirmationNumber: null, bookingUrl: null,
          cancellationDeadline: null, autoLocked: false, detailsSource: "organizer",
          organizerVerifiedAt: null, artifact: null, artifactCleanupPending: false,
        },
        reservationAttempt: null,
        venue: {
          name: "Market", rating: 4.5, reviewCount: 20, priceLevel: null,
          openingHours: [], openingPeriods: [], categories: ["food"], lat: 43.56, lng: 7.02,
          mapsUrl: "https://maps.example/market", fetchedAt: "2026-08-01T09:00:00.000Z",
        },
        voteSum: 1,
        myVote: 1,
      }],
    }));
  });

  /** A tab loaded before the deploy keeps sending the old shape until reloaded. */
  it("still authenticates a query-string token from an older client", async () => {
    const request = new Request("https://trip-planner.test/api/trips/example-coast?token=tok");

    const response = await GET(request, { params });

    expect(response.status).toBe(200);
    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), "example-coast", "tok");
  });

  it("hands the header's token to the lookup when a request carries both", async () => {
    const request = new Request("https://trip-planner.test/api/trips/example-coast?token=fromQuery", {
      headers: { [TRIP_TOKEN_HEADER]: "fromHeader" },
    });

    await GET(request, { params });

    expect(mocks.auth).toHaveBeenCalledWith(expect.anything(), "example-coast", "fromHeader");
  });

  it("refuses when the token is wrong, whichever way it arrived", async () => {
    mocks.auth.mockResolvedValue({ status: 401, error: "Invalid traveler token" });
    const request = new Request("https://trip-planner.test/api/trips/example-coast", {
      headers: { [TRIP_TOKEN_HEADER]: "nope" },
    });

    const response = await GET(request, { params });

    expect(response.status).toBe(401);
  });
});
