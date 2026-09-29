import { BLOCKS, type Block } from "./schema";
import type { ItineraryMove } from "./persistence";

export type ProgressStatus = "planned" | "done" | "skipped";

export type ReshuffleItem = {
  id: string;
  dayIndex: number;
  block: Block;
  status: ProgressStatus;
  isLocked: boolean;
  completedDayIndex: number | null;
  venueName: string;
};

export type ReshufflePreview = {
  moves: ItineraryMove[];
  unplaced: { itemId: string; venueName: string }[];
  conflicts: string[];
};

// The schema's own list. This was a fourth hand-written copy of the same five
// blocks in the same order; nothing connected it to the others.
const BLOCK_ORDER: readonly Block[] = BLOCKS;

function slot(dayIndex: number, block: string): string {
  return `${dayIndex}:${block}`;
}

/**
 * Builds the smallest safe reshuffle.
 *
 * An activity completed early occupies that block on the day it actually
 * happened and frees its former future slot. The unfinished activity displaced
 * from the completion day moves into that vacancy. Skipped activities create
 * additional vacancies that can absorb unfinished activities from earlier days.
 * Blocks never change, so restaurant/activity semantics and opening-time intent
 * stay intact.
 */
export function buildReshufflePreview(
  items: ReshuffleItem[],
  currentDayIndex: number,
  dayCount: number,
): ReshufflePreview {
  const inTrip = (dayIndex: number) => dayIndex >= 0 && dayIndex < dayCount;
  const planned = items.filter((item) => item.status === "planned");
  const occupiedByHistory = new Set(
    items
      .filter((item) => item.status === "done" && item.completedDayIndex !== null)
      .filter((item) => inTrip(item.completedDayIndex!))
      .map((item) => slot(item.completedDayIndex!, item.block)),
  );
  const plannedSlots = new Set(planned.map((item) => slot(item.dayIndex, item.block)));
  const conflicts = planned
    .filter((item) => item.isLocked && occupiedByHistory.has(slot(item.dayIndex, item.block)))
    .map((item) => `${item.venueName} is locked in a slot already used by a completed activity`);

  const vacancies = items
    .filter((item) => item.status !== "planned")
    .filter((item) => item.dayIndex >= currentDayIndex && inTrip(item.dayIndex))
    .filter((item) => !plannedSlots.has(slot(item.dayIndex, item.block)))
    .filter((item) => !occupiedByHistory.has(slot(item.dayIndex, item.block)))
    .map((item) => ({ dayIndex: item.dayIndex, block: item.block }))
    .filter((candidate, index, all) =>
      all.findIndex((other) => slot(other.dayIndex, other.block) === slot(candidate.dayIndex, candidate.block)) === index,
    )
    .sort((a, b) => a.dayIndex - b.dayIndex || BLOCK_ORDER.indexOf(a.block) - BLOCK_ORDER.indexOf(b.block));

  const displaced = planned
    .filter((item) => !item.isLocked)
    .filter((item) => item.dayIndex < currentDayIndex || occupiedByHistory.has(slot(item.dayIndex, item.block)))
    .sort((a, b) => a.dayIndex - b.dayIndex || BLOCK_ORDER.indexOf(a.block) - BLOCK_ORDER.indexOf(b.block));

  const usedTargets = new Set<string>();
  const moves: ItineraryMove[] = [];
  const unplaced: ReshufflePreview["unplaced"] = [];

  for (const item of displaced) {
    const choices = vacancies
      .filter((candidate) => candidate.block === item.block)
      .filter((candidate) => !usedTargets.has(slot(candidate.dayIndex, candidate.block)))
      .sort((a, b) =>
        Math.abs(a.dayIndex - item.dayIndex) - Math.abs(b.dayIndex - item.dayIndex)
        || a.dayIndex - b.dayIndex,
      );
    const target = choices[0];
    if (!target) {
      unplaced.push({ itemId: item.id, venueName: item.venueName });
      continue;
    }
    usedTargets.add(slot(target.dayIndex, target.block));
    moves.push({
      itemId: item.id,
      fromDayIndex: item.dayIndex,
      fromBlock: item.block,
      toDayIndex: target.dayIndex,
      toBlock: target.block,
    });
  }

  return { moves, unplaced, conflicts };
}
