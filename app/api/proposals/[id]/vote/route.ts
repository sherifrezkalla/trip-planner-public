import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/db";
import { authTraveler } from "@/lib/auth";
import { settleProposal, type ProposalRow } from "@/lib/proposal-actions";
import { voteProposalSchema } from "@/lib/schema";
import { broadcastTripUpdate } from "@/lib/realtime";
import { alertOrganizerInBackground } from "@/lib/organizer-alerts";

/**
 * Vote on an open proposal.
 *
 * The vote is recorded and the proposal is settled in the same request, so the
 * traveller who casts the deciding vote sees the plan change rather than
 * waiting for something else to notice.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const parsed = voteProposalSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid vote" }, { status: 400 });

  const db = serviceClient();
  const auth = await authTraveler(db, parsed.data.slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (auth.me.is_bot) return NextResponse.json({ error: "Automated travelers cannot vote" }, { status: 403 });

  const { data: proposal } = await db
    .from("plan_proposals")
    .select("id, trip_id, item_id, proposed_by, kind, from_day_index, from_block, to_day_index, to_block, to_candidate_id, suggestion_text, note, status")
    .eq("id", id)
    .eq("trip_id", auth.trip.id)
    .maybeSingle();
  if (!proposal) return NextResponse.json({ error: "Request not found" }, { status: 404 });
  if (proposal.status !== "open") {
    return NextResponse.json({ error: "That request has already been decided" }, { status: 409 });
  }

  const { error: voteError } = await db
    .from("plan_proposal_votes")
    .upsert(
      { proposal_id: id, traveler_id: auth.me.id, value: parsed.data.value },
      { onConflict: "proposal_id,traveler_id" },
    );
  if (voteError) return NextResponse.json({ error: "Could not record that vote" }, { status: 500 });

  let result;
  try {
    result = await settleProposal(db, {
      proposal: proposal as unknown as ProposalRow,
      actorId: auth.me.id,
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  // The organiser hears about a vote only when it settled something. A running
  // tally would be a stream of noise for a channel they must keep reading.
  if (result.status === "applied") {
    // The roster comes back with the verdict rather than from a fresh count, so
    // the organiser is told the same "x of y" the decision was actually made on.
    alertOrganizerInBackground(db, {
      tripId: auth.trip.id,
      proposalId: id,
      actorId: auth.me.id,
      event: { kind: "applied-by-vote", yes: result.yes, travelerCount: result.travelerCount },
    });
  } else if (result.status === "cancelled") {
    alertOrganizerInBackground(db, {
      tripId: auth.trip.id,
      proposalId: id,
      actorId: auth.me.id,
      event: { kind: "cancelled", reason: result.reason },
    });
  }

  await broadcastTripUpdate(parsed.data.slug).catch(() => {});
  return NextResponse.json(result);
}
