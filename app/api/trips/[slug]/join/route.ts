import { NextResponse } from "next/server";
import { joinTripSchema } from "@/lib/schema";
import { makeToken } from "@/lib/ids";
import { serviceClient } from "@/lib/db";
import { broadcastTripUpdate } from "@/lib/realtime";

export async function POST(
  req: Request,
  { params }: { params: Promise<{ slug: string }> },
): Promise<NextResponse> {
  const { slug } = await params;
  const parsed = joinTripSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.issues[0]?.message ?? "Invalid payload" }, { status: 400 });
  }
  const db = serviceClient();
  const token = makeToken();
  // The database locks the trip row while deciding whether this is the first
  // traveler, so two simultaneous joins can never both become organizer.
  const { data, error } = await db.rpc("join_trip", {
    p_slug: slug,
    p_display_name: parsed.data.displayName,
    p_token: token,
    p_interests: parsed.data.interests,
    p_pace: parsed.data.pace,
    p_dietary: parsed.data.dietary,
    p_constraints_note: parsed.data.constraintsNote,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });
  const created = (data as { traveler_id: string; is_organizer: boolean }[] | null)?.[0];
  if (!created) return NextResponse.json({ error: "Trip not found" }, { status: 404 });

  // Set after the fact rather than threading a flag through join_trip, whose
  // job is deciding the organizer under a row lock. Failing here leaves an
  // unflagged traveller the organiser can flag from the roster, which is a
  // better outcome than refusing the join.
  if (parsed.data.isBot) {
    await db.from("travelers").update({ is_bot: true }).eq("id", created.traveler_id);
  }
  await broadcastTripUpdate(slug).catch(() => {});
  return NextResponse.json({
    token,
    travelerId: created.traveler_id,
    isOrganizer: created.is_organizer,
  }, { status: 201 });
}
