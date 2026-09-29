import { describe, expect, it } from "vitest";
import { describeProposal, type PendingProposal } from "@/components/PendingRequests";
import { describeChange, type ProposalSummary } from "@/lib/telegram-messages";

/**
 * The board and the organizer's phone describe the same proposal.
 *
 * They are two functions on purpose — one is sentence-cased for a heading, the
 * other runs mid-sentence after "asked to" — but they answer to the same facts,
 * so a kind that reads wrong in one has always read wrong in both. `replace`
 * did: neither knew the kind, both fell through to the move wording, and the
 * proposed venue was named nowhere. These tests hold the two together.
 */

const base: PendingProposal = {
  id: "prop-1",
  itemId: "item-1",
  kind: "move",
  proposedByName: "Nancy",
  fromDayIndex: 0,
  fromBlock: "afternoon",
  toDayIndex: 1,
  toBlock: "evening",
  replacementName: null,
  note: "",
  createdAt: "2026-08-19T09:00:00Z",
  yes: 0,
  no: 0,
  needed: 5,
  myVote: 0,
};

const summary: ProposalSummary = {
  proposalId: "prop-1",
  kind: "move",
  venueName: "Plage du Midi",
  replacementName: null,
  proposedByName: "Nancy",
  note: "",
  fromDayIndex: 0,
  fromBlock: "afternoon",
  toDayIndex: 1,
  toBlock: "evening",
};

describe("describeProposal", () => {
  it("names a concierge suggestion in the group voting queue", () => {
    expect(describeProposal({
      ...base,
      itemId: null,
      kind: "suggest",
      fromDayIndex: null,
      fromBlock: null,
      toDayIndex: null,
      toBlock: null,
      suggestionText: "Blue Lagoon",
    }, "an activity")).toBe("Add Blue Lagoon to the group's suggestions");
  });

  it("names the destination slot for a move", () => {
    expect(describeProposal(base, "Plage du Midi"))
      .toBe("Move Plage du Midi to Day 2 evening");
  });

  it("names the day it comes out of for a removal", () => {
    expect(describeProposal({ ...base, kind: "remove", toDayIndex: null, toBlock: null }, "Plage du Midi"))
      .toBe("Drop Plage du Midi from Day 1");
  });

  it("names the venue proposed in place of the one being dropped", () => {
    const replace: PendingProposal = {
      ...base,
      kind: "replace",
      toDayIndex: null,
      toBlock: null,
      replacementName: "Musee Picasso",
    };
    expect(describeProposal(replace, "Plage du Midi"))
      .toBe("Swap Plage du Midi for Musee Picasso on Day 1");
  });

  it("does not describe a replacement as a move to a slot that does not exist", () => {
    // The regression, exactly as the weather scan raises it: kind "replace"
    // with no destination day or block. The old fallthrough rendered
    // "Move Plage du Midi to Day 1 null" and never mentioned the stand-in.
    const replace: PendingProposal = {
      ...base,
      kind: "replace",
      toDayIndex: null,
      toBlock: null,
      replacementName: "Musee Picasso",
    };
    const text = describeProposal(replace, "Plage du Midi");
    expect(text).not.toContain("null");
    expect(text).not.toMatch(/^Move/);
    expect(text).toContain("Musee Picasso");
  });

  it("still says what would happen when the stand-in has gone", () => {
    const replace: PendingProposal = {
      ...base,
      kind: "replace",
      toDayIndex: null,
      toBlock: null,
      replacementName: null,
    };
    expect(describeProposal(replace, "Plage du Midi"))
      .toBe("Swap Plage du Midi for another venue on Day 1");
  });
});

describe("the board and the organizer's phone agree", () => {
  it("name the same two venues for a replacement", () => {
    const onBoard = describeProposal(
      { ...base, kind: "replace", toDayIndex: null, toBlock: null, replacementName: "Musee Picasso" },
      "Plage du Midi",
    );
    const onPhone = describeChange({
      ...summary,
      kind: "replace",
      toDayIndex: null,
      toBlock: null,
      replacementName: "Musee Picasso",
    });

    for (const text of [onBoard, onPhone]) {
      expect(text).toContain("Plage du Midi");
      expect(text).toContain("Musee Picasso");
      expect(text).toContain("Day 1");
    }
    // Same sentence, differing only in the case the position calls for.
    expect(onBoard.toLowerCase()).toBe(onPhone.toLowerCase());
  });
});
