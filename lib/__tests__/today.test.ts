import { describe, expect, it } from "vitest";
import {
  currentTodayBlock,
  estimateTransfer,
  freshnessLabel,
  getTripDayDisplay,
  getTripTiming,
  itemsForToday,
  leaveByEstimate,
  nextTodayItem,
  openingHoursForToday,
  type TodayItem,
  venueHoursRisk,
} from "@/lib/today";

function item(overrides: Partial<TodayItem> & Pick<TodayItem, "id" | "dayIndex" | "block">): TodayItem {
  return {
    status: "planned",
    completedDayIndex: null,
    position: 0,
    venue: { openingHours: [] },
    ...overrides,
  };
}

describe("Today Mode", () => {
  it("maps the traveler's local time to the active planning block", () => {
    expect(currentTodayBlock(new Date(2026, 7, 11, 10, 30))).toBe("morning");
    expect(currentTodayBlock(new Date(2026, 7, 11, 16, 0))).toBe("afternoon");
    expect(currentTodayBlock(new Date(2026, 7, 11, 21, 0))).toBe("evening");
  });

  it("identifies the live trip day from the traveler's local date", () => {
    const timing = getTripTiming("2026-08-07", "2026-08-19", new Date(2026, 7, 11, 8));
    expect(timing).toMatchObject({ phase: "during", dayIndex: 4 });
  });

  it("reports before and after trip states without returning an invalid day", () => {
    expect(getTripTiming("2026-08-07", "2026-08-19", new Date(2026, 7, 5))).toMatchObject({
      phase: "before",
      dayIndex: 0,
      daysUntilStart: 2,
    });
    expect(getTripTiming("2026-08-07", "2026-08-19", new Date(2026, 7, 21))).toMatchObject({
      phase: "after",
      dayIndex: 12,
      daysSinceEnd: 2,
    });
  });

  it("shows an activity completed early on the day it actually happened", () => {
    const early = item({ id: "boat", dayIndex: 6, block: "afternoon", status: "done", completedDayIndex: 4 });
    const scheduled = item({ id: "lunch", dayIndex: 4, block: "lunch" });
    expect(itemsForToday([early, scheduled], 4).map(({ id }) => id)).toEqual(["lunch", "boat"]);
  });

  it("chooses the next unfinished block and falls back to an overdue activity", () => {
    const morning = item({ id: "museum", dayIndex: 4, block: "morning" });
    const dinner = item({ id: "dinner", dayIndex: 4, block: "dinner" });
    expect(nextTodayItem([morning, dinner], 4, new Date(2026, 7, 11, 15))?.id).toBe("dinner");
    expect(nextTodayItem([morning], 4, new Date(2026, 7, 11, 22))?.id).toBe("museum");
  });

  it("extracts today's listed venue hours", () => {
    const hours = ["Monday: 09:00–17:00", "Tuesday: 10:00–18:00"];
    expect(openingHoursForToday(hours, new Date(2026, 7, 11))).toBe("Tuesday: 10:00–18:00");
  });

  it("makes provider freshness visible without showing raw timestamps", () => {
    const now = new Date("2026-08-11T12:00:00Z");
    expect(freshnessLabel("2026-08-11T11:42:00Z", now)).toBe("checked 18 min ago");
    expect(freshnessLabel("2026-08-09T11:00:00Z", now)).toBe("checked 2 days ago");
    expect(freshnessLabel("not-a-date", now)).toBe("freshness unknown");
  });

  it("uses structured hours to warn when a visit runs beyond closing", () => {
    const periods = [{
      open: { day: 2, hour: 10, minute: 0 },
      close: { day: 2, hour: 16, minute: 0 },
    }];
    expect(venueHoursRisk(periods, "2026-08-11", 0, "afternoon", 90, new Date(2026, 7, 11, 12)))
      .toEqual({
        level: "warning",
        message: "Regular hours end around 16:00 before this visit would finish",
      });
  });

  it("checks an overdue activity against the current time", () => {
    const periods = [{
      open: { day: 2, hour: 9, minute: 0 },
      close: { day: 2, hour: 17, minute: 0 },
    }];
    expect(venueHoursRisk(periods, "2026-08-11", 0, "morning", 60, new Date(2026, 7, 11, 18)))
      .toMatchObject({ level: "danger" });
  });

  it("recognizes Google's always-open period shape", () => {
    const periods = [{ open: { day: 0, hour: 0, minute: 0 } }];
    expect(venueHoursRisk(periods, "2026-08-11", 0, "dinner", 120))
      .toMatchObject({ level: "clear" });
  });

  it("returns an explicit unknown state when structured hours are unavailable", () => {
    expect(venueHoursRisk([], "2026-08-11", 0, "morning", 60))
      .toMatchObject({ level: "unknown" });
  });

  it("builds a conservative transfer estimate from venue distance", () => {
    expect(estimateTransfer(
      { lat: 40.7128, lng: -74.006 },
      { lat: 40.7218, lng: -74.006 },
    )).toMatchObject({ mode: "walk" });
    expect(estimateTransfer(
      { lat: 40.7128, lng: -74.006 },
      { lat: 40.8028, lng: -74.006 },
    )).toMatchObject({ mode: "local transfer" });
  });

  it("calculates leave-by time from the previous usable stop", () => {
    const previous = item({
      id: "museum",
      dayIndex: 0,
      block: "morning",
      status: "done",
      venue: { openingHours: [], lat: 40.7128, lng: -74.006, name: "Museum" },
    });
    const lunch = item({
      id: "lunch",
      dayIndex: 0,
      block: "lunch",
      venue: { openingHours: [], lat: 40.7218, lng: -74.006 },
    });
    const estimate = leaveByEstimate(
      [previous, lunch],
      lunch,
      0,
      "2026-08-11",
      new Date(2026, 7, 11, 11, 0),
    );
    expect(estimate?.originName).toBe("Museum");
    expect(estimate?.scheduledAt.getHours()).toBe(13);
    expect(estimate?.leaveBy.getTime()).toBeLessThan(estimate!.scheduledAt.getTime());
    expect(estimate?.urgency).toBe("later");
  });

  it("uses an exact reservation time instead of the semantic block start", () => {
    const previous = item({
      id: "museum",
      dayIndex: 0,
      block: "afternoon",
      status: "done",
      venue: { openingHours: [], lat: 40.7128, lng: -74.006, name: "Museum" },
    });
    const dinner = item({
      id: "dinner",
      dayIndex: 0,
      block: "dinner",
      venue: { openingHours: [], lat: 40.7218, lng: -74.006 },
      reservation: {
        status: "confirmed",
        reservationAt: "2026-08-11T20:15:00.000Z",
        confirmationNumber: null,
        bookingUrl: null,
        cancellationDeadline: null,
        autoLocked: true,
      },
    });
    const estimate = leaveByEstimate(
      [previous, dinner],
      dinner,
      0,
      "2026-08-11",
      new Date("2026-08-11T18:00:00.000Z"),
    );
    expect(estimate?.scheduledAt.toISOString()).toBe("2026-08-11T20:15:00.000Z");
  });
});

