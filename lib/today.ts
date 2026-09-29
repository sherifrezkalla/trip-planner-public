import { haversineKm } from "./geo";
import { BLOCK_START_MINUTES, pointToWeekMinute, WEEK_MINUTES } from "./opening-hours";
import type { OpeningPeriod } from "./places";
import { BLOCKS, type Block } from "./schema";
import type { ReservationDetails } from "./reservations";

/**
 * The blocks a day can hold, in the order they run.
 *
 * Aliases of the schema's `BLOCKS` and the shared block clock rather than copies
 * of them. Both were written out again here, and again in `reshuffle.ts`, all
 * three identical — so the order a day runs in was defined in four places and
 * the times in two, with nothing tying them together.
 *
 * The names stay because Today Mode's callers read better with them, and
 * `TODAY_BLOCK_START_MINUTES` keeps its wider `Record<string, number>` type:
 * this module indexes it with a block that arrives from the database as a plain
 * string.
 */
export const TODAY_BLOCK_ORDER = BLOCKS;

export const TODAY_BLOCK_START_MINUTES: Record<string, number> = BLOCK_START_MINUTES;

export type TodayStatus = "planned" | "done" | "skipped";

export type TodayItem = {
  id: string;
  dayIndex: number;
  block: string;
  status: TodayStatus;
  completedDayIndex: number | null;
  position: number;
  durationMin?: number;
  reservation?: ReservationDetails;
  venue: {
    name?: string;
    openingHours: string[];
    openingPeriods?: OpeningPeriod[];
    lat?: number;
    lng?: number;
  };
};

export type VenueHoursRisk = {
  level: "clear" | "warning" | "danger" | "unknown";
  message: string;
};

export type TransferEstimate = {
  distanceKm: number;
  durationMin: number;
  mode: "walk" | "local transfer" | "drive";
};

export type LeaveByEstimate = {
  originName: string;
  scheduledAt: Date;
  leaveBy: Date;
  transfer: TransferEstimate;
  urgency: "later" | "soon" | "now" | "late";
};

export type TripTiming = {
  phase: "before" | "during" | "after";
  dayIndex: number;
  daysUntilStart: number;
  daysSinceEnd: number;
};

export type TripDayDisplay = {
  shortDate: string;
  fullDate: string;
  isToday: boolean;
};

