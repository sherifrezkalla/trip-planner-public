import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/db";
import { authTraveler, dayCount } from "@/lib/auth";
import { canManageSchedule } from "@/lib/permissions";
import { applyItineraryReshuffle, applyPartialDayReplan } from "@/lib/persistence";
import { buildPartialDayPreview, type PartialDayItem } from "@/lib/partial-day";
import { buildReshufflePreview, type ReshuffleItem } from "@/lib/reshuffle";
import { reshuffleRequestSchema, type Block } from "@/lib/schema";
import { broadcastTripUpdate } from "@/lib/realtime";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const parsed = reshuffleRequestSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid reshuffle request" }, { status: 400 });

  const db = serviceClient();
  const auth = await authTraveler(db, slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const gate = canManageSchedule({ actorIsOrganizer: auth.me.is_organizer });
  if (!gate.allowed) return NextResponse.json({ error: gate.reason }, { status: 403 });

  const tripDays = dayCount(auth.trip.start_date, auth.trip.end_date);
  if (parsed.data.action === "preview" || parsed.data.action === "preview-partial-day") {
    if (parsed.data.currentDayIndex >= tripDays) {
      return NextResponse.json({ error: "Current day is outside this trip" }, { status: 400 });
    }
    const { data, error } = await db
      .from("itinerary_items")
      .select("id, day_index, block, position, duration_min, status, is_locked, completed_day_index, venue_candidates(name, opening_periods), votes(value)")
      .eq("trip_id", auth.trip.id)
      .order("day_index")
      .order("position");
    if (error) return NextResponse.json({ error: "Could not read the itinerary" }, { status: 503 });

    if (parsed.data.action === "preview-partial-day") {
      const items: PartialDayItem[] = (data ?? []).map((item) => {
        const venue = item.venue_candidates as unknown as {
          name: string;
          opening_periods: PartialDayItem["openingPeriods"] | null;
        } | null;
        const votes = item.votes as unknown as { value: number }[] | null;
        return {
          id: item.id as string,
          dayIndex: item.day_index as number,
          block: item.block as Block,
          position: item.position as number,
          status: item.status as PartialDayItem["status"],
          isLocked: item.is_locked as boolean,
          venueName: venue?.name ?? "Activity",
          voteSum: (votes ?? []).reduce((sum, vote) => sum + vote.value, 0),
          durationMin: item.duration_min as number,
          openingPeriods: venue?.opening_periods ?? [],
        };
      });
      const preview = buildPartialDayPreview({
        items,
        startDate: auth.trip.start_date,
        dayIndex: parsed.data.currentDayIndex,
        currentBlock: parsed.data.currentBlock,
      });
      const nameById = new Map(items.map((item) => [item.id, item.venueName]));
      return NextResponse.json({
        ...preview,
        moves: preview.moves.map((move) => ({
          ...move,
          venueName: nameById.get(move.itemId) ?? "Activity",
        })),
      });
    }

    const items: ReshuffleItem[] = (data ?? []).map((item) => {
      const venue = item.venue_candidates as unknown as { name: string } | null;
      return {
        id: item.id as string,
        dayIndex: item.day_index as number,
        block: item.block as Block,
        status: item.status as ReshuffleItem["status"],
        isLocked: item.is_locked as boolean,
        completedDayIndex: item.completed_day_index as number | null,
        venueName: venue?.name ?? "Activity",
      };
    });
    const preview = buildReshufflePreview(items, parsed.data.currentDayIndex, tripDays);
    const nameById = new Map(items.map((item) => [item.id, item.venueName]));
    return NextResponse.json({
      kind: "reshuffle",
      ...preview,
      moves: preview.moves.map((move) => ({ ...move, venueName: nameById.get(move.itemId) ?? "Activity" })),
    });
  }

  if (parsed.data.action === "apply-partial-day") {
    const request = parsed.data;
    const invalidMove = request.moves.some((move) =>
      move.fromDayIndex !== request.dayIndex
      || move.toDayIndex !== request.dayIndex
      || move.toBlock === move.fromBlock,
    );
    const invalidSkip = request.skips.some((skip) => skip.fromDayIndex !== request.dayIndex);
    if (request.dayIndex >= tripDays || invalidMove || invalidSkip) {
      return NextResponse.json({ error: "Today repair contains an invalid change" }, { status: 400 });
    }
    try {
      await applyPartialDayReplan(db, {
        tripId: auth.trip.id,
        actorId: auth.me.id,
        dayIndex: request.dayIndex,
        currentBlock: request.currentBlock,
        trigger: request.trigger,
        moves: request.moves,
        skips: request.skips,
      });
    } catch (error) {
      const message = (error as Error).message;
      const status = /stale|occupied|duplicate|invalid|protected|organizer|destination/i.test(message) ? 409 : 500;
      return NextResponse.json({
        error: status === 409 ? "The plan changed. Preview today again." : message,
      }, { status });
    }
    await broadcastTripUpdate(slug).catch(() => {});
    return NextResponse.json({});
  }

  if (parsed.data.moves.some((move) => move.toDayIndex >= tripDays || move.toBlock !== move.fromBlock)) {
    return NextResponse.json({ error: "Reshuffle contains an invalid destination" }, { status: 400 });
  }
  try {
    await applyItineraryReshuffle(db, auth.trip.id, parsed.data.moves);
  } catch (error) {
    const message = (error as Error).message;
    const status = /stale|vacant|duplicate|invalid/i.test(message) ? 409 : 500;
    return NextResponse.json({ error: status === 409 ? "The plan changed. Preview the reshuffle again." : message }, { status });
  }

  await broadcastTripUpdate(slug).catch(() => {});
  return NextResponse.json({});
}
