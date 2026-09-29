import { describe, expect, it } from "vitest";
import { buildPartialDayPreview, regularHoursCoverBlock, type PartialDayItem } from "@/lib/partial-day";

function item(overrides: Partial<PartialDayItem> & Pick<PartialDayItem, "id" | "block">): PartialDayItem {
  return {
    dayIndex: 2,
    position: 0,
    status: "planned",
    isLocked: false,
    venueName: overrides.id,
    voteSum: 0,
    durationMin: 60,
    openingPeriods: [{ open: { day: 0, hour: 0, minute: 0 } }],
    ...overrides,
  };
}

describe("partial-day replanning", () => {
  it("keeps future activities and omits an equal-vote overdue activity when capacity shrinks", () => {
    const preview = buildPartialDayPreview({
      items: [
        item({ id: "museum", block: "morning" }),
        item({ id: "park", block: "afternoon", position: 1 }),
        item({ id: "show", block: "evening", position: 2 }),
      ],
      startDate: "2026-08-10",
      dayIndex: 2,
      currentBlock: "afternoon",
    });

    expect(preview.moves).toEqual([]);
    expect(preview.skips).toEqual([expect.objectContaining({ itemId: "museum" })]);
  });

  it("lets a strongly supported overdue activity displace a lower-voted future activity", () => {
    const preview = buildPartialDayPreview({
      items: [
        item({ id: "museum", block: "morning", voteSum: 3 }),
        item({ id: "park", block: "afternoon", voteSum: -1, position: 1 }),
        item({ id: "show", block: "evening", position: 2 }),
      ],
      startDate: "2026-08-10",
      dayIndex: 2,
      currentBlock: "afternoon",
    });

    expect(preview.moves).toEqual([expect.objectContaining({
      itemId: "museum",
      fromBlock: "morning",
      toBlock: "afternoon",
    })]);
    expect(preview.skips).toEqual([expect.objectContaining({ itemId: "park" })]);
  });

  it("preserves locked and historical activities", () => {
    const preview = buildPartialDayPreview({
      items: [
        item({ id: "done", block: "morning", status: "done" }),
        item({ id: "booking", block: "afternoon", isLocked: true }),
        item({ id: "walk", block: "evening" }),
      ],
      startDate: "2026-08-10",
      dayIndex: 2,
      currentBlock: "afternoon",
    });

    expect(preview.moves).toEqual([]);
    expect(preview.skips).toEqual([]);
    expect(preview.preserved).toEqual([
      expect.objectContaining({ itemId: "done", reason: "completed" }),
      expect.objectContaining({ itemId: "booking", reason: "locked" }),
    ]);
  });

  it("never moves a meal into an activity slot", () => {
    const preview = buildPartialDayPreview({
      items: [item({ id: "lunch", block: "lunch", voteSum: 5 })],
      startDate: "2026-08-10",
      dayIndex: 2,
      currentBlock: "afternoon",
    });
    expect(preview.moves).toEqual([expect.objectContaining({
      itemId: "lunch",
      fromBlock: "lunch",
      toBlock: "dinner",
    })]);
    expect(preview.moves.every((move) => move.toBlock === "lunch" || move.toBlock === "dinner")).toBe(true);
    expect(preview.skips).toEqual([]);
  });

  it("does not move an activity when regular hours do not cover the destination slot", () => {
    const preview = buildPartialDayPreview({
      items: [item({
        id: "museum",
        block: "morning",
        openingPeriods: [{
          open: { day: 3, hour: 9, minute: 0 },
          close: { day: 3, hour: 12, minute: 0 },
        }],
      })],
      startDate: "2026-08-10",
      dayIndex: 2,
      currentBlock: "afternoon",
    });
    expect(preview.moves).toEqual([]);
    expect(preview.skips).toEqual([expect.objectContaining({ itemId: "museum" })]);
  });

  it("supports opening periods that cross the weekly boundary", () => {
    expect(regularHoursCoverBlock([
      { open: { day: 6, hour: 20, minute: 0 }, close: { day: 0, hour: 1, minute: 0 } },
    ], "2026-08-15", 0, "evening", 90)).toBe(true);
  });
});