const MS_PER_DAY = 86_400_000;
// en-GB to match the rest of the app, and day-before-month because the trips are
// European. The weekday earns its place: opening hours turn on it, so "Mon" is
// worth more to someone reading a plan than "Day 3".
const SHORT_DAY_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
  month: "short",
  timeZone: "UTC",
});
const FULL_DAY_FORMATTER = new Intl.DateTimeFormat("en-GB", {
  weekday: "long",
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

function dateOrdinal(value: string): number {
  const [year, month, day] = value.split("-").map(Number);
  return Date.UTC(year, month - 1, day) / MS_PER_DAY;
}
function localDateOrdinal(now: Date): number {
  return Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()) / MS_PER_DAY;
}

/** Builds stable labels for a date-only itinerary day without timezone drift. */
export function getTripDayDisplay(
  startDate: string,
  dayIndex: number,
  now = new Date(),
): TripDayDisplay {
  const ordinal = dateOrdinal(startDate) + dayIndex;
  const date = new Date(ordinal * MS_PER_DAY);
  return {
    shortDate: SHORT_DAY_FORMATTER.format(date),
    fullDate: FULL_DAY_FORMATTER.format(date),
    isToday: ordinal === localDateOrdinal(now),
  };
}

/** Date-only trip values are compared with the traveler's local calendar day. */
export function getTripTiming(startDate: string, endDate: string, now = new Date()): TripTiming {
  const today = localDateOrdinal(now);
  const start = dateOrdinal(startDate);
  const end = dateOrdinal(endDate);
  const dayCount = Math.max(1, end - start + 1);

  if (today < start) {
    return {
      phase: "before",
      dayIndex: 0,
      daysUntilStart: start - today,
      daysSinceEnd: 0,
    };
  }
  if (today > end) {
    return {
      phase: "after",
      dayIndex: dayCount - 1,
      daysUntilStart: 0,
      daysSinceEnd: today - end,
    };
  }
  return {
    phase: "during",
    dayIndex: today - start,
    daysUntilStart: 0,
    daysSinceEnd: 0,
  };
}

function blockRank(block: string): number {
  const rank = TODAY_BLOCK_ORDER.indexOf(block as (typeof TODAY_BLOCK_ORDER)[number]);
  return rank === -1 ? TODAY_BLOCK_ORDER.length : rank;
}

function currentBlockRank(hour: number): number {
  if (hour < 11) return 0;
  if (hour < 14) return 1;
  if (hour < 18) return 2;
  if (hour < 21) return 3;
  return 4;
}

export function currentTodayBlock(now = new Date()): Block {
  return TODAY_BLOCK_ORDER[currentBlockRank(now.getHours())];
}

/**
 * Includes activities scheduled today and activities completed today ahead of
 * schedule. The item id de-duplication keeps an early completion from appearing
 * twice in the Today timeline.
 */
export function itemsForToday(items: TodayItem[], dayIndex: number): TodayItem[] {
  return items
    .filter((item) => item.dayIndex === dayIndex ||
      (item.status === "done" && item.completedDayIndex === dayIndex))
    .filter((item, index, all) => all.findIndex((candidate) => candidate.id === item.id) === index)
    .sort((a, b) => blockRank(a.block) - blockRank(b.block) || a.position - b.position);
}

export function nextTodayItem(items: TodayItem[], dayIndex: number, now = new Date()): TodayItem | null {
  const planned = itemsForToday(items, dayIndex).filter((item) => item.status === "planned");
  const currentRank = currentBlockRank(now.getHours());
  return planned.find((item) => blockRank(item.block) >= currentRank) ?? planned[0] ?? null;
}

export function openingHoursForToday(openingHours: string[], now = new Date()): string | null {
  const weekday = new Intl.DateTimeFormat("en-US", { weekday: "long" }).format(now).toLowerCase();
  return openingHours.find((line) => line.trim().toLowerCase().startsWith(`${weekday}:`)) ?? null;
}

export function freshnessLabel(value: string, now = new Date()): string {
  const timestamp = new Date(value).getTime();
  if (!Number.isFinite(timestamp)) return "freshness unknown";
  const minutes = Math.max(0, Math.floor((now.getTime() - timestamp) / 60_000));
  if (minutes < 2) return "checked just now";
  if (minutes < 60) return `checked ${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `checked ${hours} ${hours === 1 ? "hr" : "hrs"} ago`;
  const days = Math.floor(hours / 24);
  return `checked ${days} ${days === 1 ? "day" : "days"} ago`;
}

function tripDate(startDate: string, dayIndex: number, minutes = 0): Date {
  const [year, month, day] = startDate.split("-").map(Number);
  return new Date(year, month - 1, day + dayIndex, Math.floor(minutes / 60), minutes % 60);
}

function formatMinutes(minutes: number): string {
  const normalized = ((minutes % (24 * 60)) + 24 * 60) % (24 * 60);
  const hour = Math.floor(normalized / 60).toString().padStart(2, "0");
  const minute = (normalized % 60).toString().padStart(2, "0");
  return `${hour}:${minute}`;
}

/** Evaluate regular Google opening periods against the visit window in venue-local calendar terms. */
export function venueHoursRisk(
  openingPeriods: OpeningPeriod[] | undefined,
  startDate: string,
  dayIndex: number,
  block: string,
  durationMin: number,
  now = new Date(),
): VenueHoursRisk {
  if (!openingPeriods?.length) {
    return { level: "unknown", message: "Opening status unknown — verify before leaving" };
  }

  const scheduled = tripDate(startDate, dayIndex, TODAY_BLOCK_START_MINUTES[block] ?? 0);
  const sameLocalDay = scheduled.getFullYear() === now.getFullYear()
    && scheduled.getMonth() === now.getMonth()
    && scheduled.getDate() === now.getDate();
  const startMinuteOfDay = sameLocalDay && now > scheduled
    ? now.getHours() * 60 + now.getMinutes()
    : TODAY_BLOCK_START_MINUTES[block] ?? 0;
  const target = scheduled.getDay() * 24 * 60 + startMinuteOfDay;

  for (const period of openingPeriods) {
    if (!period.close) {
      if (period.open.day === 0 && period.open.hour === 0 && period.open.minute === 0) {
        return { level: "clear", message: "Regular hours show open throughout this visit" };
      }
      continue;
    }
    const open = pointToWeekMinute(period.open);
    let close = pointToWeekMinute(period.close);
    if (close <= open) close += WEEK_MINUTES;

    for (const candidate of [target, target + WEEK_MINUTES]) {
      if (candidate < open || candidate >= close) continue;
      if (candidate + durationMin <= close) {
        return { level: "clear", message: "Regular hours cover this visit" };
      }
      return {
        level: "warning",
        message: `Regular hours end around ${formatMinutes(close)} before this visit would finish`,
      };
    }
  }

  return { level: "danger", message: "Regular hours show closed at the planned time" };
}

/** Conservative planning estimate. It is intentionally not presented as live routing or traffic data. */
export function estimateTransfer(
  from: { lat?: number; lng?: number },
  to: { lat?: number; lng?: number },
): TransferEstimate | null {
  if (![from.lat, from.lng, to.lat, to.lng].every((value) => Number.isFinite(value))) return null;
  const distanceKm = haversineKm(
    { lat: from.lat!, lng: from.lng! },
    { lat: to.lat!, lng: to.lng! },
  );
  if (distanceKm < 0.05) return null;

  if (distanceKm <= 1.5) {
    return {
      distanceKm,
      durationMin: Math.max(5, Math.ceil(distanceKm / 4.5 * 60 + 5)),
      mode: "walk",
    };
  }
  if (distanceKm <= 15) {
    return {
      distanceKm,
      durationMin: Math.ceil(distanceKm / 25 * 60 + 10),
      mode: "local transfer",
    };
  }
  return {
    distanceKm,
    durationMin: Math.ceil(distanceKm / 55 * 60 + 15),
    mode: "drive",
  };
}

export function leaveByEstimate(
  items: TodayItem[],
  next: TodayItem,
  dayIndex: number,
  startDate: string,
  now = new Date(),
): LeaveByEstimate | null {
  const todayItems = itemsForToday(items, dayIndex);
  const nextIndex = todayItems.findIndex((item) => item.id === next.id);
  const previous = todayItems
    .slice(0, Math.max(0, nextIndex))
    .reverse()
    .find((item) => item.status !== "skipped" && item.venue.lat !== undefined && item.venue.lng !== undefined);
  if (!previous) return null;

  const transfer = estimateTransfer(previous.venue, next.venue);
  if (!transfer) return null;
  const reservedAt = next.reservation
    && ["tentative", "confirmed"].includes(next.reservation.status)
    && next.reservation.reservationAt
    ? new Date(next.reservation.reservationAt)
    : null;
  const scheduledAt = reservedAt && Number.isFinite(reservedAt.getTime())
    ? reservedAt
    : tripDate(startDate, dayIndex, TODAY_BLOCK_START_MINUTES[next.block] ?? 0);
  const leaveBy = new Date(scheduledAt.getTime() - transfer.durationMin * 60_000);
  const minutesUntilLeave = Math.floor((leaveBy.getTime() - now.getTime()) / 60_000);
  const urgency = now >= scheduledAt ? "late"
    : minutesUntilLeave <= 0 ? "now"
      : minutesUntilLeave <= 30 ? "soon"
        : "later";

  const originName = previous.venue.name ?? "the previous stop";
  return { originName, scheduledAt, leaveBy, transfer, urgency };
}
