import { describe, expect, it, vi } from "vitest";
import {
  applyItineraryReshuffle,
  applyPartialDayReplan,
  confirmReservationAttempt,
  replaceTripItinerary,
  createSuggestionProposal,
  createPlanProposal,
  swapItineraryItem,
  updateItineraryReservation,
} from "@/lib/persistence";

describe("itinerary persistence", () => {
  it("preserves machine failure codes and passes expected preview safety to the atomic creation guard", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { code: "TP001", message: "private database text" } });
    const expectedState = { item: { dayIndex: 0 } };
    await expect(createPlanProposal({ rpc } as never, { tripId: "trip", itemId: "item", proposedBy: "actor", kind: "remove", toDayIndex: null, toBlock: null, note: "", expectedState })).rejects.toMatchObject({ code: "TP001" });
    expect(rpc.mock.calls[0][1]).toHaveProperty("p_expected_state", expectedState);
  });
  it("opens a voteable suggestion through the atomic database function", async () => {
    const rpc = vi.fn().mockResolvedValue({ data: "proposal-1", error: null });
    await expect(createSuggestionProposal({ rpc } as never, {
      tripId: "trip-1", proposedBy: "traveler-1", text: "Blue Lagoon",
    })).resolves.toBe("proposal-1");
    expect(rpc).toHaveBeenCalledWith("create_suggestion_proposal", {
      p_trip_id: "trip-1", p_proposed_by: "traveler-1", p_suggestion_text: "Blue Lagoon",
    });
  });

  it("replaces a complete itinerary through the atomic database function", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    const rows = [{
      trip_id: "trip-1",
      day_index: 0,
      block: "morning",
      candidate_id: "candidate-1",
      why_note: "A fit",
      duration_min: 90,
      position: 0,
      travel_warning: false,
      area: "Lisbon",
    }];

    await replaceTripItinerary({ rpc } as never, "trip-1", rows);

    expect(rpc).toHaveBeenCalledWith("replace_trip_itinerary", {
      p_trip_id: "trip-1",
      p_items: rows,
    });
  });

  it("surfaces an atomic replacement failure without attempting a client-side delete", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: { message: "insert failed" } });
    await expect(replaceTripItinerary({ rpc } as never, "trip-1", [])).rejects.toThrow("insert failed");
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it("applies a swap, vote reset, and warning changes in one database call", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await swapItineraryItem({ rpc } as never, {
      tripId: "trip-1",
      itemId: "item-1",
      candidateId: "candidate-2",
      whyNote: "Closer",
      durationMin: 60,
      area: "Lisbon",
      warningUpdates: [{ id: "item-1", travelWarning: false }],
    });
    expect(rpc).toHaveBeenCalledWith("swap_itinerary_item", {
      p_trip_id: "trip-1",
      p_item_id: "item-1",
      p_candidate_id: "candidate-2",
      p_why_note: "Closer",
      p_duration_min: 60,
      p_area: "Lisbon",
      p_warning_updates: [{ id: "item-1", travel_warning: false }],
    });
  });

  it("applies a reviewed reshuffle through the atomic database function", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await applyItineraryReshuffle({ rpc } as never, "trip-1", [{
      itemId: "item-1",
      fromDayIndex: 2,
      fromBlock: "afternoon",
      toDayIndex: 6,
      toBlock: "afternoon",
    }]);
    expect(rpc).toHaveBeenCalledWith("apply_itinerary_reshuffle", {
      p_trip_id: "trip-1",
      p_moves: [{
        item_id: "item-1",
        from_day_index: 2,
        from_block: "afternoon",
        to_day_index: 6,
        to_block: "afternoon",
      }],
    });
  });

  it("applies a reviewed partial-day repair through one atomic database function", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await applyPartialDayReplan({ rpc } as never, {
      tripId: "trip-1",
      actorId: "traveler-1",
      dayIndex: 2,
      currentBlock: "afternoon",
      trigger: "running-late",
      moves: [{
        itemId: "item-1",
        fromDayIndex: 2,
        fromBlock: "morning",
        toDayIndex: 2,
        toBlock: "afternoon",
      }],
      skips: [{ itemId: "item-2", fromDayIndex: 2, fromBlock: "afternoon" }],
    });

    expect(rpc).toHaveBeenCalledWith("apply_partial_day_replan", {
      p_trip_id: "trip-1",
      p_actor_id: "traveler-1",
      p_day_index: 2,
      p_current_block: "afternoon",
      p_trigger: "running-late",
      p_moves: [{
        item_id: "item-1",
        from_day_index: 2,
        from_block: "morning",
        to_day_index: 2,
        to_block: "afternoon",
      }],
      p_skips: [{ item_id: "item-2", from_day_index: 2, from_block: "afternoon" }],
    });
  });

  it("updates reservation details and automatic locking through one database function", async () => {
    const rpc = vi.fn().mockResolvedValue({ error: null });
    await updateItineraryReservation({ rpc } as never, {
      tripId: "trip-1",
      actorId: "traveler-1",
      itemId: "item-1",
      status: "confirmed",
      reservationAt: "2026-08-20T17:30:00.000Z",
      confirmationNumber: "ABC-123",
      bookingUrl: "https://booking.example/123",
      cancellationDeadline: "2026-08-18T17:30:00.000Z",
    });

    expect(rpc).toHaveBeenCalledWith("update_itinerary_reservation", {
      p_trip_id: "trip-1",
      p_actor_id: "traveler-1",
      p_item_id: "item-1",
      p_status: "confirmed",
      p_reservation_at: "2026-08-20T17:30:00.000Z",
      p_confirmation_number: "ABC-123",
      p_booking_url: "https://booking.example/123",
      p_cancellation_deadline: "2026-08-18T17:30:00.000Z",
      p_details_source: "organizer",
      p_organizer_verified: false,
    });
  });

  it("confirms a reservation attempt through one transactional database function", async () => {
    const confirmed = { id: "attempt-1", state: "confirmed" };
    const single = vi.fn().mockResolvedValue({ data: confirmed, error: null });
    const rpc = vi.fn().mockReturnValue({ single });

    await expect(confirmReservationAttempt({ rpc } as never, {
      tripId: "trip-1",
      actorId: "traveler-1",
      attemptId: "attempt-1",
      confirmationReference: "ABC-123",
      confirmationUrl: null,
    })).resolves.toEqual(confirmed);

    expect(rpc).toHaveBeenCalledWith("confirm_reservation_attempt", {
      p_trip_id: "trip-1",
      p_actor_id: "traveler-1",
      p_attempt_id: "attempt-1",
      p_confirmation_reference: "ABC-123",
      p_confirmation_url: null,
    });
    expect(single).toHaveBeenCalledOnce();
  });
});
