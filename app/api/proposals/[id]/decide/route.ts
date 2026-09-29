import { NextResponse } from "next/server";
import { serviceClient } from "@/lib/db";
import { authTraveler } from "@/lib/auth";
import { canManageSchedule } from "@/lib/permissions";
import { settleProposal, type ProposalRow } from "@/lib/proposal-actions";
import { decideProposalSchema } from "@/lib/schema";
import { broadcastTripUpdate } from "@/lib/realtime";

/**
 * The organiser's verdict on a proposal, which needs no votes either way.
 *
 * Staleness still outranks it: approving a move onto a slot that filled
 * yesterday cancels the request and says why, rather than forcing it through.
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const { id } = await params;
  const parsed = decideProposalSchema.safeParse(await req.json().catch(() => null));
  if (!parsed.success) return NextResponse.json({ error: "Invalid decision" }, { status: 400 });

  const db = serviceClient();
  const auth = await authTraveler(db, parsed.data.slug, parsed.data.token);
  if ("error" in auth) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const gate = canManageSchedule({ actorIsOrganizer: auth.me.is_organizer });
  if (!gate.allowed || auth.me.is_bot) {
    return NextResponse.json({ error: "Only the organiser can decide a request" }, { status: 403 });
  }

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

  let result;
  try {
    result = await settleProposal(db, {
      proposal: proposal as unknown as ProposalRow,
      actorId: auth.me.id,
      force: parsed.data.decision,
    });
  } catch (error) {
    return NextResponse.json({ error: (error as Error).message }, { status: 500 });
  }

  await broadcastTripUpdate(parsed.data.slug).catch(() => {});
  return NextResponse.json(result);
}
