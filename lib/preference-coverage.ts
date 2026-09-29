import { INTERESTS, type Interest } from "./schema";

export type PreferenceTraveler = {
  id: string;
  displayName: string;
  interests: string[];
  pace: string;
  dietary: string;
  constraintsNote?: string;
};

export type PreferenceItem = {
  id: string;
  dayIndex: number;
  status: "planned" | "done" | "skipped";
  categories: string[];
};

export type ActivityPreferenceCoverage = {
  itemId: string;
  matchedInterests: Interest[];
  supporters: {
    travelerId: string;
    displayName: string;
    interests: Interest[];
  }[];
  otherTravelers: {
    travelerId: string;
    displayName: string;
  }[];
};

export type TravelerPreferenceCoverage = {
  travelerId: string;
  displayName: string;
  matchedActivityCount: number;
  coveredInterests: Interest[];
  uncoveredInterests: Interest[];
};

export type PreferenceBalance = "balanced" | "mixed" | "uneven" | "unavailable";

export type PreferenceCoverageReport = {
  balance: PreferenceBalance;
  activeItemCount: number;
  classifiedItemCount: number;
  unclassifiedItemCount: number;
  coveredInterestCount: number;
  requestedInterestCount: number;
  activities: ActivityPreferenceCoverage[];
  travelers: TravelerPreferenceCoverage[];
  paceGroups: { pace: string; names: string[] }[];
  dietaryNeeds: { dietary: string; names: string[] }[];
  constraintNotes: { displayName: string; note: string }[];
  averageStopsPerDay: number;
};

const INTEREST_SET = new Set<string>(INTERESTS);
const CATEGORY_ALIASES: Record<string, Interest> = {
  breakfast: "food",
  cafe: "food",
  restaurant: "food",
};

function unique<T>(values: T[]): T[] {
  return [...new Set(values)];
}

/** Convert persisted venue-search categories into the interests shown to travelers. */
export function categoriesToInterests(categories: string[]): Interest[] {
  return unique(categories.flatMap((value) => {
    const category = value.trim().toLowerCase();
    if (INTEREST_SET.has(category)) return [category as Interest];
    return CATEGORY_ALIASES[category] ? [CATEGORY_ALIASES[category]] : [];
  }));
}

function groupTravelerValue(
  travelers: PreferenceTraveler[],
  valueFor: (traveler: PreferenceTraveler) => string,
): { value: string; names: string[] }[] {
  const groups = new Map<string, string[]>();
  for (const traveler of travelers) {
    const value = valueFor(traveler);
    if (!value) continue;
    const names = groups.get(value) ?? [];
    names.push(traveler.displayName);
    groups.set(value, names);
  }
  return [...groups].map(([value, names]) => ({ value, names }));
}

/**
 * Explain preference coverage from durable evidence only.
 *
 * Venue categories record which searches discovered a place. We deliberately do
 * not parse the model-written why-note or infer interests from a venue name.
 */
export function analyzePreferenceCoverage(args: {
  travelers: PreferenceTraveler[];
  items: PreferenceItem[];
}): PreferenceCoverageReport {
  const activeItems = args.items.filter((item) => item.status !== "skipped");
  const activities = activeItems.map((item): ActivityPreferenceCoverage => {
    const itemInterests = categoriesToInterests(item.categories);
    const supporters = args.travelers.flatMap((traveler) => {
      const travelerInterests = new Set(traveler.interests);
      const matched = itemInterests.filter((interest) => travelerInterests.has(interest));
      return matched.length > 0
        ? [{
            travelerId: traveler.id,
            displayName: traveler.displayName,
            interests: matched,
          }]
        : [];
    });
    const supporterIds = new Set(supporters.map((supporter) => supporter.travelerId));
    return {
      itemId: item.id,
      matchedInterests: itemInterests,
      supporters,
      otherTravelers: args.travelers
        .filter((traveler) => !supporterIds.has(traveler.id))
        .map((traveler) => ({ travelerId: traveler.id, displayName: traveler.displayName })),
    };
  });

  const activityById = new Map(activities.map((activity) => [activity.itemId, activity]));
  const travelers = args.travelers.map((traveler): TravelerPreferenceCoverage => {
    const requested = unique(
      traveler.interests
        .map((interest) => interest.trim().toLowerCase())
        .filter((interest): interest is Interest => INTEREST_SET.has(interest)),
    );
    const covered = unique(activeItems.flatMap((item) => {
      const activity = activityById.get(item.id);
      return activity?.supporters.find((supporter) => supporter.travelerId === traveler.id)?.interests ?? [];
    }));
    return {
      travelerId: traveler.id,
      displayName: traveler.displayName,
      matchedActivityCount: activities.filter((activity) =>
        activity.supporters.some((supporter) => supporter.travelerId === traveler.id),
      ).length,
      coveredInterests: covered,
      uncoveredInterests: requested.filter((interest) => !covered.includes(interest)),
    };
  });

  const classifiedItemCount = activities.filter((activity) => activity.matchedInterests.length > 0).length;
  const coverageCounts = travelers.map((traveler) => traveler.matchedActivityCount);
  const maxCoverage = Math.max(0, ...coverageCounts);
  const minCoverage = Math.min(...coverageCounts);
  const balance: PreferenceBalance = (() => {
    if (travelers.length === 0 || classifiedItemCount === 0 || maxCoverage === 0) return "unavailable";
    const ratio = minCoverage / maxCoverage;
    if (ratio >= 0.75) return "balanced";
    if (ratio >= 0.5) return "mixed";
    return "uneven";
  })();

  const requestedInterestCount = travelers.reduce(
    (sum, traveler) => sum + traveler.coveredInterests.length + traveler.uncoveredInterests.length,
    0,
  );
  const coveredInterestCount = travelers.reduce(
    (sum, traveler) => sum + traveler.coveredInterests.length,
    0,
  );
  const activeDays = new Set(activeItems.map((item) => item.dayIndex)).size;
  const paceGroups = groupTravelerValue(args.travelers, (traveler) => traveler.pace)
    .map(({ value, names }) => ({ pace: value, names }));
  const dietaryNeeds = groupTravelerValue(
    args.travelers.filter((traveler) => traveler.dietary !== "none"),
    (traveler) => traveler.dietary,
  ).map(({ value, names }) => ({ dietary: value, names }));

  return {
    balance,
    activeItemCount: activeItems.length,
    classifiedItemCount,
    unclassifiedItemCount: activeItems.length - classifiedItemCount,
    coveredInterestCount,
    requestedInterestCount,
    activities,
    travelers,
    paceGroups,
    dietaryNeeds,
    constraintNotes: args.travelers.flatMap((traveler) => {
      const note = traveler.constraintsNote?.trim();
      return note ? [{ displayName: traveler.displayName, note }] : [];
    }),
    averageStopsPerDay: activeDays === 0 ? 0 : activeItems.length / activeDays,
  };
}
