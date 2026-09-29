import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/db";
import { authTraveler, dayCount } from "@/lib/auth";
import { canManageSchedule } from "@/lib/permissions";
import { applyItineraryReshuffle } from "@/lib/persistence";
import { moveItemSchema } from "@/lib/schema";
import { broadcastTripUpdate } from "@/lib/realtime";
import { takeAdjustAttribution, trackEvent } from "@/lib/instrumentation";

/**
 * Move one activity to another slot.
 *
 * Deliberately not part of the reshuffle route: that one plans a whole sweep.
 * This is the hand-picked case — one stop, one destination, no model call.
 *
 * Organizer-only, like every other write to the canonical plan. Travellers will
 * reach this through proposals and group votes rather than by writing directly.
 *
 * The protections come from `apply_itinerary_reshuffle`, which already refuses
 * anything that is not planned, is locked, has drifted from the slot the caller
 * saw, or targets an occupied slot. Passing a single move through it keeps one
 * set of rules rather than a second, weaker copy.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const parsed = moveItemSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid move" }, { status: 400 });

  const db = serviceClient();
  const auth = await authTraveler(db, parsed.data.slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { trip, me } = auth;

  const gate = canManageSchedule({ actorIsOrganizer: me.is_organizer });
  if (!gate.allowed) return NextResponse.json({ error: gate.reason }, { status: 403 });

  const { fromDayIndex, fromBlock, toDayIndex, toBlock } = parsed.data;
  if (fromDayIndex === toDayIndex && fromBlock === toBlock) {
    return NextResponse.json({ error: "That activity is already in this slot" }, { status: 400 });
  }
  if (toDayIndex >= dayCount(trip.start_date, trip.end_date)) {
    return NextResponse.json({ error: "That day is outside this trip" }, { status: 400 });
  }

  try {
    await applyItineraryReshuffle(db, trip.id, [
      { itemId: id, fromDayIndex, fromBlock, toDayIndex, toBlock },
    ]);
  } catch (error) {
    const message = (error as Error).message;
    if (/occupied/i.test(message)) {
      return NextResponse.json({ error: "Something is already in that slot" }, { status: 409 });
    }
    if (/stale|invalid/i.test(message)) {
      return NextResponse.json({
        error: "That activity is completed, skipped, locked, or has already moved.",
      }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const revisionId = await takeAdjustAttribution(db, { tripId: trip.id, itemId: id });
  if (revisionId) {
    await trackEvent(db, {
      tripId: trip.id,
      actorId: me.id,
      kind: "activity_changed_after_adjust",
      detail: { itemId: id, fromDayIndex, fromBlock, toDayIndex, toBlock, revisionId },
    });
  }
  await broadcastTripUpdate(parsed.data.slug).catch(() => {});
  return NextResponse.json({});
}
