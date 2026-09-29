import { describe, expect, it } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  loadGroupSafeToday,
  loadGroupSafeTripContext,
  type GroupSafeViewerLookup,
} from "@/lib/trip-agent-read-model";

type Interaction = {
  table: string;
  select: string | null;
  filters: Array<[string, unknown]>;
};

const PRIVATE_VALUES = [
  "organizer-only-note",
  "traveler-secret-interest",
  "traveler-secret-constraint",
  "private-contact@example.test",
  "+4915112345678",
  "CONFIRM-PRIVATE-42",
  "proof-private.pdf",
  "https://booking.example/private-token",
  "https://attempt.example/private-route",
  "private organizer handoff",
  "proposal-private-note",
] as const;

const trip = {
  id: "trip-1",
  slug: "family-trip",
  title: "Family trip",
  destination_name: "Berlin",
  start_date: "2026-09-01",
  end_date: "2026-09-03",
  budget_level: "mid",
  vibe_note: "Museums and food",
  lat: 52.52,
  lng: 13.405,
  organizer_note: PRIVATE_VALUES[0],
};

const travelers = [
  {
    id: "traveler-1",
    is_organizer: false,
    is_bot: false,
    display_name: "Private Person",
    interests: [PRIVATE_VALUES[1]],
    pace: "balanced",
    dietary: "none",
    constraints_note: PRIVATE_VALUES[2],
  },
  { id: "traveler-2", is_organizer: true, is_bot: false, display_name: "Organizer" },
  { id: "traveler-bot", is_organizer: false, is_bot: true, display_name: "Assistant" },
];

const items = [
  {
    id: "item-breakfast",
    day_index: 1,
    block: "morning",
    why_note: "Start nearby",
    area: "Mitte",
    duration_min: 45,
    position: 0,
    travel_warning: false,
    status: "done",
    is_locked: false,
    completed_at: "2026-09-02T06:30:00.000Z",
    completed_day_index: 1,
    reservation_status: "none",
    reservation_at: null,
    confirmation_number: PRIVATE_VALUES[5],
    booking_url: PRIVATE_VALUES[7],
    reservation_proof_artifacts: [{ original_file_name: PRIVATE_VALUES[6] }],
    votes: [{ traveler_id: "traveler-2", value: 1 }],
    venue_candidates: {
      name: "Breakfast Room",
      rating: 4.1,
      review_count: 50,
      price_level: "PRICE_LEVEL_MODERATE",
      opening_hours: ["Wednesday: 07:00–12:00"],
      opening_periods: [{
        open: { day: 3, hour: 7, minute: 0 },
        close: { day: 3, hour: 12, minute: 0 },
      }],
      lat: 52.519,
      lng: 13.404,
      maps_url: "https://maps.example/breakfast",
      fetched_at: "2026-09-01T09:00:00.000Z",
      venue_candidate_categories: [{ category: "food" }],
    },
  },
  {
    id: "item-museum",
    day_index: 1,
    block: "morning",
    why_note: "Public schedule reason",
    area: "Museum Island",
    duration_min: 120,
    position: 1,
    travel_warning: true,
    status: "planned",
    is_locked: true,
    completed_at: null,
    completed_day_index: null,
    reservation_status: "confirmed",
    reservation_at: "2026-09-02T09:00:00.000Z",
    confirmation_number: PRIVATE_VALUES[5],
    booking_url: PRIVATE_VALUES[7],
    cancellation_deadline: "2026-09-01T09:00:00.000Z",
    reservation_proof_artifacts: [{ original_file_name: PRIVATE_VALUES[6] }],
    votes: [
      { traveler_id: "traveler-1", value: 1 },
      { traveler_id: "traveler-2", value: -1 },
    ],
    venue_candidates: {
      name: "Pergamon Panorama",
      rating: 4.7,
      review_count: 1200,
      price_level: null,
      opening_hours: ["Wednesday: 09:00–18:00"],
      opening_periods: [{
        open: { day: 3, hour: 9, minute: 0 },
        close: { day: 3, hour: 18, minute: 0 },
      }],
      lat: 52.521,
      lng: 13.397,
      maps_url: "https://maps.example/museum",
      fetched_at: "2026-09-01T09:00:00.000Z",
      venue_candidate_categories: [{ category: "history" }],
      private_contact: PRIVATE_VALUES[3],
    },
  },
  {
    id: "item-day-zero",
    day_index: 0,
    block: "dinner",
    why_note: "First night",
    area: "Kreuzberg",
    duration_min: 90,
    position: 0,
    travel_warning: false,
    status: "planned",
    is_locked: false,
    completed_at: null,
    completed_day_index: null,
    reservation_status: "tentative",
    reservation_at: "2026-09-01T18:30:00.000Z",
    votes: [],
    venue_candidates: {
      name: "Night Kitchen",
      rating: 4.4,
      review_count: 300,
      price_level: "PRICE_LEVEL_MODERATE",
      opening_hours: [],
      opening_periods: [],
      lat: 52.5,
      lng: 13.42,
      maps_url: "https://maps.example/dinner",
      fetched_at: "2026-09-01T09:00:00.000Z",
      venue_candidate_categories: [{ category: "food" }],
    },
  },
];

