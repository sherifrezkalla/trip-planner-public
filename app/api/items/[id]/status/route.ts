import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/db";
import { authTraveler, dayCount } from "@/lib/auth";
import { canManageSchedule } from "@/lib/permissions";
import { updateItemStateSchema } from "@/lib/schema";
import { broadcastTripUpdate } from "@/lib/realtime";
import { trackEvent } from "@/lib/instrumentation";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const parsed = updateItemStateSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const db = serviceClient();
  const auth = await authTraveler(db, parsed.data.slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { trip, me } = auth;

  const { data: item, error: itemError } = await db
    .from("itinerary_items")
    .select("id, day_index, status, reservation_status, adjust_today_revision_id")
    .eq("id", id)
    .eq("trip_id", trip.id)
    .single();
  if (itemError || !item) return NextResponse.json({ error: "Activity not found" }, { status: 404 });

  let updates: Record<string, unknown>;
  if (parsed.data.action === "lock") {
    const gate = canManageSchedule({ actorIsOrganizer: me.is_organizer });
    if (!gate.allowed) return NextResponse.json({ error: gate.reason }, { status: 403 });
    if (item.status !== "planned") {
      return NextResponse.json({ error: "Only planned activities can be locked" }, { status: 409 });
    }
    if (!parsed.data.isLocked && ["tentative", "confirmed"].includes(item.reservation_status)) {
      return NextResponse.json({ error: "Active reservations stay locked until their booking status changes" }, { status: 409 });
    }
    updates = {
      is_locked: parsed.data.isLocked,
      reservation_auto_locked: false,
      adjust_today_revision_id: null,
      updated_at: new Date().toISOString(),
    };
  } else {
    const tripDays = dayCount(trip.start_date, trip.end_date);
    const completedDayIndex = parsed.data.completedDayIndex ?? item.day_index;
    if (parsed.data.status === "done" && completedDayIndex >= tripDays) {
      return NextResponse.json({ error: "Completion day is outside this trip" }, { status: 400 });
    }
    if (parsed.data.status === "skipped" && ["tentative", "confirmed"].includes(item.reservation_status)) {
      return NextResponse.json({
        error: "Change or cancel the reservation before skipping this activity",
      }, { status: 409 });
    }
    const restoreReservationLock = parsed.data.status === "planned"
      && ["tentative", "confirmed"].includes(item.reservation_status);
    updates = {
      status: parsed.data.status,
      is_locked: restoreReservationLock,
      reservation_auto_locked: restoreReservationLock,
      completed_at: parsed.data.status === "done" ? new Date().toISOString() : null,
      completed_day_index: parsed.data.status === "done" ? completedDayIndex : null,
      state_changed_by: me.id,
      adjust_today_revision_id: null,
      updated_at: new Date().toISOString(),
    };
  }

  const { error } = await db
    .from("itinerary_items")
    .update(updates)
    .eq("id", id)
    .eq("trip_id", trip.id);
  if (error?.code === "23505") {
    return NextResponse.json({ error: "That itinerary slot is already occupied" }, { status: 409 });
  }
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  const revisionId = item.adjust_today_revision_id;
  if (typeof revisionId === "string") {
    await trackEvent(db, {
      tripId: trip.id,
      actorId: me.id,
      kind: parsed.data.action === "status"
        ? parsed.data.status === "done" ? "activity_done_after_adjust" : parsed.data.status === "skipped" ? "activity_skipped_after_adjust" : "activity_changed_after_adjust"
        : "activity_changed_after_adjust",
      detail: {
        itemId: id,
        status: parsed.data.action === "status" ? parsed.data.status : "lock",
        revisionId,
      },
    });
  }
  await broadcastTripUpdate(parsed.data.slug).catch(() => {});
  return NextResponse.json({});
}
