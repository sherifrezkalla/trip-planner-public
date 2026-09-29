/**
 * Reading a proposal against the live plan and acting on the result.
 *
 * The rules are in `proposals.ts`, which stays pure. This is the I/O half: load
 * what the rules need, ask them, then write. Both the vote route and the
 * organiser's decision route come through here so a proposal is settled the
 * same way however it was decided.
 */

import type { SupabaseClient } from "@supabase/supabase-js";
import { readProposalTally } from "./persistence";
import {
  resolveProposal,
  tallyProposal,
  type PlanFacts,
  type ProposalKind,
  type ProposalTarget,
  type ProposalVote,
} from "./proposals";
import type { Block } from "./schema";
import { getTripTiming } from "./today";

export type ProposalRow = {
  id: string;
  trip_id: string;
  item_id: string | null;
  proposed_by: string;
  kind: ProposalKind;
  from_day_index: number | null;
  from_block: Block | null;
  to_day_index: number | null;
  to_block: Block | null;
  to_candidate_id: string | null;
  suggestion_text?: string | null;
  note: string | null;
  status: string;
};

export type SettleResult = {
  reasonCode: "awaiting_vote" | "approved" | "rejected" | "proposal_stale" | "reservation_locked" | "destination_occupied";
  status: "open" | "applied" | "rejected" | "cancelled";
  reason: string;
  yes: number;
  no: number;
  needed: number;
  /**
   * The denominator the verdict was measured against. Returned so callers
   * report the same roster the decision used instead of counting again.
   */
  travelerCount: number;
};
export type GatewaySettlementContext = {
  actionId: string; connectionId: string; tripId: string; actorDigest: string; groupDigest: string;
};

/**
 * Decide what should happen to one open proposal, and make it happen.
 *
 * `force` carries the organiser's own verdict, which needs no votes. Staleness
 * still wins over it: approving a request to move something the group already
 * did should cancel, not apply.
 */
export async function settleProposal(
  db: SupabaseClient,
  args: { proposal: ProposalRow; actorId: string; force?: "approve" | "reject"; gateway?: GatewaySettlementContext },
): Promise<SettleResult> {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await settleProposalAttempt(db, args);
    } catch (error) {
      if ((error as { code?: string }).code !== "TP008") throw error;
    }
  }
  // A drift aborts the entire SQL transaction. Executing gateway actions stay
  // executing so an exact retry can safely recover; never re-claim execution.
  throw new Error("database_unavailable");
}

