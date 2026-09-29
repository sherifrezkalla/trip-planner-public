import { describe, it, expect } from "vitest";
import {
  votesNeeded,
  tallyProposal,
  proposalStaleReason,
  resolveProposal,
  type PlanFacts,
  type ProposalTarget,
  type ProposalVote,
} from "@/lib/proposals";

function yes(...ids: string[]): ProposalVote[] {
  return ids.map((travelerId) => ({ travelerId, value: 1 }));
}
function no(...ids: string[]): ProposalVote[] {
  return ids.map((travelerId) => ({ travelerId, value: -1 }));
}

const moveTarget: ProposalTarget = {
  kind: "move",
  fromDayIndex: 7,
  fromBlock: "afternoon",
  toDayIndex: 9,
  toBlock: "morning",
};

const healthyPlan: PlanFacts = {
  itemStatus: "planned",
  itemIsLocked: false,
  itemReservationStatus: "none",
  itemDayIndex: 7,
  itemBlock: "afternoon",
  destinationOccupied: false,
  currentDayIndex: 7,
};

describe("votesNeeded", () => {
  it("needs more than half, never exactly half", () => {
    expect(votesNeeded(8)).toBe(5);
    expect(votesNeeded(4)).toBe(3);
  });

  it("takes four of the seven travellers on a family trip", () => {
    expect(votesNeeded(7)).toBe(4);
  });

  it("lets a solo planner carry their own trip", () => {
    expect(votesNeeded(1)).toBe(1);
  });

  it("still requires both people on a pair trip", () => {
    expect(votesNeeded(2)).toBe(2);
  });

  it("counts people, so an assistant rejoining daily cannot outrun the group", () => {
    // Synthetic group: ten people, plus an assistant that rejoins every day.
    const humans = 10;
    expect(votesNeeded(humans)).toBe(6);

    // Counting the assistants instead: by the end of a week away, carrying a
    // change would need nine of the ten people — not literally impossible, but
    // past what a group ever agrees on, so the vote path dies in practice.
    expect(votesNeeded(humans + 7)).toBe(9);

    // Ten days in it stops being a question of persuasion: the threshold
    // exceeds the number of people who exist to vote.
    expect(votesNeeded(humans + 10)).toBeGreaterThan(humans);

    // The denominator is the fix, and it does not drift with the calendar.
    expect(votesNeeded(humans)).toBe(6);
  });
});

describe("tallyProposal", () => {
  it("waits while short of the threshold", () => {
    const tally = tallyProposal({ votes: yes("a", "b", "c"), travelerCount: 7 });
    expect(tally).toMatchObject({ yes: 3, no: 0, needed: 4, outcome: "pending" });
  });

  it("applies once more than half agree", () => {
    expect(tallyProposal({ votes: yes("a", "b", "c", "d"), travelerCount: 7 }).outcome).toBe("apply");
  });

  it("rejects once more than half object", () => {
    expect(tallyProposal({ votes: no("a", "b", "c", "d"), travelerCount: 7 }).outcome).toBe("reject");
  });

  it("holds a dead heat open rather than calling it", () => {
    const tally = tallyProposal({
      votes: [...yes("a", "b", "c", "d"), ...no("e", "f", "g", "h")],
      travelerCount: 8,
    });
    expect(tally).toMatchObject({ yes: 4, no: 4, needed: 5, outcome: "pending" });
  });

  it("counts one vote per traveller, keeping whichever they cast last", () => {
    const tally = tallyProposal({
      votes: [...yes("a"), ...no("a"), ...yes("b", "c", "d")],
      travelerCount: 7,
    });
    expect(tally).toMatchObject({ yes: 3, no: 1, outcome: "pending" });
  });
});

