import type { OpeningPeriod } from "./places";
import type { ItineraryMove } from "./persistence";
import { BLOCKS, type Block } from "./schema";
import { regularHoursCoverBlock } from "./opening-hours";
import { TODAY_BLOCK_ORDER } from "./today";

export type PartialDayItem = {
  id: string;
  dayIndex: number;
  block: Block;
  position: number;
  status: "planned" | "done" | "skipped";
  isLocked: boolean;
  venueName: string;
  voteSum: number;
  durationMin: number;
  openingPeriods: OpeningPeriod[];
};

export type PartialDaySkip = {
  itemId: string;
  venueName: string;
  fromDayIndex: number;
  fromBlock: Block;
  reason: string;
};

export type PartialDayPreserved = {
  itemId: string;
  venueName: string;
  block: Block;
  reason: "completed" | "skipped" | "locked";
};

export type PartialDayPreview = {
  kind: "partial-day";
  trigger: "running-late";
  dayIndex: number;
  currentBlock: Block;
  moves: ItineraryMove[];
  skips: PartialDaySkip[];
  preserved: PartialDayPreserved[];
  conflicts: string[];
};

function rank(block: Block): number {
  return TODAY_BLOCK_ORDER.indexOf(block);
}

function slotKind(block: Block): "meal" | "activity" {
  return block === "lunch" || block === "dinner" ? "meal" : "activity";
}

/**
 * Re-exported so this module's callers and tests keep one import.
 *
 * The rule itself now lives in `opening-hours.ts`: generation had an identical
 * copy under a different name, down to Google's 24/7 shape and the wrap for
 * periods closing after midnight.
 */
export { regularHoursCoverBlock };

type Assignment = { item: PartialDayItem; block: Block };

function assignmentScore(assignments: Assignment[], currentBlock: Block): number {
  const currentRank = rank(currentBlock);
  return assignments.length * 1_000_000
    + assignments.reduce((sum, assignment) => sum + assignment.item.voteSum * 1_000, 0)
    + assignments.filter((assignment) => rank(assignment.item.block) >= currentRank).length * 100
    + assignments.filter((assignment) => assignment.item.block === assignment.block).length * 10
    - assignments.reduce((sum, assignment) => sum + Math.abs(rank(assignment.item.block) - rank(assignment.block)), 0);
}

function bestOrderedAssignment(args: {
  items: PartialDayItem[];
  slots: Block[];
  currentBlock: Block;
  startDate: string;
  dayIndex: number;
}): Assignment[] {
  let best: Assignment[] = [];
  let bestScore = -Infinity;

  function consider(assignments: Assignment[]): void {
    const score = assignmentScore(assignments, args.currentBlock);
    const signature = assignments.map(({ item, block }) => `${item.id}:${block}`).join("|");
    const bestSignature = best.map(({ item, block }) => `${item.id}:${block}`).join("|");
    if (score > bestScore || (score === bestScore && signature < bestSignature)) {
      best = [...assignments];
      bestScore = score;
    }
  }

  function search(itemIndex: number, slotIndex: number, assignments: Assignment[]): void {
    consider(assignments);
    if (itemIndex >= args.items.length || slotIndex >= args.slots.length) return;

    search(itemIndex + 1, slotIndex, assignments);
    search(itemIndex, slotIndex + 1, assignments);

    const item = args.items[itemIndex];
    const block = args.slots[slotIndex];
    const mayStay = item.block === block;
    const mayMove = regularHoursCoverBlock(
      item.openingPeriods,
      args.startDate,
      args.dayIndex,
      block,
      item.durationMin,
    );
    if (mayStay || mayMove) {
      assignments.push({ item, block });
      search(itemIndex + 1, slotIndex + 1, assignments);
      assignments.pop();
    }
  }

  search(0, 0, []);
  return best;
}

export function buildPartialDayPreview(args: {
  items: PartialDayItem[];
  startDate: string;
  dayIndex: number;
  currentBlock: Block;
}): PartialDayPreview {
  const dayItems = args.items
    .filter((item) => item.dayIndex === args.dayIndex)
    .sort((a, b) => rank(a.block) - rank(b.block) || a.position - b.position);
  const preserved: PartialDayPreserved[] = dayItems
    .filter((item) => item.status !== "planned" || item.isLocked)
    .map((item) => ({
      itemId: item.id,
      venueName: item.venueName,
      block: item.block,
      reason: item.isLocked ? "locked" : item.status === "done" ? "completed" : "skipped",
    }));
  const protectedFutureBlocks = new Set(
    dayItems
      .filter((item) => item.status === "planned" && item.isLocked)
      .filter((item) => rank(item.block) >= rank(args.currentBlock))
      .map((item) => item.block),
  );
  const futureSlots = BLOCKS
    .filter((block) => rank(block) >= rank(args.currentBlock))
    .filter((block) => !protectedFutureBlocks.has(block));
  const flexible = dayItems.filter((item) => item.status === "planned" && !item.isLocked);

  const assignments = (["activity", "meal"] as const).flatMap((kind) => bestOrderedAssignment({
    items: flexible.filter((item) => slotKind(item.block) === kind),
    slots: futureSlots.filter((block) => slotKind(block) === kind),
    currentBlock: args.currentBlock,
    startDate: args.startDate,
    dayIndex: args.dayIndex,
  }));
  const targetByItemId = new Map(assignments.map((assignment) => [assignment.item.id, assignment.block]));
  const selectedIds = new Set(targetByItemId.keys());
  const moves = flexible
    .filter((item) => selectedIds.has(item.id) && targetByItemId.get(item.id) !== item.block)
    .map((item): ItineraryMove => ({
      itemId: item.id,
      fromDayIndex: item.dayIndex,
      fromBlock: item.block,
      toDayIndex: args.dayIndex,
      toBlock: targetByItemId.get(item.id)!,
    }));
  const skips = flexible
    .filter((item) => !selectedIds.has(item.id))
    .map((item): PartialDaySkip => ({
      itemId: item.id,
      venueName: item.venueName,
      fromDayIndex: item.dayIndex,
      fromBlock: item.block,
      reason: "No safe remaining slot fits this activity and its regular hours",
    }));

  return {
    kind: "partial-day",
    trigger: "running-late",
    dayIndex: args.dayIndex,
    currentBlock: args.currentBlock,
    moves,
    skips,
    preserved,
    conflicts: [],
  };
}
