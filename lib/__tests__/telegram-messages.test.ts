import { describe, it, expect } from "vitest";
import {
  appliedByVoteMessage,
  cancelledMessage,
  decidedMessage,
  describeChange,
  linkedMessage,
  requestOpenedMessage,
  type ProposalSummary,
} from "@/lib/telegram-messages";

const move: ProposalSummary = {
  proposalId: "p1",
  kind: "move",
  venueName: "Grama Bay",
  replacementName: null,
  proposedByName: "Nancy",
  note: "better at sunset",
  fromDayIndex: 11,
  fromBlock: "afternoon",
  toDayIndex: 11,
  toBlock: "evening",
};

const removal: ProposalSummary = {
  ...move,
  kind: "remove",
  note: "",
  toDayIndex: null,
  toBlock: null,
};

/** What the weather scan raises: no destination slot, a named stand-in. */
const replacement: ProposalSummary = {
  ...move,
  kind: "replace",
  replacementName: "Musee Picasso",
  note: "rain forecast that afternoon",
  toDayIndex: null,
  toBlock: null,
};

describe("describeChange", () => {
  it("reads as a sentence for a move", () => {
    expect(describeChange(move)).toBe("move Grama Bay to Day 12 evening");
  });

  it("reads as a sentence for a removal", () => {
    expect(describeChange(removal)).toBe("drop Grama Bay from Day 12");
  });

  it("counts days from one, the way the board shows them", () => {
    expect(describeChange({ ...move, toDayIndex: 0, toBlock: "morning" }))
      .toBe("move Grama Bay to Day 1 morning");
  });

  it("names both venues for a replacement", () => {
    expect(describeChange(replacement)).toBe("swap Grama Bay for Musee Picasso on Day 12");
  });

  it("never describes a replacement as a move to a missing slot", () => {
    // The regression: `replace` carries no destination, so borrowing the move
    // wording produced "move Grama Bay to Day 1 null" on the organizer's phone.
    const text = describeChange(replacement);
    expect(text).not.toContain("null");
    expect(text).not.toContain("move");
  });

  it("still names the slot when the stand-in has gone", () => {
    expect(describeChange({ ...replacement, replacementName: null }))
      .toBe("swap Grama Bay for another venue on Day 12");
  });
});

describe("requestOpenedMessage", () => {
  it("says who wants what, why, and how close it is", () => {
    const message = requestOpenedMessage(move, { yes: 1, needed: 5 });
    expect(message.text).toContain("Nancy asked to move Grama Bay to Day 12 evening.");
    expect(message.text).toContain('"better at sunset"');
    expect(message.text).toContain("1 of 5 needed");
  });

  it("describes a replacement accurately next to its Approve button", () => {
    const message = requestOpenedMessage(replacement, { yes: 0, needed: 5 });
    expect(message.text).toContain("Nancy asked to swap Grama Bay for Musee Picasso on Day 12.");
    expect(message.buttons.map((button) => button.callbackData)).toEqual([
      "approve:p1",
      "reject:p1",
    ]);
  });

  it("carries both decisions as buttons keyed to the proposal", () => {
    const message = requestOpenedMessage(move, { yes: 1, needed: 5 });
    expect(message.buttons).toEqual([
      { text: "Approve", callbackData: "approve:p1" },
      { text: "Turn down", callbackData: "reject:p1" },
    ]);
  });

  it("omits the quote when no reason was given", () => {
    const message = requestOpenedMessage({ ...move, note: "" }, { yes: 1, needed: 5 });
    expect(message.text).not.toContain('"');
  });
});

describe("appliedByVoteMessage", () => {
  it("tells the organiser the plan moved without them", () => {
    const message = appliedByVoteMessage(move, { yes: 5, travelerCount: 7 });
    expect(message.text).toContain("The group agreed to move Grama Bay to Day 12 evening.");
    expect(message.text).toContain("5 of 7 travellers agreed");
    expect(message.text).toContain("The plan has changed.");
  });

  it("offers nothing to press, because it is already done", () => {
    expect(appliedByVoteMessage(move, { yes: 5, travelerCount: 7 }).buttons).toEqual([]);
  });
});

describe("cancelledMessage", () => {
  it("repeats the reason so nobody keeps waiting on it", () => {
    const message = cancelledMessage(move, "Cancelled — Day 12 lunch was filled.");
    expect(message.text).toContain("Nancy's request to move Grama Bay");
    expect(message.text).toContain("Day 12 lunch was filled");
    expect(message.buttons).toEqual([]);
  });
});

describe("decidedMessage", () => {
  it("replaces the original so the buttons cannot be pressed twice", () => {
    expect(decidedMessage(move, "Approved by the organiser."))
      .toBe("Request to move Grama Bay to Day 12 evening.\n\nApproved by the organiser.");
  });
});

describe("linkedMessage", () => {
  it("names the trip and what will arrive", () => {
    const text = linkedMessage("Example Region 2026");
    expect(text).toContain("Linked to Example Region 2026.");
    expect(text).toContain("asks to change the plan");
  });
});
