import { describe, expect, it } from "vitest";
import {
  analyzePreferenceCoverage,
  categoriesToInterests,
  type PreferenceItem,
  type PreferenceTraveler,
} from "@/lib/preference-coverage";

const travelers: PreferenceTraveler[] = [
  {
    id: "a", displayName: "Amina", interests: ["food", "history"],
    pace: "chill", dietary: "vegan", constraintsNote: "Avoid steep stairs",
  },
  {
    id: "b", displayName: "Basil", interests: ["nature"],
    pace: "packed", dietary: "none", constraintsNote: "",
  },
];

function item(
  id: string,
  categories: string[],
  status: PreferenceItem["status"] = "planned",
  dayIndex = 0,
): PreferenceItem {
  return { id, categories, status, dayIndex };
}

describe("categoriesToInterests", () => {
  it("keeps known interests, maps meal categories to food, and ignores opaque categories", () => {
    expect(categoriesToInterests(["history", "restaurant", "breakfast", "suggestion", "HISTORY"]))
      .toEqual(["history", "food"]);
  });
});

describe("analyzePreferenceCoverage", () => {
  it("shows who each activity supports and identifies balanced coverage", () => {
    const report = analyzePreferenceCoverage({
      travelers,
      items: [
        item("museum", ["history"]),
        item("park", ["nature"]),
        item("cafe", ["restaurant"]),
        item("garden", ["nature"]),
      ],
    });

    expect(report.balance).toBe("balanced");
    expect(report.activities[0].supporters).toEqual([{
      travelerId: "a", displayName: "Amina", interests: ["history"],
    }]);
    expect(report.travelers).toEqual([
      expect.objectContaining({
        displayName: "Amina", matchedActivityCount: 2,
        coveredInterests: ["history", "food"], uncoveredInterests: [],
      }),
      expect.objectContaining({
        displayName: "Basil", matchedActivityCount: 2,
        coveredInterests: ["nature"], uncoveredInterests: [],
      }),
    ]);
    expect(report.paceGroups).toHaveLength(2);
    expect(report.dietaryNeeds).toEqual([{ dietary: "vegan", names: ["Amina"] }]);
    expect(report.constraintNotes).toEqual([{ displayName: "Amina", note: "Avoid steep stairs" }]);
  });

  it("excludes skipped activities from the current plan and flags uneven coverage", () => {
    const report = analyzePreferenceCoverage({
      travelers,
      items: [
        item("museum-1", ["history"]),
        item("museum-2", ["history"], "done"),
        item("park", ["nature"], "skipped"),
      ],
    });

    expect(report.activeItemCount).toBe(2);
    expect(report.balance).toBe("uneven");
    expect(report.travelers.find((traveler) => traveler.travelerId === "b"))
      .toEqual(expect.objectContaining({ matchedActivityCount: 0, uncoveredInterests: ["nature"] }));
  });

  it("reports unavailable evidence instead of inventing preference matches", () => {
    const report = analyzePreferenceCoverage({
      travelers,
      items: [item("suggestion", ["suggestion"])],
    });

    expect(report.balance).toBe("unavailable");
    expect(report.classifiedItemCount).toBe(0);
    expect(report.unclassifiedItemCount).toBe(1);
    expect(report.activities[0].supporters).toEqual([]);
  });

  it("calculates average intensity from active days only", () => {
    const report = analyzePreferenceCoverage({
      travelers,
      items: [
        item("one", ["history"], "planned", 0),
        item("two", ["nature"], "planned", 2),
        item("three", ["food"], "planned", 2),
      ],
    });

    expect(report.averageStopsPerDay).toBe(1.5);
  });
});
