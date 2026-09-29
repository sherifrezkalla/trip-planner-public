import type { SupabaseClient } from "@supabase/supabase-js";
import type { Block } from "./schema";
import type { ReservationStatus } from "./reservations";
import type { ProposalKind } from "./proposals";
import type { ReservationAttemptRow } from "./reservation-assistance";

export type ItineraryInsert = {
  trip_id: string;
  day_index: number;
  block: string;
  candidate_id: string;
  why_note: string;
  duration_min: number;
  position: number;
  travel_warning: boolean;
  area: string;
};

export async function replaceTripItinerary(
  db: Pick<SupabaseClient, "rpc">,
  tripId: string,
  items: ItineraryInsert[],
): Promise<void> {
  const { error } = await db.rpc("replace_trip_itinerary", {
    p_trip_id: tripId,
    p_items: items,
  });
  if (error) throw new Error(error.message);
}

export async function swapItineraryItem(
  db: Pick<SupabaseClient, "rpc">,
  args: {
    tripId: string;
    itemId: string;
    candidateId: string;
    whyNote: string;
    durationMin: number;
    area: string;
    warningUpdates: { id: string; travelWarning: boolean }[];
  },
): Promise<void> {
  const { error } = await db.rpc("swap_itinerary_item", {
    p_trip_id: args.tripId,
    p_item_id: args.itemId,
    p_candidate_id: args.candidateId,
    p_why_note: args.whyNote,
    p_duration_min: args.durationMin,
    p_area: args.area,
    p_warning_updates: args.warningUpdates.map((warning) => ({
      id: warning.id,
      travel_warning: warning.travelWarning,
    })),
  });
  if (error) throw new Error(error.message);
}

export type ItineraryMove = {
  itemId: string;
  fromDayIndex: number;
  fromBlock: Block;
  toDayIndex: number;
  toBlock: Block;
};

export type ItinerarySkip = {
  itemId: string;
  fromDayIndex: number;
  fromBlock: Block;
};

export type AdjustSwapInsert = {
  itemId: string;
  toCandidateId: string;
  fromDayIndex: number;
  fromBlock: Block;
};

/**
 * Persist a fresh adjust-today preview, superseding the day's previous open one,
 * and emit `adjust_today_previewed`. Returns the new preview id.
 */
