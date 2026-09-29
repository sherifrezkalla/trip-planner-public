/**
 * Who is actually on the trip on a given day.
 *
 * A trip has one set of dates; the people do not. Someone landing on day 2
 * should not have day 1 planned around them, and an arrival evening filled for
 * people still driving is worse than an empty one.
 *
 * Pure and I/O-free, like `proposals.ts` and `permissions.ts`, so the board and
 * the planner agree on who is present without a round trip.
 */

export type TravellerDates = {
  id: string;
  displayName: string;
  isBot: boolean;
  /** First day present. Null means from the trip start. */
  arrivesOn: string | null;
  /** Last day present. Null means until the trip end. */
  departsOn: string | null;
};

const MS_PER_DAY = 86_400_000;

/** Date-only values are compared as UTC ordinals so no timezone can shift them. */
function ordinal(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}

/** The calendar date of a trip day, as `YYYY-MM-DD`. */
export function dateForDayIndex(startDate: string, dayIndex: number): string {
  return new Date((ordinal(startDate) + dayIndex) * MS_PER_DAY).toISOString().slice(0, 10);
}

/**
 * Whether one traveller is present on one day.
 *
 * Both bounds are inclusive: someone departing on the 27th is there for the
 * 27th. What they are *not* there for is the day after — which is the mistake
 * this is here to stop, since "leaves on the 27th" is easily read as "gone by
 * the 27th" when laying out a plan.
 */
export function isPresentOnDay(
  traveller: Pick<TravellerDates, "arrivesOn" | "departsOn">,
  startDate: string,
  dayIndex: number,
): boolean {
  const day = ordinal(dateForDayIndex(startDate, dayIndex));
  if (traveller.arrivesOn !== null && day < ordinal(traveller.arrivesOn)) return false;
  if (traveller.departsOn !== null && day > ordinal(traveller.departsOn)) return false;
  return true;
}

export type DayAttendance = {
  dayIndex: number;
  present: TravellerDates[];
  absent: TravellerDates[];
};

/**
 * Split the roster for one day.
 *
 * Automated travellers are excluded entirely rather than reported absent: they
 * are not people, and listing them as missing from a day would be noise in the
 * one place a group is checking who is actually around.
 */
export function attendanceForDay(
  travellers: TravellerDates[],
  startDate: string,
  dayIndex: number,
): DayAttendance {
  const humans = travellers.filter((t) => !t.isBot);
  const present: TravellerDates[] = [];
  const absent: TravellerDates[] = [];
  for (const traveller of humans) {
    (isPresentOnDay(traveller, startDate, dayIndex) ? present : absent).push(traveller);
  }
  return { dayIndex, present, absent };
}

/**
 * Days nobody is there for, and days where the group is only partly assembled.
 *
 * A day with no one present is the sharp case: it means the plan holds
 * activities that every single traveller would miss.
 */
export function coverageGaps(
  travellers: TravellerDates[],
  startDate: string,
  dayCount: number,
): { emptyDays: number[]; partialDays: { dayIndex: number; absent: string[] }[] } {
  const emptyDays: number[] = [];
  const partialDays: { dayIndex: number; absent: string[] }[] = [];
  for (let dayIndex = 0; dayIndex < dayCount; dayIndex++) {
    const { present, absent } = attendanceForDay(travellers, startDate, dayIndex);
    if (present.length === 0) emptyDays.push(dayIndex);
    else if (absent.length > 0) {
      partialDays.push({ dayIndex, absent: absent.map((t) => t.displayName) });
    }
  }
  return { emptyDays, partialDays };
}
