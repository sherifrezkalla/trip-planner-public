import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { bookingProvider, preciseHandoff, reservationAttemptForViewer } from "@/lib/reservation-assistance";
import { createReservationAttemptSchema, updateReservationAttemptSchema } from "@/lib/schema";

const request = {
  token: "secret", slug: "example-coast", partySize: 8,
  requestedAt: "2026-08-25T18:30:00.000Z", bookingName: "Alex",
  contactEmail: "organizer@example.com", contactPhone: null,
  alternatives: ["2026-08-25T19:00:00.000Z"],
  routes: ["https://www.thefork.com/restaurant/example"],
};

describe("reservation assistance", () => {
  it.each([
    ["https://www.thefork.com/r/x", "thefork"], ["https://opentable.com/x", "opentable"],
    ["https://resy.com/x", "resy"], ["https://www.sevenrooms.com/x", "sevenrooms"],
    ["https://restaurant.example/book", "direct"], ["http://restaurant.example/book", null],
  ])("classifies safe booking routes", (url, provider) => expect(bookingProvider(url)).toBe(provider));

  it("requires every booking detail and at least one private contact", () => {
    expect(createReservationAttemptSchema.safeParse(request).success).toBe(true);
    expect(createReservationAttemptSchema.safeParse({ ...request, contactEmail: null }).success).toBe(false);
    expect(createReservationAttemptSchema.safeParse({ ...request, partySize: 0 }).success).toBe(false);
    expect(createReservationAttemptSchema.safeParse({ ...request, routes: [] }).success).toBe(false);
  });

  it("requires verifiable evidence for confirmation", () => {
    expect(updateReservationAttemptSchema.safeParse({ token: "x", slug: "y", action: "confirm" }).success).toBe(false);
    expect(updateReservationAttemptSchema.safeParse({ token: "x", slug: "y", action: "confirm", confirmationReference: "ABC-1" }).success).toBe(true);
  });

  it("produces a precise handoff without claiming success", () => {
    const text = preciseHandoff(request.routes[0], "Il Terrazzino", request.requestedAt, 8);
    expect(text).toContain("Il Terrazzino"); expect(text).toContain("8");
    expect(text).toContain("confirmation reference"); expect(text).toContain("will not show confirmed");
  });

  it("serializes only workflow state and verified confirmation for travelers", () => {
    const serialized = reservationAttemptForViewer({
      id: "attempt-1", state: "in_progress", confirmation_reference: null,
      party_size: 8, requested_at: request.requestedAt, booking_name: "Alex",
      contact_email: request.contactEmail, contact_phone: null,
      alternatives: request.alternatives, routes: request.routes, route_index: 0,
      route_provider: "thefork", confirmation_url: "https://private.example/booking/token",
      handoff: "Private organizer instructions", approved_at: null, attempted_at: null, confirmed_at: null,
    }, false);

    expect(serialized).toEqual({ state: "in_progress", confirmationReference: null });
  });

  it("keeps failed attempts as audit history without blocking a fresh UI attempt", () => {
    expect(reservationAttemptForViewer({ id: "attempt-1", state: "failed" }, true)).toBeNull();
  });

  it("declares the item and creator same-trip database invariants", () => {
    const migration = readFileSync("supabase/migrations/20260826103000_reservation_assistance.sql", "utf8");
    expect(migration).toContain("foreign key (itinerary_item_id, trip_id)");
    expect(migration).toContain("references itinerary_items(id, trip_id)");
    expect(migration).toContain("foreign key (created_by, trip_id)");
    expect(migration).toContain("reservation_attempts_trip_creator on reservation_attempts(trip_id, created_by)");
    expect(migration).toContain("returns setof reservation_attempts");
    expect(migration).toContain("p_details_source => 'organizer'");
    expect(migration).toContain("p_organizer_verified => false");
  });
});
