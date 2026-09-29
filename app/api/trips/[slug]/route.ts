import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/db";
import { authTraveler, travelerTokenFrom } from "@/lib/auth";
import { canRenameTrip } from "@/lib/permissions";
import { countVotesByTraveler } from "@/lib/roster";
import { renameTripSchema } from "@/lib/schema";
import { broadcastTripUpdate } from "@/lib/realtime";
import {
  mapBoardItemRow,
  mapBoardProposalRow,
  mapBoardTripRow,
} from "@/lib/trip-agent-read-model";

export async function GET(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const token = travelerTokenFrom(req);
  const db = serviceClient();
  const auth = await authTraveler(db, slug, token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { trip, me } = auth;

  const { data: travelers, error: travelersError } = await db
    .from("travelers")
    .select("id, display_name, interests, pace, dietary, constraints_note, is_organizer, is_bot, created_at, arrives_on, departs_on")
    .eq("trip_id", trip.id)
    .order("created_at");

  const { data: items, error: itemsError } = await db
    .from("itinerary_items")
    .select("*, venue_candidates(name, rating, review_count, price_level, opening_hours, opening_periods, lat, lng, maps_url, fetched_at, venue_candidate_categories(category)), votes(traveler_id, value), reservation_proof_artifacts(id, status, original_file_name, media_type, byte_size, created_at, uploader:travelers!reservation_proof_artifacts_uploaded_by_fkey(display_name))")
    .eq("trip_id", trip.id)
    .order("day_index")
    .order("position");

  const { data: suggestions, error: suggestionsError } = await db
    .from("trip_suggestions")
    .select("id, text, traveler_id, created_at, travelers(display_name)")
    .eq("trip_id", trip.id)
    .order("created_at");

  // Open requests only. A settled one is history, and the board is already long.
  const { data: proposals, error: proposalsError } = await db
    .from("plan_proposals")
    .select("id, item_id, proposed_by, kind, from_day_index, from_block, to_day_index, to_block, to_candidate_id, suggestion_text, note, created_at, plan_proposal_votes(traveler_id, value)")
    .eq("trip_id", trip.id)
    .eq("status", "open")
    .order("created_at");

  const { data: reservationAttempts, error: reservationAttemptsError } = await db
    .from("reservation_attempts")
    .select("*")
    .eq("trip_id", trip.id)
    .order("created_at", { ascending: false });

  const { data: revisions, error: revisionsError } = await db
    .from("itinerary_revisions")
    .select("id, day_index, reason, changes, actor_id, created_at")
    .eq("trip_id", trip.id)
    .eq("kind", "adjust_today")
    .order("created_at", { ascending: false });

  /**
   *
   * Each of these four destructured only `data`, so a failed read arrived as
   * `null`, fell through `?? []`, and rendered as an empty board with a 200 —
   * a database outage and a brand-new trip were the same response. The board is
   * the whole product surface: a traveller seeing their itinerary silently
   * empty has no way to tell that it is still there.
   *
   * Reported together rather than one at a time so a single response names
   * everything that is wrong, the way CI runs all three gates.
   */
  const failures = [
    ["travellers", travelersError],
    ["itinerary", itemsError],
    ["suggestions", suggestionsError],
    ["proposals", proposalsError],
    ["reservation assistance", reservationAttemptsError],
    ["revisions", revisionsError],
  ] as const;
  const failed = failures.filter(([, error]) => error);
  if (failed.length > 0) {
    return NextResponse.json(
      {
        error: `Could not load this trip (${failed.map(([name]) => name).join(", ")}).`,
        detail: failed.map(([name, error]) => `${name}: ${error!.message}`).join("; "),
      },
      { status: 500 },
    );
  }

  // What a `replace` proposes putting in the slot instead. That venue is
  // deliberately not in the plan yet, so it is on none of the itinerary rows
  // above and needs its own read. Without it the board can only say what would
  // be dropped, never what for — and the organizer approves from that sentence.
  const replacementIds = [...new Set(
    (proposals ?? [])
      .map((proposal) => proposal.to_candidate_id)
      .filter((id): id is string => typeof id === "string" && id.length > 0),
  )];
  const replacementNameById = new Map<string, string>();
  if (replacementIds.length > 0) {
    const { data: replacements } = await db
      .from("venue_candidates")
      .select("id, name")
      .in("id", replacementIds);
    for (const venue of (replacements ?? []) as { id: string; name: string }[]) {
      replacementNameById.set(venue.id, venue.name);
    }
  }

  type VoteRow = { traveler_id: string; value: number };

  // Counted here, not in the browser: shipping raw votes would also tell every
  // client who voted what on which stop, which the roster does not need.
  const voteCounts = countVotesByTraveler(
    (items ?? []).map((i) => ({
      votes: ((i.votes ?? []) as VoteRow[]).map((v) => ({
        travelerId: v.traveler_id,
        value: v.value,
      })),
    })),
  );
  const travelerNameById = new Map(
    (travelers ?? []).map((traveler) => [traveler.id as string, traveler.display_name as string]),
  );
  const attemptByItem = new Map<string, Record<string, unknown>>();
  for (const attempt of reservationAttempts ?? []) {
    if (!attemptByItem.has(attempt.itinerary_item_id)) attemptByItem.set(attempt.itinerary_item_id, attempt);
  }

  // A majority is a majority of people. Counting an assistant that rejoins
  // daily would raise the bar every day until the group could never carry a
  // vote on its own.
  const humanTravelerCount = (travelers ?? []).filter((t) => !t.is_bot).length;

  return NextResponse.json({
    trip: mapBoardTripRow(trip),
    me: { id: me.id, isOrganizer: me.is_organizer },
    travelers: (travelers ?? []).map((t) => ({
      id: t.id, displayName: t.display_name, interests: t.interests,
      pace: t.pace, dietary: t.dietary, isOrganizer: t.is_organizer,
      isBot: t.is_bot ?? false,
      constraintsNote: t.constraints_note ?? "",
      joinedAt: t.created_at,
      arrivesOn: t.arrives_on ?? null,
      departsOn: t.departs_on ?? null,
      voteCount: voteCounts.get(t.id) ?? 0,
    })),
    proposals: (proposals ?? []).map((proposal) => mapBoardProposalRow(proposal, {
      humanTravelerCount,
      viewerTravelerId: me.id,
      travelerNameById,
      replacementNameById,
    })),
    latestAdjustTodayRevision: (revisions?.[0] ?? null) ? {
      id: revisions![0].id,
      dayIndex: revisions![0].day_index,
      reason: revisions![0].reason ?? "",
      changes: revisions![0].changes,
      actorId: revisions![0].actor_id ?? null,
      actorName: travelerNameById.get(revisions![0].actor_id as string) ?? "Organizer",
      createdAt: revisions![0].created_at,
    } : null,
    suggestions: (suggestions ?? []).map((suggestion) => {
      const author = suggestion.travelers as unknown as { display_name: string } | null;
      return {
        id: suggestion.id,
        text: suggestion.text,
        travelerId: suggestion.traveler_id,
        displayName: author?.display_name ?? "Traveller",
        createdAt: suggestion.created_at,
        canDelete: me.is_organizer || suggestion.traveler_id === me.id,
      };
    }),
    items: (items ?? []).map((item) => mapBoardItemRow(item, {
      viewerTravelerId: me.id,
      viewerIsOrganizer: me.is_organizer,
      travelerNameById,
      reservationAttempt: attemptByItem.get(item.id) ?? null,
    })),
  });
}

/** Renames a trip. The title is what the family sees when the link is shared. */
export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const parsed = renameTripSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const db = serviceClient();
  const auth = await authTraveler(db, slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const gate = canRenameTrip({ actorIsOrganizer: auth.me.is_organizer });
  if (!gate.allowed) return NextResponse.json({ error: gate.reason }, { status: 403 });

  const { error } = await db
    .from("trips").update({ title: parsed.data.title.trim() }).eq("id", auth.trip.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await broadcastTripUpdate(slug).catch(() => {});
  return NextResponse.json({});
}
