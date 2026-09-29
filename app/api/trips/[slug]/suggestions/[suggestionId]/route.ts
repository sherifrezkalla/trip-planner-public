import { NextResponse } from "next/server";
import { authTraveler } from "@/lib/auth";
import { serviceClient } from "@/lib/db";
import { canDeleteSuggestion } from "@/lib/permissions";
import { broadcastTripUpdate } from "@/lib/realtime";
import { deleteSuggestionSchema } from "@/lib/schema";

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ slug: string; suggestionId: string }> },
): Promise<NextResponse> {
  const { slug, suggestionId } = await params;
  const parsed = deleteSuggestionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid payload" }, { status: 400 });

  const db = serviceClient();
  const auth = await authTraveler(db, slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { data: suggestion, error: readError } = await db
    .from("trip_suggestions")
    .select("id, traveler_id")
    .eq("id", suggestionId)
    .eq("trip_id", auth.trip.id)
    .single();
  if (readError || !suggestion) {
    return NextResponse.json({ error: "Suggestion not found" }, { status: 404 });
  }

  const gate = canDeleteSuggestion({
    actorIsOrganizer: auth.me.is_organizer,
    actorId: auth.me.id,
    suggestionOwnerId: suggestion.traveler_id,
  });
  if (!gate.allowed) return NextResponse.json({ error: gate.reason }, { status: 403 });

  const { error } = await db
    .from("trip_suggestions")
    .delete()
    .eq("id", suggestionId)
    .eq("trip_id", auth.trip.id);
  if (error) return NextResponse.json({ error: error.message }, { status: 500 });

  await broadcastTripUpdate(slug).catch(() => {});
  return NextResponse.json({});
}