const proposals = [{
  id: "proposal-1",
  item_id: "item-museum",
  proposed_by: "traveler-2",
  kind: "move",
  from_day_index: 1,
  from_block: "morning",
  to_day_index: 2,
  to_block: "afternoon",
  to_candidate_id: null,
  suggestion_text: null,
  note: PRIVATE_VALUES[10],
  created_at: "2026-09-01T12:00:00.000Z",
  plan_proposal_votes: [
    { traveler_id: "traveler-1", value: 1 },
    { traveler_id: "traveler-2", value: -1 },
  ],
}];

const attempts = [{
  id: "attempt-1",
  itinerary_item_id: "item-museum",
  state: "in_progress",
  contact_email: PRIVATE_VALUES[3],
  contact_phone: PRIVATE_VALUES[4],
  routes: [PRIVATE_VALUES[8]],
  confirmation_reference: PRIVATE_VALUES[5],
  confirmation_url: PRIVATE_VALUES[7],
  handoff: PRIVATE_VALUES[9],
}];

function makeDb(
  mappingStatus: "confirmed" | "suggested" | "revoked" = "confirmed",
  itemRows: Record<string, unknown>[] = items,
) {
  const interactions: Interaction[] = [];
  const rows: Record<string, unknown[]> = {
    trips: [trip],
    travelers,
    itinerary_items: itemRows,
    plan_proposals: proposals,
    reservation_attempts: attempts,
    trip_agent_connections: [{
      id: "connection-1",
      trip_id: "trip-1",
      lifecycle_generation: 1,
      status: "active",
      granted_scopes: ["trip.read", "trip.propose", "trip.modify", "trip.vote"],
      authority_policy: {
        travelerCanAddSuggestion: true,
        travelerCanProposeChange: true,
      },
      credential_digest: "credential-private-digest",
    }],
    trip_agent_participant_mappings: [{
      lifecycle_generation: 1,
      status: mappingStatus,
      traveler_id: "traveler-1",
      display_name_hint: "Private Person",
      external_participant_digest: "participant-private-digest",
      traveler: {
        id: "traveler-1",
        is_organizer: false,
        is_bot: false,
        display_name: "Private Person",
        interests: [PRIVATE_VALUES[1]],
      },
    }],
  };

  function from(table: string) {
    const interaction: Interaction = { table, select: null, filters: [] };
    interactions.push(interaction);
    const query: Record<string, unknown> = {};
    query.select = (selection: string) => {
      interaction.select = selection;
      return query;
    };
    query.eq = (column: string, value: unknown) => {
      interaction.filters.push([column, value]);
      return query;
    };
    query.order = () => query;
    query.in = () => query;
    query.maybeSingle = () => Promise.resolve({ data: rows[table]?.[0] ?? null, error: null });
    query.then = (
      resolve: (value: { data: unknown[]; error: null }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) => Promise.resolve({ data: rows[table] ?? [], error: null }).then(resolve, reject);
    return query;
  }

  return {
    db: { from } as unknown as SupabaseClient,
    interactions,
  };
}

const viewer: GroupSafeViewerLookup = {
  connectionId: "connection-1",
  lifecycleGeneration: 1,
  externalParticipantDigest: "participant-private-digest",
};

function assertNoPrivateFixture(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const secret of PRIVATE_VALUES) expect(serialized).not.toContain(secret);
  expect(serialized).not.toContain("credential-private-digest");
  expect(serialized).not.toContain("participant-private-digest");
  expect(serialized).not.toContain("traveler-1");
  expect(serialized).not.toContain("traveler-2");
  for (const privateKey of [
    "confirmationNumber",
    "bookingUrl",
    "cancellationDeadline",
    "artifact",
    "reservationAttempt",
    "contactEmail",
    "contactPhone",
    "routes",
    "handoff",
    "organizerNote",
    "constraintsNote",
    "interests",
    "proposedByName",
  ]) expect(serialized).not.toContain(`\"${privateKey}\"`);
}

