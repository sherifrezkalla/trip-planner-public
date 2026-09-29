/**
 * Reading Google's regular opening periods against a planned visit.
 *
 * Google gives hours as periods on a weekly clock: an open point and usually a
 * close point, each a weekday plus a time. Answering "is this venue open when we
 * mean to be there" from that shape needs the same four things every time — the
 * weekday the trip's day falls on, the minute a block starts, both points folded
 * onto one week-long number line, and a wrap for periods that cross midnight.
 *
 * All four existed three times over, in generation, partial-day replanning and
 * Today Mode, arrived at independently and identically. That is the dangerous
 * kind of duplication: every copy handles Google's lone-Sunday-midnight 24/7
 * shape, so anyone reading one has no reason to suspect the others, and a
 * correction to the rule would have left two of them wrong.
 *
 * Today Mode's `venueHoursRisk` still has its own traversal and deliberately so:
 * it grades a visit rather than admitting it, works in the venue's local
 * calendar, and treats a block already underway as starting now. It shares these
 * primitives; the judgement on top is genuinely different.
 */

import type { OpeningPeriod } from "./places";
import type { Block } from "./schema";

export const WEEK_MINUTES = 7 * 24 * 60;

/**
 * When each block is taken to begin.
 *
 * Canonical rather than measured: a block is a part of a day, not a booking, so
 * the plan commits to one start per block and every consumer reads the visit
 * from the same clock.
 */
export const BLOCK_START_MINUTES: Record<Block, number> = {
  morning: 9 * 60,
  lunch: 13 * 60,
  afternoon: 15 * 60 + 30,
  dinner: 19 * 60,
  evening: 21 * 60 + 30,
};

/** A weekday-plus-time point as one number on a week-long line. */
export function pointToWeekMinute(point: { day: number; hour: number; minute: number }): number {
  return point.day * 24 * 60 + point.hour * 60 + point.minute;
}

/**
 * Which weekday a trip day lands on.
 *
 * Fixed to UTC on purpose. A trip day is a position in an itinerary, not an
 * instant, so resolving it against the reader's timezone would make the same
 * plan open on Monday for one traveller and Sunday for another.
 */
export function tripWeekday(startDate: string, dayIndex: number): number {
  const date = new Date(`${startDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + dayIndex);
  return date.getUTCDay();
}

/**
 * Whether regular hours cover a whole visit in this block on this trip day.
 *
 * No periods means no, not yes: an unknown venue is not an open one, and both
 * callers are choosing what to commit the group to.
 *
 * The visit is checked at `target` and again a week later, because a period that
 * closes after midnight is stored with a close point earlier in the week than
 * its open point. Shifting the close past the end of the week rather than
 * wrapping the target keeps both comparisons on one monotonic line.
 */
export function regularHoursCoverBlock(
  periods: OpeningPeriod[],
  startDate: string,
  dayIndex: number,
  block: Block,
  durationMin = 0,
): boolean {
  if (periods.length === 0) return false;
  const target = tripWeekday(startDate, dayIndex) * 24 * 60 + BLOCK_START_MINUTES[block];

  return periods.some((period) => {
    // Google documents a lone Sunday 00:00 open point as the 24/7 shape.
    if (!period.close) {
      return period.open.day === 0 && period.open.hour === 0 && period.open.minute === 0;
    }
    const open = pointToWeekMinute(period.open);
    let close = pointToWeekMinute(period.close);
    if (close <= open) close += WEEK_MINUTES;
    return [target, target + WEEK_MINUTES].some(
      (candidate) => candidate >= open && candidate + durationMin <= close,
    );
  });
}
