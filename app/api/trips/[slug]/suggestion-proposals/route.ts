import { NextResponse } from "next/server";
import { authTraveler } from "@/lib/auth";
import { serviceClient } from "@/lib/db";
import { alertOrganizerInBackground } from "@/lib/organizer-alerts";
import { createSuggestionProposal } from "@/lib/persistence";
import { broadcastTripUpdate } from "@/lib/realtime";
import { createSuggestionSchema } from "@/lib/schema";
import { votesNeeded } from "@/lib/proposals";

export async function POST(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const parsed = createSuggestionSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Enter a suggestion of up to 240 characters" }, { status: 400 });
  const db = serviceClient();
  const auth = await authTraveler(db, slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  let proposalId: string;
  try {
    proposalId = await createSuggestionProposal(db, {
      tripId: auth.trip.id, proposedBy: auth.me.id, text: parsed.data.text,
    });
  } catch (error) {
    const message = (error as Error).message;
    if (/unique|duplicate/i.test(message)) return NextResponse.json({ error: "That suggestion is already awaiting a vote" }, { status: 409 });
    return NextResponse.json({ error: message }, { status: 500 });
  }
  const { count } = await db.from("travelers").select("id", { count: "exact", head: true })
    .eq("trip_id", auth.trip.id).eq("is_bot", false);
  alertOrganizerInBackground(db, { tripId: auth.trip.id, proposalId, actorId: auth.me.id,
    event: { kind: "opened", yes: 1, needed: votesNeeded(count ?? 0) } });
  await broadcastTripUpdate(slug).catch(() => {});
  return NextResponse.json({ proposalId }, { status: 201 });
}
