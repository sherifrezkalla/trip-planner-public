import { describe, it, expect } from "vitest";
import { countVotesByTraveler, type VotedItem } from "@/lib/roster";

function item(votes: { travelerId: string; value: 1 | -1 }[]): VotedItem {
  return { votes };
}

describe("countVotesByTraveler", () => {
  it("counts a traveller's votes across the whole plan", () => {
    const counts = countVotesByTraveler([
      item([{ travelerId: "a", value: 1 }]),
      item([{ travelerId: "a", value: -1 }]),
      item([{ travelerId: "a", value: 1 }]),
    ]);
    expect(counts.get("a")).toBe(3);
  });

  it("counts thumbs up and thumbs down alike — both are participation", () => {
    const counts = countVotesByTraveler([
      item([
        { travelerId: "a", value: 1 },
        { travelerId: "b", value: -1 },
      ]),
    ]);
    expect(counts.get("a")).toBe(1);
    expect(counts.get("b")).toBe(1);
  });

  it("has no entry for someone who has not voted", () => {
    const counts = countVotesByTraveler([item([{ travelerId: "a", value: 1 }])]);
    expect(counts.get("someone-else")).toBeUndefined();
  });

  it("handles stops that nobody has voted on", () => {
    const counts = countVotesByTraveler([item([]), item([{ travelerId: "a", value: 1 }]), item([])]);
    expect(counts.get("a")).toBe(1);
  });

  it("returns nothing for a plan with no stops", () => {
    expect(countVotesByTraveler([]).size).toBe(0);
  });
});
