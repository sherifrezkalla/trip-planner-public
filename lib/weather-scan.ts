/**
 * Choosing which activities the weather argues against, and what to put there.
 *
 * Everything here is arithmetic over data the model has already been asked
 * about. The one judgement — whether a venue is under a roof — was made once,
 * per venue, and stored. That split is the point: see
 * `docs/architecture/weather-adaptation.md`.
 *
 * Pure and I/O-free, so the scan can be tested without a forecast or a database.
 */

import type { Exposure } from "./venue-exposure";
import { dayThreatensOutdoorPlans, type DayOutlook } from "./weather";

export type ScannableItem = {
  id: string;
  dayIndex: number;
  block: string;
  area: string;
  candidateId: string;
  candidateName: string;
  category: string;
  exposure: Exposure | null;
  isLocked: boolean;
  reservationStatus: string;
  status: string;
};

export type ScannableCandidate = {
  id: string;
  name: string;
  area: string;
  category: string;
  rating: number | null;
  reviewCount: number | null;
  exposure: Exposure | null;
};

/**
 * Below this, a venue is somewhere that exists rather than somewhere to go.
 *
 * Rating alone cannot tell those apart — a five-star boutique with forty reviews
 * outranks a four-star museum with nine thousand. The scan offered exactly that
 * swap for a rained-out beach morning before this floor existed.
 */
export const MIN_REVIEWS_FOR_REPLACEMENT = 100;

const MEAL_BLOCKS = ["lunch", "dinner"];
const MEAL_CATEGORIES = ["food", "restaurant"];
/** Worth crossing a town for in the rain. */
const DESTINATION_CATEGORIES = ["art", "history", "museum"];
/** Indoors, but a thin answer to "the beach is off". */
const LAST_RESORT_CATEGORIES = ["shopping", "nightlife"];

export type WeatherSwap = {
  item: ScannableItem;
  replacement: ScannableCandidate;
  outlook: DayOutlook;
  reason: string;
};

const PROTECTED_RESERVATIONS = ["tentative", "confirmed"];

/**
 * Whether this activity could be changed at all, ignoring the weather.
 *
 * Mirrors the protections the proposal flow enforces anyway. Checking here too
 * means the scan never raises a proposal that would be refused at apply time,
 * which would read to the group as the app arguing with itself.
 */
function isChangeable(item: ScannableItem): boolean {
  return item.status === "planned"
    && !item.isLocked
    && !PROTECTED_RESERVATIONS.includes(item.reservationStatus);
}

/**
 * A `covered` venue is only at risk in a thunderstorm.
 *
 * A roofed market is fine in drizzle, and swapping it out would be the kind of
 * over-correction that empties a Riviera itinerary at the first cloud.
 */
function isThreatened(item: ScannableItem, outlook: DayOutlook): boolean {
  if (item.exposure === "outdoor") return true;
  if (item.exposure === "covered") return outlook.severe;
  return false;
}

/**
 * How much a candidate is worth going to instead, for this particular slot.
 *
 * A meal block wants a meal: a museum is not a dinner, whatever the weather, so
 * for lunch and dinner anything else is excluded rather than merely demoted.
 * Outside meals the order is destinations first, retail last.
 */
function replacementTier(candidate: ScannableCandidate, item: ScannableItem): number {
  if (MEAL_BLOCKS.includes(item.block)) {
    return MEAL_CATEGORIES.includes(candidate.category) ? 2 : -1;
  }
  if (DESTINATION_CATEGORIES.includes(candidate.category)) return 2;
  if (LAST_RESORT_CATEGORIES.includes(candidate.category)) return 0;
  return 1;
}

/**
 * Rank replacements: worth going to first, then well regarded.
 *
 * Staying in the same area is not a preference but a constraint — the day's
 * travel is already planned around it, and a replacement across the bay is a
 * different day, not a substitution.
 *
 * Proposing nothing is a valid outcome. A slot with no decent indoor answer
 * nearby should stay as it is and let the group decide in the moment, rather
 * than be handed a shop because a shop was available.
 */
function pickReplacement(
  item: ScannableItem,
  candidates: ScannableCandidate[],
  taken: Set<string>,
): ScannableCandidate | null {
  const viable = candidates
    .filter((candidate) =>
      candidate.area === item.area
      && candidate.exposure === "indoor"
      && candidate.id !== item.candidateId
      && !taken.has(candidate.id)
      && (candidate.reviewCount ?? 0) >= MIN_REVIEWS_FOR_REPLACEMENT
      && replacementTier(candidate, item) >= 0)
    .sort((left, right) => {
      const tier = replacementTier(right, item) - replacementTier(left, item);
      if (tier !== 0) return tier;
      const rating = (right.rating ?? 0) - (left.rating ?? 0);
      if (rating !== 0) return rating;
      // A tie on stars goes to the one more people have actually been to.
      return (right.reviewCount ?? 0) - (left.reviewCount ?? 0);
    });
  return viable[0] ?? null;
}

/**
 * Every substitution the forecast argues for, at most one per activity.
 *
 * `alreadyPlanned` seeds the taken set so a replacement never duplicates a venue
 * the plan already holds, and each pick is added as it is made so two wet slots
 * on the same day cannot both be sent to the same museum.
 */
export function planWeatherSwaps(args: {
  items: ScannableItem[];
  candidates: ScannableCandidate[];
  outlookByDayIndex: Map<number, DayOutlook>;
  alreadyPlanned: string[];
}): WeatherSwap[] {
  const taken = new Set(args.alreadyPlanned);
  const swaps: WeatherSwap[] = [];

  for (const item of args.items) {
    if (!isChangeable(item)) continue;
    const outlook = args.outlookByDayIndex.get(item.dayIndex);
    if (!outlook || !dayThreatensOutdoorPlans(outlook)) continue;
    if (!isThreatened(item, outlook)) continue;

    const replacement = pickReplacement(item, args.candidates, taken);
    if (!replacement) continue;
    taken.add(replacement.id);

    const cause = outlook.severe
      ? "thunderstorms forecast"
      : `${outlook.maxPrecipitationProbability}% chance of rain`;
    swaps.push({
      item,
      replacement,
      outlook,
      reason: `${outlook.date}: ${cause}. Indoors instead of ${item.candidateName}.`,
    });
  }
  return swaps;
}
