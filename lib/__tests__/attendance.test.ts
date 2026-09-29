import { describe, expect, it } from "vitest";
import {
  attendanceForDay,
  coverageGaps,
  dateForDayIndex,
  isPresentOnDay,
  type TravellerDates,
} from "@/lib/attendance";

const START = "2029-01-06"; // Sat 6 Jan, day 0; synthetic trip runs 7 days to Fri 12 Jan

function traveller(
  displayName: string,
  arrivesOn: string | null = null,
  departsOn: string | null = null,
  isBot = false,
): TravellerDates {
  return { id: displayName.toLowerCase(), displayName, arrivesOn, departsOn, isBot };
}

// Entirely synthetic roster; dates exercise inclusive arrival/departure bounds.
const roster: TravellerDates[] = [
  ...["Alex", "Blair", "Casey", "Drew"].map((n) => traveller(n)),
  ...["Emery", "Finley", "Gray", "Harper"].map((n) => traveller(n)),
  traveller("Indigo", "2029-01-07", "2029-01-11"),
  traveller("Jules", "2029-01-06", "2029-01-10"),
  traveller("Example Bot", null, null, true),
];

describe("dateForDayIndex", () => {
  it("walks the calendar without drifting", () => {
    expect(dateForDayIndex(START, 0)).toBe("2029-01-06");
    expect(dateForDayIndex(START, 6)).toBe("2029-01-12");
  });

  it("crosses a month boundary", () => {
    expect(dateForDayIndex("2029-01-30", 3)).toBe("2029-02-02");
  });
});

describe("isPresentOnDay", () => {
  it("treats an unstated date as present throughout", () => {
    const anyone = { arrivesOn: null, departsOn: null };
    expect(isPresentOnDay(anyone, START, 0)).toBe(true);
    expect(isPresentOnDay(anyone, START, 6)).toBe(true);
  });

  /**
   * The bound that is easy to get wrong. The departure date remains a day present; the next date is absent.
   */
  it("counts the departure day as a day present", () => {
    const lateArrival = { arrivesOn: "2029-01-07", departsOn: "2029-01-11" };
    expect(isPresentOnDay(lateArrival, START, 5)).toBe(true);  // Thu 11
    expect(isPresentOnDay(lateArrival, START, 6)).toBe(false); // Fri 12
  });

  it("counts the arrival day as a day present, and the one before as absent", () => {
    const lateArrival = { arrivesOn: "2029-01-07", departsOn: "2029-01-11" };
    expect(isPresentOnDay(lateArrival, START, 0)).toBe(false); // Sat 6
    expect(isPresentOnDay(lateArrival, START, 1)).toBe(true);  // Sun 7
  });
});

describe("attendanceForDay", () => {
  it("leaves automated travellers out of both lists", () => {
    const { present, absent } = attendanceForDay(roster, START, 0);
    const named = [...present, ...absent].map((t) => t.displayName);
    expect(named).not.toContain("Example Bot");
    expect(named).toHaveLength(10);
  });

  it("reports Indigo absent on the Saturday and present on the Sunday", () => {
    expect(attendanceForDay(roster, START, 0).absent.map((t) => t.displayName)).toEqual(["Indigo"]);
    expect(attendanceForDay(roster, START, 1).absent).toEqual([]);
  });

  it("reports Jules absent once he has flown home", () => {
    expect(attendanceForDay(roster, START, 4).absent).toEqual([]);            // Wed 10, his last day
    expect(attendanceForDay(roster, START, 5).absent.map((t) => t.displayName)).toEqual(["Jules"]);
  });

  it("reports both independent travellers gone by the final day", () => {
    expect(attendanceForDay(roster, START, 6).absent.map((t) => t.displayName))
      .toEqual(["Indigo", "Jules"]);
  });
});

describe("coverageGaps", () => {
  it("finds the days the group is only partly assembled", () => {
    const { emptyDays, partialDays } = coverageGaps(roster, START, 7);
    expect(emptyDays).toEqual([]);
    expect(partialDays).toEqual([
      { dayIndex: 0, absent: ["Indigo"] },
      { dayIndex: 5, absent: ["Jules"] },
      { dayIndex: 6, absent: ["Indigo", "Jules"] },
    ]);
  });

  /** The sharp case: a day whose activities every single traveller would miss. */
  it("flags a day nobody is there for", () => {
    const late = [traveller("A", "2029-01-08"), traveller("B", "2029-01-08")];
    expect(coverageGaps(late, START, 7).emptyDays).toEqual([0, 1]);
  });
});
