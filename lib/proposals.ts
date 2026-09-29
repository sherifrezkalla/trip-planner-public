/**
 * Group change protocol.
 *
 * A traveller cannot write to the shared plan, but can ask the group to. A
 * proposal applies when the organiser approves it, or when more than half the
 * travellers vote for it; it dies when the organiser rejects it, or when more
 * than half vote against.
 *
 * Pure and I/O-free, like `permissions.ts`, so the board and the API agree on
 * what a proposal is worth without a round trip.
 */

import type { Block } from "./schema";

export type ProposalKind = "move" | "remove" | "replace" | "suggest";

/** `open` is the only state that still counts votes. The rest are terminal. */
export type ProposalStatus = "open" | "applied" | "rejected" | "cancelled";

export type ProposalVote = { travelerId: string; value: 1 | -1 };

export type ProposalOutcome = "pending" | "apply" | "reject";

export type ProposalTally = {
  yes: number;
  no: number;
  needed: number;
  outcome: ProposalOutcome;
};

/**
 * More than half, never exactly half.
 *
 * `canSwap` already settled this for the group: a tie and an unvoted block both
 * stay locked, because absence of objection is not agreement. Four of eight is
 * not a decision.
 *
 * The denominator is every *human* who joined, including travellers who never
 * open the app again. Counting people who are merely quiet is deliberate — the
 * organiser's own approval is always available, so a threshold nobody reaches
 * costs the group nothing.
 *
 * Counting automated travellers would not be deliberate, it would be a bug: an
 * assistant that rejoins daily raises the bar every day until a real majority
 * is unreachable and the vote path silently dies. Callers pass a count that
 * excludes them.
 */
export function votesNeeded(travelerCount: number): number {
  return Math.floor(Math.max(0, travelerCount) / 2) + 1;
}

/**
 * Where a proposal stands right now.
 *
 * A traveller holds one vote; the last one they cast is the one that counts, so
 * duplicates are collapsed by traveller rather than summed.
 */
export function tallyProposal(args: {
  votes: ProposalVote[];
  travelerCount: number;
}): ProposalTally {
  const latest = new Map<string, 1 | -1>();
  for (const vote of args.votes) latest.set(vote.travelerId, vote.value);

  let yes = 0;
  let no = 0;
  for (const value of latest.values()) {
    if (value === 1) yes += 1;
    else no += 1;
  }

  const needed = votesNeeded(args.travelerCount);
  const outcome: ProposalOutcome = yes >= needed ? "apply" : no >= needed ? "reject" : "pending";
  return { yes, no, needed, outcome };
}

export type ProposalTarget = {
  kind: ProposalKind;
  /** The slot the proposer saw. A proposal is written against a plan, not an id. */
  fromDayIndex: number;
  fromBlock: Block;
  toDayIndex: number | null;
  toBlock: Block | null;
  /** For `replace`: the venue proposed to stand here instead. */
  toCandidateId?: string | null;
};

export type PlanFacts = {
  itemStatus: "planned" | "done" | "skipped";
  itemIsLocked: boolean;
  itemReservationStatus: string;
  itemDayIndex: number;
  itemBlock: Block;
  /** Whether some other planned activity already holds the destination slot. */
  destinationOccupied: boolean;
  /** For `replace`: whether the proposed venue has left the trip's candidates. */
  replacementMissing?: boolean;
  /** For `replace`: whether the proposed venue already stands elsewhere in the plan. */
  replacementAlreadyPlanned?: boolean;
  /** Today's index within the trip; negative before departure. */
  currentDayIndex: number;
};

const ACTIVE_RESERVATION = ["tentative", "confirmed"];

/**
 * Why this proposal can no longer be applied, or null when it still can.
 *
 * A proposal waits for votes while the trip moves on around it, so what was
 * sensible on Tuesday can be nonsense by Thursday. Rather than discovering that
 * at apply time — when it fails in front of whoever cast the deciding vote — a
 * proposal is checked against the live plan and cancelled the moment it stops
 * making sense. The reason is shown to the group so the proposer knows to ask
 * again rather than wondering why nothing happened.
 */
export function proposalStaleReason(
  target: ProposalTarget,
  facts: PlanFacts,
): string | null {
  if (facts.itemStatus === "done") return "the group already did it";
  if (facts.itemStatus === "skipped") return "it was already removed from the plan";
  if (facts.itemIsLocked) return "it was locked";
  if (ACTIVE_RESERVATION.includes(facts.itemReservationStatus)) return "it now has a booking";

  if (facts.itemDayIndex !== target.fromDayIndex || facts.itemBlock !== target.fromBlock) {
    return "it already moved somewhere else";
  }

  if (target.kind === "remove") return null;

  if (target.kind === "replace") {
    // A substitution can go stale from the other end: the venue it names can be
    // dropped from the trip, or taken by another slot while the group decides.
    if (facts.replacementMissing) return "the suggested venue is no longer available";
    if (facts.replacementAlreadyPlanned) return "the suggested venue is already in the plan";
    return null;
  }

  if (target.toDayIndex === null || target.toBlock === null) {
    return "the destination is missing";
  }
  if (facts.destinationOccupied) {
    return `Day ${target.toDayIndex + 1} ${target.toBlock} was filled`;
  }
  if (target.toDayIndex < facts.currentDayIndex) {
    return `Day ${target.toDayIndex + 1} has passed`;
  }

  return null;
}

/**
 * The whole decision for one proposal: cancel it, apply it, kill it, or wait.
 *
 * Staleness is checked before the tally so a proposal that no longer makes
 * sense is never applied by a vote that arrives a second too late.
 */
export function resolveProposal(args: {
  target: ProposalTarget;
  facts: PlanFacts;
  votes: ProposalVote[];
  travelerCount: number;
}): {
  status: Exclude<ProposalStatus, "applied"> | "applied";
  reason: string;
  tally: ProposalTally;
} {
  const tally = tallyProposal({ votes: args.votes, travelerCount: args.travelerCount });
  const stale = proposalStaleReason(args.target, args.facts);
  if (stale !== null) {
    return { status: "cancelled", reason: `Cancelled — ${stale}.`, tally };
  }
  if (tally.outcome === "apply") {
    return {
      status: "applied",
      reason: `Applied by group vote, ${tally.yes} of ${args.travelerCount}.`,
      tally,
    };
  }
  if (tally.outcome === "reject") {
    return {
      status: "rejected",
      reason: `Turned down by the group, ${tally.no} of ${args.travelerCount}.`,
      tally,
    };
  }
  return { status: "open", reason: `${tally.yes} of ${tally.needed} needed.`, tally };
}
