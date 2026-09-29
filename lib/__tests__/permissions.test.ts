import { describe, it, expect } from "vitest";
import {
  canSwap, canRemoveTraveler, canRenameTrip, canDeleteSuggestion, canManageSchedule,
  canManageTripAgent,
} from "@/lib/permissions";

describe("canSwap", () => {
  it("blocks a traveller when the group has not voted the block down", () => {
    const result = canSwap({ voteSum: 0, isOrganizer: false, travelerCount: 4 });
    expect(result.allowed).toBe(false);
    expect(result.reason).not.toBe("");
  });

  it("blocks a traveller when the block is net positive", () => {
    expect(canSwap({ voteSum: 2, isOrganizer: false, travelerCount: 4 }).allowed).toBe(false);
  });

  it("blocks on a tie, because absence of objection is not rejection", () => {
    // Two 👍 and two 👎 sum to zero: the group is split, so the venue stays.
    expect(canSwap({ voteSum: 0, isOrganizer: false, travelerCount: 4 }).allowed).toBe(false);
  });

  it("allows a traveller once the block is net negative", () => {
    const result = canSwap({ voteSum: -1, isOrganizer: false, travelerCount: 4 });
    expect(result.allowed).toBe(true);
  });

  it("allows the organizer regardless of the tally", () => {
    expect(canSwap({ voteSum: 5, isOrganizer: true, travelerCount: 4 }).allowed).toBe(true);
  });

  it("allows a solo traveller, who has nobody to disagree with", () => {
    expect(canSwap({ voteSum: 0, isOrganizer: false, travelerCount: 1 }).allowed).toBe(true);
  });
});

describe("canRemoveTraveler", () => {
  it("allows the organizer to remove someone else", () => {
    expect(
      canRemoveTraveler({ actorIsOrganizer: true, actorId: "a", targetId: "b" }).allowed,
    ).toBe(true);
  });

  it("refuses a non-organizer", () => {
    const result = canRemoveTraveler({ actorIsOrganizer: false, actorId: "a", targetId: "b" });
    expect(result.allowed).toBe(false);
    expect(result.reason).not.toBe("");
  });

  it("refuses the organizer removing themselves, which would orphan the trip", () => {
    const result = canRemoveTraveler({ actorIsOrganizer: true, actorId: "a", targetId: "a" });
    expect(result.allowed).toBe(false);
    expect(result.reason).not.toBe("");
  });
});

describe("canRenameTrip", () => {
  it("allows the organizer", () => {
    expect(canRenameTrip({ actorIsOrganizer: true }).allowed).toBe(true);
  });

  it("refuses everyone else, with a reason", () => {
    const result = canRenameTrip({ actorIsOrganizer: false });
    expect(result.allowed).toBe(false);
    expect(result.reason).not.toBe("");
  });
});

describe("canDeleteSuggestion", () => {
  it("allows the member who wrote it", () => {
    expect(canDeleteSuggestion({
      actorIsOrganizer: false, actorId: "a", suggestionOwnerId: "a",
    }).allowed).toBe(true);
  });

  it("allows the organiser to moderate it", () => {
    expect(canDeleteSuggestion({
      actorIsOrganizer: true, actorId: "organizer", suggestionOwnerId: "a",
    }).allowed).toBe(true);
  });

  it("refuses another member", () => {
    expect(canDeleteSuggestion({
      actorIsOrganizer: false, actorId: "b", suggestionOwnerId: "a",
    }).allowed).toBe(false);
  });
});

describe("canManageSchedule", () => {
  it("allows the organiser to lock and reshuffle the schedule", () => {
    expect(canManageSchedule({ actorIsOrganizer: true }).allowed).toBe(true);
  });

  it("keeps schedule-wide changes organizer-only", () => {
    expect(canManageSchedule({ actorIsOrganizer: false }).allowed).toBe(false);
  });
});

describe("canManageSchedule covers moving one activity", () => {
  it("lets the organiser move an activity", () => {
    expect(canManageSchedule({ actorIsOrganizer: true }).allowed).toBe(true);
  });

  it("keeps a traveller from writing to the shared plan directly", () => {
    // Travellers reach the plan through proposals and votes, not direct writes.
    expect(canManageSchedule({ actorIsOrganizer: false }).allowed).toBe(false);
  });
});

describe("canManageTripAgent", () => {
  it("allows the organiser to manage the trip connector", () => {
    expect(canManageTripAgent({ actorIsOrganizer: true, actorIsBot: false }).allowed).toBe(true);
  });

  it("denies a malformed traveler marked as both bot and organizer", () => {
    expect(canManageTripAgent({ actorIsOrganizer: true, actorIsBot: true })).toEqual({
      allowed: false,
      reason: "Only the organiser can manage the trip agent",
    });
  });

  it.each(["issue", "pause", "resume", "rotate", "archive", "revoke"])(
    "keeps %s organizer-only",
    () => {
      const result = canManageTripAgent({ actorIsOrganizer: false, actorIsBot: false });
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe("Only the organiser can manage the trip agent");
    },
  );
});
