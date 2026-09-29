import { NextResponse } from "next/server";
import { z } from "zod";
import { serviceClient } from "@/lib/db";
import { authTraveler, dayCount, type TravelerRow } from "@/lib/auth";
import { getCallers } from "@/lib/llm";
import { arrangeSwap, filterSwapCandidates, travelWarnings } from "@/lib/generate";
import { canSwap } from "@/lib/permissions";
import { broadcastTripUpdate } from "@/lib/realtime";
import { swapItineraryItem } from "@/lib/persistence";
import { venueRowToCandidate, type PlaceCandidate } from "@/lib/places";
import type { Block, TravelerPrefs } from "@/lib/schema";

export const maxDuration = 180;

const swapReqSchema = z.object({ slug: z.string().min(1), token: z.string().min(1) });

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const parsed = swapReqSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const db = serviceClient();
  const auth = await authTraveler(db, parsed.data.slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { trip } = auth;

  const { data: item } = await db
    .from("itinerary_items").select("*").eq("id", id).eq("trip_id", trip.id).single();
  if (!item) return NextResponse.json({ error: "Item not found" }, { status: 404 });
  if (item.status !== "planned" || item.is_locked) {
    return NextResponse.json({ error: "Completed, skipped, or locked activities cannot be swapped" }, { status: 409 });
  }

  const [{ data: travelerRows }, { data: candRows }, { data: usedRows }, { data: voteRows }] =
    await Promise.all([
      db.from("travelers").select("*").eq("trip_id", trip.id),
      db.from("venue_candidates").select("*, venue_candidate_categories(category)").eq("trip_id", trip.id),
      db.from("itinerary_items").select("id, candidate_id, day_index, block, position, area").eq("trip_id", trip.id).eq("status", "planned"),
      db.from("votes").select("value").eq("item_id", id),
    ]);

  // Gate before any model call: cheaper, and the reason is clearer than a late failure.
  const gate = canSwap({
    voteSum: (voteRows ?? []).reduce((sum, v) => sum + (v.value as number), 0),
    isOrganizer: auth.me.is_organizer,
    travelerCount: (travelerRows ?? []).length,
  });
  if (!gate.allowed) return NextResponse.json({ error: gate.reason }, { status: 403 });

  const candidates: PlaceCandidate[] = (candRows ?? []).map(venueRowToCandidate);
  const byId = new Map(candidates.map((candidate) => [candidate.placeId, candidate]));
  const usedIds = new Set((usedRows ?? []).map((row) => row.candidate_id as string));
  const currentCandidate = byId.get(item.candidate_id as string);
  const dayArea = (item.area as string | null) || currentCandidate?.area || trip.destination_name;
  const otherDayStops = (usedRows ?? [])
    .filter((row) => row.day_index === item.day_index && row.id !== item.id)
    .map((row) => byId.get(row.candidate_id as string))
    .filter((candidate): candidate is PlaceCandidate => candidate !== undefined);
  const allowed = filterSwapCandidates({
    candidates,
    usedIds,
    area: dayArea,
    otherDayStops,
    startDate: trip.start_date,
    dayIndex: item.day_index,
    block: item.block as Block,
  });
  if (allowed.length === 0) {
    return NextResponse.json({ error: "No alternative venues left to swap in" }, { status: 502 });
  }

  const travelers: TravelerPrefs[] = ((travelerRows ?? []) as TravelerRow[]).map((t) => ({
    displayName: t.display_name, interests: t.interests, pace: t.pace,
    dietary: t.dietary, constraintsNote: t.constraints_note,
  }));

  let swapResult: Awaited<ReturnType<typeof arrangeSwap>>;
  try {
    swapResult = await arrangeSwap({
      trip: {
        destinationName: trip.destination_name, startDate: trip.start_date, endDate: trip.end_date,
        budgetLevel: trip.budget_level, vibeNote: trip.vibe_note,
        dayCount: dayCount(trip.start_date, trip.end_date),
      },
      travelers,
      allowed,
      block: item.block as Block,
      dayIndex: item.day_index,
      callers: getCallers(),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 502 });
  }

  const { swap, usedFallback } = swapResult;
  const replacement = byId.get(swap.candidateId)!;
  const dayRows = (usedRows ?? [])
    .filter((row) => row.day_index === item.day_index)
    .sort((a, b) => (a.position as number) - (b.position as number));
  const warningPlan = {
    days: [{
      dayIndex: item.day_index,
      area: dayArea,
      blocks: dayRows.map((row) => ({
        block: row.block as Block,
        candidateId: row.id === item.id ? swap.candidateId : row.candidate_id as string,
        whyNote: "",
        durationMin: 1,
      })),
    }],
  };
  const warned = travelWarnings(warningPlan, byId);
  try {
    await swapItineraryItem(db, {
      tripId: trip.id,
      itemId: id,
      candidateId: swap.candidateId,
      whyNote: swap.whyNote,
      durationMin: swap.durationMin,
      area: replacement.area ?? dayArea,
      warningUpdates: dayRows.map((row) => ({
        id: row.id as string,
        travelWarning: warned.has(row.id === item.id ? swap.candidateId : row.candidate_id as string),
      })),
    });
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 });
  }

  await broadcastTripUpdate(parsed.data.slug).catch(() => {});
  return NextResponse.json({ usedFallback });
}
