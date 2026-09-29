import { describe, expect, it } from "vitest";
import { buildReshufflePreview, type ReshuffleItem } from "@/lib/reshuffle";

function item(overrides: Partial<ReshuffleItem> & Pick<ReshuffleItem, "id" | "dayIndex" | "block">): ReshuffleItem {
  return {
    status: "planned",
    isLocked: false,
    completedDayIndex: null,
    venueName: overrides.id,
    ...overrides,
  };
}

describe("buildReshufflePreview", () => {
  it("moves today's unfinished activity into the future slot freed by an early completion", () => {
    const preview = buildReshufflePreview([
      item({
        id: "boat",
        venueName: "Boat trip",
        dayIndex: 6,
        block: "afternoon",
        status: "done",
        completedDayIndex: 2,
      }),
      item({ id: "museum", venueName: "Museum", dayIndex: 2, block: "afternoon" }),
      item({ id: "dinner", dayIndex: 2, block: "dinner" }),
    ], 2, 10);

    expect(preview.moves).toEqual([{
      itemId: "museum",
      fromDayIndex: 2,
      fromBlock: "afternoon",
      toDayIndex: 6,
      toBlock: "afternoon",
    }]);
    expect(preview.unplaced).toEqual([]);
  });

  it("does not move anything when an activity was completed on its scheduled day", () => {
    const preview = buildReshufflePreview([
      item({ id: "boat", dayIndex: 2, block: "afternoon", status: "done", completedDayIndex: 2 }),
    ], 2, 10);
    expect(preview.moves).toEqual([]);
  });

  it("uses a skipped future slot for a matching unfinished activity from a past day", () => {
    const preview = buildReshufflePreview([
      item({ id: "missed", dayIndex: 1, block: "morning" }),
      item({ id: "skipped", dayIndex: 5, block: "morning", status: "skipped" }),
    ], 2, 10);
    expect(preview.moves[0]).toMatchObject({ itemId: "missed", toDayIndex: 5, toBlock: "morning" });
  });

  it("reports a locked booking that conflicts with an early completion", () => {
    const preview = buildReshufflePreview([
      item({ id: "done", dayIndex: 6, block: "dinner", status: "done", completedDayIndex: 2 }),
      item({ id: "booking", venueName: "Booked dinner", dayIndex: 2, block: "dinner", isLocked: true }),
    ], 2, 10);
    expect(preview.moves).toEqual([]);
    expect(preview.conflicts).toEqual(["Booked dinner is locked in a slot already used by a completed activity"]);
  });

  it("never changes an activity's block", () => {
    const preview = buildReshufflePreview([
      item({ id: "missed", dayIndex: 1, block: "morning" }),
      item({ id: "skipped", dayIndex: 5, block: "afternoon", status: "skipped" }),
    ], 2, 10);
    expect(preview.moves).toEqual([]);
    expect(preview.unplaced).toEqual([{ itemId: "missed", venueName: "missed" }]);
  });
});
