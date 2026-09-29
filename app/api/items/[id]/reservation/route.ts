import { NextResponse } from "next/server";
import { authTraveler } from "@/lib/auth";
import { serviceClient } from "@/lib/db";
import { updateItineraryReservation } from "@/lib/persistence";
import { canManageSchedule } from "@/lib/permissions";
import { broadcastTripUpdate } from "@/lib/realtime";
import { updateReservationSchema } from "@/lib/schema";

export async function PATCH(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const parsed = updateReservationSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    const message = parsed.error.issues[0]?.message ?? "Invalid reservation";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  const db = serviceClient();
  const auth = await authTraveler(db, parsed.data.slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const gate = canManageSchedule({ actorIsOrganizer: auth.me.is_organizer });
  if (!gate.allowed) return NextResponse.json({ error: gate.reason }, { status: 403 });

  try {
    await updateItineraryReservation(db, {
      tripId: auth.trip.id,
      actorId: auth.me.id,
      itemId: id,
      status: parsed.data.status,
      reservationAt: parsed.data.status === "none" ? null : parsed.data.reservationAt,
      confirmationNumber: parsed.data.status === "none"
        ? null
        : parsed.data.confirmationNumber || null,
      bookingUrl: parsed.data.status === "none" ? null : parsed.data.bookingUrl || null,
      cancellationDeadline: parsed.data.status === "none"
        ? null
        : parsed.data.cancellationDeadline,
      detailsSource: parsed.data.status === "none" ? "organizer" : parsed.data.detailsSource,
      organizerVerified: parsed.data.status === "none" ? false : parsed.data.organizerVerified,
    });
  } catch (error) {
    const message = (error as Error).message;
    const status = /not found/i.test(message) ? 404
      : /organizer/i.test(message) ? 403
        : /invalid|require|http/i.test(message) ? 400
          : 500;
    return NextResponse.json({ error: message }, { status });
  }

  await broadcastTripUpdate(parsed.data.slug).catch(() => {});
  return NextResponse.json({});
}