async function settleProposalAttempt(
  db: SupabaseClient,
  args: Parameters<typeof settleProposal>[1],
): Promise<SettleResult> {
  const { proposal, actorId } = args;
  async function finish(result: SettleResult): Promise<SettleResult> {
    if (args.gateway) {
      const g = args.gateway;
      const { error } = await db.rpc("settle_trip_agent_proposal_action", {
        p_action_id: g.actionId, p_connection_id: g.connectionId, p_trip_id: g.tripId,
        p_actor_digest: g.actorDigest, p_group_digest: g.groupDigest,
        p_proposal_id: proposal.id, p_actor_id: actorId, p_force: args.force ?? null,
        p_resolution: result.reason,
        p_settlement: { status: result.status, reasonCode: result.reasonCode, yes: result.yes,
          no: result.no, needed: result.needed, travelerCount: result.travelerCount },
      });
      if (error) throw Object.assign(new Error("database_unavailable"), { code: error.code });
    } else {
      const { reason, ...settlement } = result;
      const { error } = await db.rpc("settle_plan_proposal_guarded", {
        p_proposal_id: proposal.id, p_actor_id: actorId, p_force: args.force ?? null,
        p_resolution: reason, p_settlement: settlement,
      });
      if (error) throw Object.assign(new Error("database_unavailable"), { code: error.code });
    }
    return result;
  }

  if (proposal.kind === "suggest") {
    const voteState = await readProposalTally(db, proposal.id);
    const votes: ProposalVote[] = voteState.votes.map((row) => ({
      travelerId: row.traveler_id, value: row.value === 1 ? 1 : -1,
    }));
    const tally = tallyProposal({ votes, travelerCount: voteState.travelerCount });
    if (args.force === "reject" || (!args.force && tally.outcome === "reject")) {
      const reason = args.force === "reject" ? "Turned down by the organiser." : `Turned down by group vote, ${tally.no} of ${voteState.travelerCount}.`;
      return finish({ status: "rejected", reasonCode: "rejected", reason, ...counts(tally, voteState.travelerCount) });
    }
    if (args.force === "approve" || tally.outcome === "apply") {
      const reason = args.force === "approve" ? "Approved by the organiser." : `Applied by group vote, ${tally.yes} of ${voteState.travelerCount}.`;
      return finish({ status: "applied", reasonCode: "approved", reason, ...counts(tally, voteState.travelerCount) });
    }
    return finish({ status: "open", reasonCode: "awaiting_vote", reason: "Waiting for the group.", ...counts(tally, voteState.travelerCount) });
  }

  // The tally and the roster it is measured against come from one statement, so
  // they describe the same instant. Read separately they would not: a traveller
  // joining between the two would raise the threshold under a majority already
  // counted against the old one. Humans only — an automated traveller must not
  // raise the bar a real majority has to clear.
  const [voteState, itemRead, tripRead] = await Promise.all([
    readProposalTally(db, proposal.id),
    db
      .from("itinerary_items")
      .select("status, is_locked, reservation_status, day_index, block")
      .eq("id", proposal.item_id as string)
      .eq("trip_id", proposal.trip_id)
      .maybeSingle(),
    db.from("trips").select("start_date, end_date").eq("id", proposal.trip_id).single(),
  ]);
  if (itemRead.error || tripRead.error || !tripRead.data) throw new Error("database_unavailable");
  const itemRow = itemRead.data;
  const tripRow = tripRead.data;

  if (!itemRow) {
    const tally = tallyProposal({ votes: voteState.votes.map(row => ({ travelerId: row.traveler_id, value: row.value === 1 ? 1 : -1 })), travelerCount: voteState.travelerCount });
    return finish({
      status: "cancelled",
      reason: "Cancelled — that activity is no longer in the plan.",
      reasonCode: "proposal_stale",
      ...counts(tally, voteState.travelerCount),
    });
  }

  const votes: ProposalVote[] = voteState.votes.map((row) => ({
    travelerId: row.traveler_id,
    value: row.value === 1 ? 1 : -1,
  }));
  const travelerCount = voteState.travelerCount;

  let destinationOccupied = false;
  if (proposal.kind === "move") {
    const destination = await db
            .from("itinerary_items")
            .select("id")
            .eq("trip_id", proposal.trip_id)
            .eq("status", "planned")
            .eq("day_index", proposal.to_day_index as number)
            .eq("block", proposal.to_block as string)
            .neq("id", proposal.item_id);
    if (destination.error || !destination.data) throw new Error("database_unavailable");
    destinationOccupied = destination.data.length > 0;
  }

  // Only asked for a substitution, and only then: two extra reads on every
  // settle would be waste on the kinds that cannot use them.
  let replacementMissing = false;
  let replacementAlreadyPlanned = false;
  if (proposal.kind === "replace" && proposal.to_candidate_id) {
    const [candidateRead, standingRead] = await Promise.all([
      db.from("venue_candidates").select("id")
        .eq("id", proposal.to_candidate_id).eq("trip_id", proposal.trip_id).maybeSingle(),
      db.from("itinerary_items").select("id")
        .eq("trip_id", proposal.trip_id).eq("status", "planned")
        .eq("candidate_id", proposal.to_candidate_id).neq("id", proposal.item_id),
    ]);
    if (candidateRead.error || standingRead.error || !standingRead.data) throw new Error("database_unavailable");
    replacementMissing = !candidateRead.data;
    replacementAlreadyPlanned = standingRead.data.length > 0;
  }

  const timing = getTripTiming(
    tripRow.start_date as string,
    tripRow.end_date as string,
  );

  const target: ProposalTarget = {
    kind: proposal.kind,
    fromDayIndex: proposal.from_day_index as number,
    fromBlock: proposal.from_block as Block,
    toDayIndex: proposal.to_day_index,
    toBlock: proposal.to_block,
    toCandidateId: proposal.to_candidate_id,
  };
  const facts: PlanFacts = {
    itemStatus: itemRow.status as PlanFacts["itemStatus"],
    itemIsLocked: itemRow.is_locked as boolean,
    itemReservationStatus: itemRow.reservation_status as string,
    itemDayIndex: itemRow.day_index as number,
    itemBlock: itemRow.block as Block,
    destinationOccupied,
    replacementMissing,
    replacementAlreadyPlanned,
    // Before departure nothing has passed yet, so no day can be in the past.
    currentDayIndex: timing.phase === "before" ? -1 : timing.dayIndex,
  };

  const resolved = resolveProposal({ target, facts, votes, travelerCount });
  const tally = resolved.tally;

  // Staleness outranks the organiser: approving a move onto a slot that filled
  // yesterday should tell the group why, not force it through.
  if (resolved.status === "cancelled") {
    const reasonCode = facts.itemStatus !== "planned" ? "proposal_stale"
      : facts.itemIsLocked || ["tentative", "confirmed"].includes(facts.itemReservationStatus) ? "reservation_locked"
      : facts.itemDayIndex !== target.fromDayIndex || facts.itemBlock !== target.fromBlock ? "proposal_stale"
      : facts.destinationOccupied || facts.replacementAlreadyPlanned ? "destination_occupied" : "proposal_stale";
    return finish({ status: "cancelled", reasonCode, reason: resolved.reason, ...counts(tally, travelerCount) });
  }

  if (args.force === "reject") {
    const reason = "Turned down by the organiser.";
    return finish({ status: "rejected", reasonCode: "rejected", reason, ...counts(tally, travelerCount) });
  }

  if (args.force === "approve" || resolved.status === "applied") {
    const reason = args.force === "approve" ? "Approved by the organiser." : resolved.reason;
    return finish({ status: "applied", reasonCode: "approved", reason, ...counts(tally, travelerCount) });
  }

  if (resolved.status === "rejected") {
    return finish({ status: "rejected", reasonCode: "rejected", reason: resolved.reason, ...counts(tally, travelerCount) });
  }

  return finish({ status: "open", reasonCode: "awaiting_vote", reason: resolved.reason, ...counts(tally, travelerCount) });
}

function counts(tally: { yes: number; no: number; needed: number }, travelerCount: number) {
  return { yes: tally.yes, no: tally.no, needed: tally.needed, travelerCount };
}