describe("group-safe trip read model", () => {
  it("allowlists public schedule, reservation, venue, tally, and decision fields", async () => {
    const { db, interactions } = makeDb();

    const result = await loadGroupSafeTripContext(db, "trip-1", viewer);

    expect(result.trip).toEqual({
      slug: "family-trip",
      title: "Family trip",
      destinationName: "Berlin",
      startDate: "2026-09-01",
      endDate: "2026-09-03",
      budgetLevel: "mid",
      vibeNote: "Museums and food",
      lat: 52.52,
      lng: 13.405,
      dayCount: 3,
    });
    expect(result.items.find((item) => item.id === "item-museum")).toMatchObject({
      whyNote: "Public schedule reason",
      area: "Museum Island",
      reservationStatus: "confirmed",
      reservationAt: "2026-09-02T09:00:00.000Z",
      bookingStatus: "in_progress",
      voteSum: 0,
      venue: {
        name: "Pergamon Panorama",
        rating: 4.7,
        reviewCount: 1200,
        mapsUrl: "https://maps.example/museum",
        lat: 52.521,
        lng: 13.397,
      },
    });
    expect(result.pendingDecisions).toEqual([expect.objectContaining({
      id: "proposal-1",
      description: "Move Pergamon Panorama to Day 3 afternoon",
      yes: 1,
      no: 1,
      needed: 2,
      outcome: "pending",
      myVote: 1,
    })]);
    expect(result.viewer).toEqual({
      canVote: true,
      canProposeChange: true,
      canAddSuggestion: true,
      canDecide: false,
    });
    assertNoPrivateFixture(result);
    for (const interaction of interactions) {
      expect(interaction.select).not.toContain("*");
      expect(interaction.select).not.toContain("confirmation_number");
      expect(interaction.select).not.toContain("booking_url");
      expect(interaction.select).not.toContain("contact_email");
      expect(interaction.select).not.toContain("routes");
      expect(interaction.select).not.toContain("interests");
      expect(interaction.select).not.toContain("constraints_note");
    }
    expect(interactions.find(({ table }) => table === "trip_agent_connections")?.filters)
      .toContainEqual(["lifecycle_generation", 1]);
    expect(interactions.find(({ table }) => table === "trip_agent_participant_mappings")?.filters)
      .toContainEqual(["lifecycle_generation", 1]);
  });

  it.each(["suggested", "revoked"] as const)(
    "does not trust a %s participant mapping that carries a traveler row",
    async (status) => {
      const { db } = makeDb(status);

      const result = await loadGroupSafeTripContext(db, "trip-1", viewer);

      expect(result.viewer).toBeUndefined();
      expect(result.pendingDecisions[0]).not.toHaveProperty("myVote");
      assertNoPrivateFixture(result);
    },
  );

  it("does not personalize an unmatched viewer", async () => {
    const { db } = makeDb();

    const result = await loadGroupSafeTripContext(db, "trip-1", null);

    expect(result.viewer).toBeUndefined();
    expect(result.pendingDecisions[0]).not.toHaveProperty("myVote");
    assertNoPrivateFixture(result);
  });
});

describe("group-safe today read model", () => {
  it("returns the authoritative Today helper order even when rows arrive out of order", async () => {
    const { db } = makeDb("confirmed", [items[1], items[0], items[2]]);

    const result = await loadGroupSafeToday(
      db,
      "trip-1",
      new Date("2026-09-02T08:00:00.000Z"),
    );

    expect(result.items.map((item) => item.id)).toEqual(["item-breakfast", "item-museum"]);
  });

  it("uses the explicit trip timezone at midnight and reuses Today ordering and risks", async () => {
    const { db } = makeDb();
    const instant = new Date("2026-09-01T22:30:00.000Z");

    const result = await loadGroupSafeToday(db, "trip-1", instant, {
      timeZone: "Europe/Berlin",
      viewer,
    });

    expect(result).toMatchObject({
      phase: "during",
      dayIndex: 1,
      date: "2026-09-02",
      items: [{ id: "item-breakfast" }, { id: "item-museum" }],
      next: { id: "item-museum" },
      openingHoursRisk: { level: "clear" },
      pendingDecisions: [{ id: "proposal-1", myVote: 1 }],
    });
    expect(result.leaveBy).toMatchObject({
      originName: "Breakfast Room",
      urgency: "later",
    });
    expect(result.next?.reservationStatus).toBe("confirmed");
    assertNoPrivateFixture(result);
  });

  it("defaults to UTC until the trip has a persisted timezone", async () => {
    const { db } = makeDb();
    const instant = new Date("2026-09-01T22:30:00.000Z");

    const result = await loadGroupSafeToday(db, "trip-1", instant);

    expect(result.dayIndex).toBe(0);
    expect(result.date).toBe("2026-09-01");
    expect(result.items.map((item) => item.id)).toEqual(["item-day-zero"]);
  });

  it("expresses an unreserved block's leave-by estimate as a real trip-timezone instant", async () => {
    const unreservedMuseum = {
      ...items[1],
      reservation_status: "none",
      reservation_at: null,
    };
    const { db } = makeDb("confirmed", [items[0], unreservedMuseum, items[2]]);

    const result = await loadGroupSafeToday(
      db,
      "trip-1",
      new Date("2026-09-02T05:00:00.000Z"),
      { timeZone: "Europe/Berlin" },
    );

    expect(result.next?.id).toBe("item-museum");
    expect(result.leaveBy?.scheduledAt).toBe("2026-09-02T07:00:00.000Z");
  });

  it("rejects an invalid IANA timezone instead of silently using the server timezone", async () => {
    const { db } = makeDb();

    await expect(loadGroupSafeToday(db, "trip-1", new Date(), {
      timeZone: "Not/A_Timezone",
    })).rejects.toThrow("Invalid time zone");
  });
});
