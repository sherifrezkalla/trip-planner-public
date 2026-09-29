import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/db";
import { authTraveler, dayCount } from "@/lib/auth";
import { createPlanProposal } from "@/lib/persistence";
import { createProposalSchema } from "@/lib/schema";
import { broadcastTripUpdate } from "@/lib/realtime";
import { alertOrganizerInBackground } from "@/lib/organizer-alerts";
import { votesNeeded } from "@/lib/proposals";

/**
 * Ask the group to move or drop one activity.
 *
 * Open to every traveller — this is the path that replaces writing to the plan
 * directly. Nothing changes until the organiser approves or more than half the
 * travellers vote for it.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const parsed = createProposalSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid request" }, { status: 400 });

  const db = serviceClient();
  const auth = await authTraveler(db, parsed.data.slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  const { trip, me } = auth;

  if (parsed.data.kind === "move" && parsed.data.toDayIndex >= dayCount(trip.start_date, trip.end_date)) {
    return NextResponse.json({ error: "That day is outside this trip" }, { status: 400 });
  }

  let proposalId: string;
  try {
    proposalId = await createPlanProposal(db, {
      tripId: trip.id,
      itemId: id,
      proposedBy: me.id,
      kind: parsed.data.kind,
      toDayIndex: parsed.data.kind === "move" ? parsed.data.toDayIndex : null,
      toBlock: parsed.data.kind === "move" ? parsed.data.toBlock : null,
      toCandidateId: parsed.data.kind === "replace" ? parsed.data.toCandidateId : null,
      note: parsed.data.note ?? "",
    });
  } catch (error) {
    const message = (error as Error).message;
    if (/already in this slot/i.test(message)) {
      return NextResponse.json({ error: "That activity is already in this slot" }, { status: 400 });
    }
    if (/cannot be changed/i.test(message)) {
      return NextResponse.json({
        error: "That activity is completed, removed, locked, or booked.",
      }, { status: 409 });
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }

  const { count } = await db
    .from("travelers")
    .select("id", { count: "exact", head: true })
    .eq("trip_id", trip.id)
    .eq("is_bot", false);
  alertOrganizerInBackground(db, {
    tripId: trip.id,
    proposalId,
    actorId: me.id,
    event: { kind: "opened", yes: 1, needed: votesNeeded(count ?? 0) },
  });

  await broadcastTripUpdate(parsed.data.slug).catch(() => {});
  return NextResponse.json({ proposalId });
}