describe("proposalStaleReason", () => {
  it("passes a proposal that still makes sense", () => {
    expect(proposalStaleReason(moveTarget, healthyPlan)).toBeNull();
  });

  it("cancels once the group has already done the activity", () => {
    expect(proposalStaleReason(moveTarget, { ...healthyPlan, itemStatus: "done" }))
      .toBe("the group already did it");
  });

  it("cancels once the activity was removed", () => {
    expect(proposalStaleReason(moveTarget, { ...healthyPlan, itemStatus: "skipped" }))
      .toBe("it was already removed from the plan");
  });

  it("cancels once the organiser locks the activity", () => {
    expect(proposalStaleReason(moveTarget, { ...healthyPlan, itemIsLocked: true }))
      .toBe("it was locked");
  });

  it("cancels once a booking is attached", () => {
    expect(proposalStaleReason(moveTarget, { ...healthyPlan, itemReservationStatus: "confirmed" }))
      .toBe("it now has a booking");
    expect(proposalStaleReason(moveTarget, { ...healthyPlan, itemReservationStatus: "tentative" }))
      .toBe("it now has a booking");
  });

  it("cancels when the activity has drifted from the slot the proposer saw", () => {
    expect(proposalStaleReason(moveTarget, { ...healthyPlan, itemBlock: "evening" }))
      .toBe("it already moved somewhere else");
    expect(proposalStaleReason(moveTarget, { ...healthyPlan, itemDayIndex: 8 }))
      .toBe("it already moved somewhere else");
  });

  it("names the slot that got filled, so the proposer can ask again", () => {
    expect(proposalStaleReason(moveTarget, { ...healthyPlan, destinationOccupied: true }))
      .toBe("Day 10 morning was filled");
  });

  it("cancels a move onto a day that has already passed", () => {
    expect(proposalStaleReason(moveTarget, { ...healthyPlan, currentDayIndex: 11 }))
      .toBe("Day 10 has passed");
  });

  it("still allows a move to today", () => {
    expect(proposalStaleReason(moveTarget, { ...healthyPlan, currentDayIndex: 9 })).toBeNull();
  });

  it("holds a removal to the protections but not to a destination", () => {
    const removal: ProposalTarget = {
      kind: "remove",
      fromDayIndex: 7,
      fromBlock: "afternoon",
      toDayIndex: null,
      toBlock: null,
    };
    expect(proposalStaleReason(removal, { ...healthyPlan, destinationOccupied: true })).toBeNull();
    expect(proposalStaleReason(removal, { ...healthyPlan, itemIsLocked: true })).toBe("it was locked");
  });
});

describe("resolveProposal", () => {
  it("waits while the group is still deciding", () => {
    const result = resolveProposal({
      target: moveTarget,
      facts: healthyPlan,
      votes: yes("a", "b"),
      travelerCount: 7,
    });
    expect(result.status).toBe("open");
    expect(result.reason).toBe("2 of 4 needed.");
  });

  it("applies on the deciding vote and says how it carried", () => {
    const result = resolveProposal({
      target: moveTarget,
      facts: healthyPlan,
      votes: yes("a", "b", "c", "d"),
      travelerCount: 7,
    });
    expect(result.status).toBe("applied");
    expect(result.reason).toBe("Applied by group vote, 4 of 7.");
  });

  it("records a group refusal rather than leaving it open forever", () => {
    const result = resolveProposal({
      target: moveTarget,
      facts: healthyPlan,
      votes: no("a", "b", "c", "d"),
      travelerCount: 7,
    });
    expect(result.status).toBe("rejected");
    expect(result.reason).toBe("Turned down by the group, 4 of 7.");
  });

  it("cancels a stale proposal even when the votes are there", () => {
    // The whole point of problem 2: a late deciding vote must not apply a move
    // into a slot that filled two days ago.
    const result = resolveProposal({
      target: moveTarget,
      facts: { ...healthyPlan, destinationOccupied: true },
      votes: yes("a", "b", "c", "d", "e"),
      travelerCount: 7,
    });
    expect(result.status).toBe("cancelled");
    expect(result.reason).toBe("Cancelled — Day 10 morning was filled.");
  });

  it("cancels rather than rejects when a dead proposal is also voted down", () => {
    const result = resolveProposal({
      target: moveTarget,
      facts: { ...healthyPlan, itemStatus: "done" },
      votes: no("a", "b", "c", "d"),
      travelerCount: 7,
    });
    expect(result.status).toBe("cancelled");
  });
});

describe("replace proposals", () => {
  const target = {
    kind: "replace" as const,
    fromDayIndex: 2,
    fromBlock: "afternoon" as const,
    toDayIndex: null,
    toBlock: null,
    toCandidateId: "gallery-1",
  };
  const facts = {
    itemStatus: "planned" as const,
    itemIsLocked: false,
    itemReservationStatus: "none",
    itemDayIndex: 2,
    itemBlock: "afternoon" as const,
    destinationOccupied: false,
    currentDayIndex: 0,
    replacementMissing: false,
    replacementAlreadyPlanned: false,
  };

  it("stays valid while the replacement is available", () => {
    expect(proposalStaleReason(target, facts)).toBeNull();
  });

  /** A substitution can go stale from the other end, not just the slot's. */
  it("cancels when the suggested venue has left the trip", () => {
    expect(proposalStaleReason(target, { ...facts, replacementMissing: true }))
      .toBe("the suggested venue is no longer available");
  });

  it("cancels when the suggested venue is already standing elsewhere", () => {
    expect(proposalStaleReason(target, { ...facts, replacementAlreadyPlanned: true }))
      .toBe("the suggested venue is already in the plan");
  });

  it("still applies the slot's own staleness rules", () => {
    expect(proposalStaleReason(target, { ...facts, itemStatus: "done" }))
      .toBe("the group already did it");
    expect(proposalStaleReason(target, { ...facts, itemBlock: "dinner" }))
      .toBe("it already moved somewhere else");
  });

  /** A replacement has no destination slot, so past-day rules must not fire. */
  it("does not ask a substitution for a destination it has no reason to have", () => {
    expect(proposalStaleReason(target, { ...facts, currentDayIndex: 5 })).toBeNull();
  });
});