describe("getTripDayDisplay", () => {
  it("labels each day with its own calendar date", () => {
    expect(getTripDayDisplay("2026-08-22", 0)).toMatchObject({
      shortDate: "Sat 22 Aug",
      fullDate: "Saturday, 22 August 2026",
    });
    expect(getTripDayDisplay("2026-08-22", 6)).toMatchObject({
      shortDate: "Fri 28 Aug",
      fullDate: "Friday, 28 August 2026",
    });
  });

  it("crosses a month boundary without drifting", () => {
    expect(getTripDayDisplay("2026-08-30", 3).shortDate).toBe("Wed 2 Sept");
  });

  /**
   * Date-only trip values carry no timezone. Formatting them in local time
   * shifts the label a day backwards for anyone west of UTC, so the whole
   * calculation is pinned to UTC.
   */
  it("shows the same date regardless of the reader's timezone", () => {
    const previous = process.env.TZ;
    for (const zone of ["Pacific/Kiritimati", "Pacific/Midway", "Europe/Berlin"]) {
      process.env.TZ = zone;
      expect(getTripDayDisplay("2026-08-22", 0).shortDate).toBe("Sat 22 Aug");
    }
    process.env.TZ = previous;
  });

  it("marks only the reader's current calendar day as today", () => {
    const duringDay2 = new Date(2026, 7, 24, 15, 0, 0);
    expect(getTripDayDisplay("2026-08-22", 2, duringDay2).isToday).toBe(true);
    expect(getTripDayDisplay("2026-08-22", 1, duringDay2).isToday).toBe(false);
    expect(getTripDayDisplay("2026-08-22", 3, duringDay2).isToday).toBe(false);
  });
});