export async function recordAdjustTodayPreview(
  db: Pick<SupabaseClient, "rpc">,
  args: {
    tripId: string;
    actorId: string;
    dayIndex: number;
    reason: string;
    fingerprint: string;
    snapshot: unknown;
    preview: unknown;
  },
): Promise<string> {
  const { data, error } = await db.rpc("record_adjust_today_preview", {
    p_trip_id: args.tripId,
    p_actor_id: args.actorId,
    p_day_index: args.dayIndex,
    p_reason: args.reason,
    p_fingerprint: args.fingerprint,
    p_snapshot: args.snapshot,
    p_preview: args.preview,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function abandonAdjustTodayPreview(
  db: Pick<SupabaseClient, "rpc">,
  args: { tripId: string; actorId: string; previewId: string },
): Promise<void> {
  const { error } = await db.rpc("abandon_adjust_today_preview", {
    p_trip_id: args.tripId,
    p_actor_id: args.actorId,
    p_preview_id: args.previewId,
  });
  if (error) throw new Error(error.message);
}

/**
 * Apply a reviewed adjust-today preview atomically.
 *
 * The DB function re-validates the reviewed snapshot against live rows, applies
 * moves/skips/swap-ins, records the audit revision, flips the preview to
 * applied, and emits `adjust_today_applied` — all in one transaction, so a
 * partial failure rolls everything back.
 */
export async function applyAdjustToday(
  db: Pick<SupabaseClient, "rpc">,
  args: {
    tripId: string;
    actorId: string;
    previewId: string;
    fingerprint: string;
    moves: ItineraryMove[];
    skips: ItinerarySkip[];
    swaps: AdjustSwapInsert[];
    reason: string;
  },
): Promise<string> {
  const { data, error } = await db.rpc("apply_adjust_today", {
    p_trip_id: args.tripId,
    p_actor_id: args.actorId,
    p_preview_id: args.previewId,
    p_fingerprint: args.fingerprint,
    p_moves: args.moves.map((move) => ({
      item_id: move.itemId,
      from_day_index: move.fromDayIndex,
      from_block: move.fromBlock,
      to_day_index: move.toDayIndex,
      to_block: move.toBlock,
    })),
    p_skips: args.skips.map((skip) => ({
      item_id: skip.itemId,
      from_day_index: skip.fromDayIndex,
      from_block: skip.fromBlock,
    })),
    p_swaps: args.swaps.map((swap) => ({
      item_id: swap.itemId,
      to_candidate_id: swap.toCandidateId,
      from_day_index: swap.fromDayIndex,
      from_block: swap.fromBlock,
    })),
    p_reason: args.reason,
  });
  if (error) throw new Error(error.message);
  return data as string;
}

export async function applyItineraryReshuffle(
  db: Pick<SupabaseClient, "rpc">,
  tripId: string,
  moves: ItineraryMove[],
): Promise<void> {
  const { error } = await db.rpc("apply_itinerary_reshuffle", {
    p_trip_id: tripId,
    p_moves: moves.map((move) => ({
      item_id: move.itemId,
      from_day_index: move.fromDayIndex,
      from_block: move.fromBlock,
      to_day_index: move.toDayIndex,
      to_block: move.toBlock,
    })),
  });
  if (error) throw new Error(error.message);
}

export async function applyPartialDayReplan(
  db: Pick<SupabaseClient, "rpc">,
  args: {
    tripId: string;
    actorId: string;
    dayIndex: number;
    currentBlock: Block;
    trigger: "running-late";
    moves: ItineraryMove[];
    skips: ItinerarySkip[];
  },
): Promise<void> {
  const { error } = await db.rpc("apply_partial_day_replan", {
    p_trip_id: args.tripId,
    p_actor_id: args.actorId,
    p_day_index: args.dayIndex,
    p_current_block: args.currentBlock,
    p_trigger: args.trigger,
    p_moves: args.moves.map((move) => ({
      item_id: move.itemId,
      from_day_index: move.fromDayIndex,
      from_block: move.fromBlock,
      to_day_index: move.toDayIndex,
      to_block: move.toBlock,
    })),
    p_skips: args.skips.map((skip) => ({
      item_id: skip.itemId,
      from_day_index: skip.fromDayIndex,
      from_block: skip.fromBlock,
    })),
  });
  if (error) throw new Error(error.message);
}

export async function updateItineraryReservation(
  db: Pick<SupabaseClient, "rpc">,
  args: {
    tripId: string;
    actorId: string;
    itemId: string;
    status: ReservationStatus;
    reservationAt: string | null;
    confirmationNumber: string | null;
    bookingUrl: string | null;
    cancellationDeadline: string | null;
    detailsSource?: "organizer" | "artifact";
    organizerVerified?: boolean;
  },
): Promise<void> {
  const { error } = await db.rpc("update_itinerary_reservation", {
    p_trip_id: args.tripId,
    p_actor_id: args.actorId,
    p_item_id: args.itemId,
    p_status: args.status,
    p_reservation_at: args.reservationAt,
    p_confirmation_number: args.confirmationNumber,
    p_booking_url: args.bookingUrl,
    p_cancellation_deadline: args.cancellationDeadline,
    p_details_source: args.detailsSource ?? "organizer",
    p_organizer_verified: args.organizerVerified ?? false,
  });
  if (error) throw new Error(error.message);
}

/**
 * Confirm the canonical reservation and its assistance audit row in the same
 * database transaction. A client-side pair of writes can strand an active
 * attempt after the itinerary has already been locked as confirmed.
 */
export async function confirmReservationAttempt(
  db: Pick<SupabaseClient, "rpc">,
  args: {
    tripId: string;
    actorId: string;
    attemptId: string;
    confirmationReference: string;
    confirmationUrl: string | null;
  },
): Promise<ReservationAttemptRow> {
  const { data, error } = await db.rpc("confirm_reservation_attempt", {
    p_trip_id: args.tripId,
    p_actor_id: args.actorId,
    p_attempt_id: args.attemptId,
    p_confirmation_reference: args.confirmationReference,
    p_confirmation_url: args.confirmationUrl,
  }).single();
  if (error) throw new Error(error.message);
  return data as ReservationAttemptRow;
}

/** The latest accepted adjust-today revision, safe for the group board. */
export async function readLatestAdjustTodayRevision(
  db: Pick<SupabaseClient, "from">,
  tripId: string,
): Promise<{
  id: string;
  day_index: number;
  reason: string;
  changes: unknown;
  actor_id: string | null;
  created_at: string;
} | null> {
  const { data, error } = await db
    .from("itinerary_revisions")
    .select("id, day_index, reason, changes, actor_id, created_at")
    .eq("trip_id", tripId)
    .eq("kind", "adjust_today")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw new Error(error.message);
  return data as {
    id: string;
    day_index: number;
    reason: string;
    changes: unknown;
    actor_id: string | null;
    created_at: string;
  } | null;
}

export async function createPlanProposal(
  db: Pick<SupabaseClient, "rpc">,
  args: {
    tripId: string;
    itemId: string;
    proposedBy: string;
    kind: ProposalKind;
    toDayIndex: number | null;
    toBlock: Block | null;
    note: string;
    toCandidateId?: string | null;
    expectedState?: Record<string, unknown>;
  },
): Promise<string> {
  const { data, error } = await db.rpc("create_plan_proposal", {
    p_trip_id: args.tripId,
    p_item_id: args.itemId,
    p_proposed_by: args.proposedBy,
    p_kind: args.kind,
    p_to_day_index: args.toDayIndex,
    p_to_block: args.toBlock,
    p_to_candidate_id: args.toCandidateId ?? null,
    p_note: args.note,
    ...(args.expectedState ? { p_expected_state: args.expectedState } : {}),
  });
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as string;
}

export async function createSuggestionProposal(
  db: Pick<SupabaseClient, "rpc">,
  args: { tripId: string; proposedBy: string; text: string; expectedState?: Record<string, unknown> },
): Promise<string> {
  const { data, error } = await db.rpc("create_suggestion_proposal", {
    p_trip_id: args.tripId,
    p_proposed_by: args.proposedBy,
    p_suggestion_text: args.text,
    ...(args.expectedState ? { p_expected_state: args.expectedState } : {}),
  });
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  return data as string;
}

/**
 * The vote tally and the roster it is measured against, from one snapshot.
 *
 * Two separate reads would take two snapshots, so a traveller joining between
 * them would give a numerator and a denominator that never coexisted. The
 * arithmetic still belongs to `lib/proposals.ts`; this only guarantees its
 * inputs describe the same instant.
 */
export async function readProposalTally(
  db: Pick<SupabaseClient, "rpc">,
  proposalId: string,
): Promise<{ votes: { traveler_id: string; value: number }[]; travelerCount: number }> {
  const { data, error } = await db.rpc("read_proposal_tally", { p_proposal_id: proposalId });
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
  const row = data as { votes?: { traveler_id: string; value: number }[]; traveler_count?: number } | null;
  return { votes: row?.votes ?? [], travelerCount: row?.traveler_count ?? 0 };
}

export async function applyPlanProposal(
  db: Pick<SupabaseClient, "rpc">,
  args: { proposalId: string; actorId: string; resolution: string },
): Promise<void> {
  const { error } = await db.rpc("apply_plan_proposal", {
    p_proposal_id: args.proposalId,
    p_actor_id: args.actorId,
    p_resolution: args.resolution,
  });
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
}

export async function closePlanProposal(
  db: Pick<SupabaseClient, "rpc">,
  args: {
    proposalId: string;
    actorId: string;
    status: "rejected" | "cancelled";
    resolution: string;
  },
): Promise<void> {
  const { error } = await db.rpc("close_plan_proposal", {
    p_proposal_id: args.proposalId,
    p_actor_id: args.actorId,
    p_status: args.status,
    p_resolution: args.resolution,
  });
  if (error) throw Object.assign(new Error(error.message), { code: error.code });
}
