import { z } from "zod";
import { callWithFallback, type Callers } from "./llm";
import { extractJson } from "./generate";
import { haversineKm } from "./geo";

export type Area = {
  name: string;
  lat: number;
  lng: number;
  why: string;
  /**
   * The member suggestion this area satisfies, in the member's own wording.
   *
   * A suggestion naming a town used to be searched as a venue near the base, so
   * "Monaco" returned a A regional plan boutique called APM Monaco A regional plan and the town
   * itself was never visited. Carrying the original wording lets the caller skip
   * that venue search for a request that has become a place to go instead — and
   * it survives translation, which name matching does not: "Nizza" is answered
   * with the area "Nice".
   */
  request?: string;
};

/** Enough to cover a region without diluting the candidate pool per area. */
export const MAX_AREAS = 8;

/**
 * How many day-trip areas a trip of this length can actually use.
 *
 * A day trip roughly every other day is a sane pace; the base absorbs the rest.
 * The cap is not only about pacing — every extra area multiplies the venue list
 * the planner has to read. A week-long regional plan can be offered hundreds of
 * venues, exhausting the model’s time budget.
 *
 * Fewer, better areas make a better trip and a faster one.
 */
export function areaBudget(dayCount: number): number {
  return Math.max(1, Math.min(MAX_AREAS, Math.ceil(dayCount / 2)));
}

const areaListSchema = z.object({
  areas: z
    .array(
      z.object({
        name: z.string().min(1),
        lat: z.number().min(-90).max(90),
        lng: z.number().min(-180).max(180),
        why: z.string(),
        request: z.string().optional(),
      }),
    )
    .min(1),
});

export function buildAreaPrompt(args: {
  base: { name: string; lat: number; lng: number };
  radiusKm: number;
  interests: string[];
  /** Member suggestions, verbatim. Any that name a place belong here. */
  requests?: string[];
}): string {
  const interests = [...new Set(args.interests)].join(", ") || "general sightseeing";
  const requests = [...new Set(args.requests ?? [])];
  const requestBlock =
    requests.length === 0
      ? ""
      : `

The group explicitly asked to go to these places, in their own words:
${requests.map((request) => `- ${request}`).join("\n")}

Some of those are towns or areas; others may be a single venue or too vague to place. For every one that really is a town or area within range, include it and set "request" to the member's exact wording above, copied character for character. Do this even for a place you would not otherwise have suggested — they asked for it. Translate where needed: a request may be in another language than the place's usual name. List these first. Leave "request" out entirely for areas you are proposing yourself.`;

  return `A group is staying in ${args.base.name} (${args.base.lat}, ${args.base.lng}) and will take day trips of up to about ${args.radiusKm} km as the crow flies — roughly ${Math.round(args.radiusKm / 40)} to ${Math.round(args.radiusKm / 25)} hours' driving on regional roads.

Their interests: ${interests}.${requestBlock}

Name the towns or areas genuinely worth a day out from ${args.base.name}, within that range. Favour places with several things to do, so a whole day works there. Exclude anywhere that realistically needs an overnight stay.

Output ONLY a JSON object, no prose, exactly:
{"areas":[{"name":"<town or area>","lat":<number>,"lng":<number>,"why":"<one line>","request":"<member's exact wording, only if they asked for this place>"}]}

Give at most ${MAX_AREAS} areas, requested ones first and then nearest first. Do not include ${args.base.name} itself — it is already covered. Coordinates must be the real centre of each place.`;
}

/** Returns the model's areas, or null when the output cannot be used. */
export function parseAreas(text: string): Area[] | null {
  let raw: unknown;
  try {
    raw = extractJson(text);
  } catch {
    return null;
  }
  const parsed = areaListSchema.safeParse(raw);
  if (!parsed.success) return null;
  return parsed.data.areas.slice(0, MAX_AREAS);
}

/**
 * Asks the model where a day trip is worth taking, then keeps only the areas
 * that really are within range.
 *
 * The model proposes *where to look*; venues still come from Google, so a
 * hallucinated area simply returns no results. A failure here degrades the trip
 * to base-only planning rather than breaking generation.
 */
export async function proposeAreas(args: {
  base: { name: string; lat: number; lng: number };
  radiusKm: number;
  interests: string[];
  callers: Callers;
  /** Trip length, so a short trip is not offered more places than it has days. */
  dayCount?: number;
  /** Member suggestions, verbatim, so a town the group asked for becomes a day trip. */
  requests?: string[];
}): Promise<Area[]> {
  const base: Area = { name: args.base.name, lat: args.base.lat, lng: args.base.lng, why: "" };

  let proposed: Area[] | null = null;
  try {
    const { text } = await callWithFallback(buildAreaPrompt(args), args.callers);
    proposed = parseAreas(text);
  } catch {
    proposed = null;
  }
  if (!proposed) return [base];

  // A request is only honoured if it echoes something a member actually wrote.
  // Otherwise the model could mark every area as requested and take the whole
  // budget, which is exactly the priority this field grants.
  const asked = new Map(
    [...new Set(args.requests ?? [])].map((request) => [request.trim().toLowerCase(), request]),
  );
  const withinRange = proposed
    .filter(
      (a) =>
        a.name.toLowerCase() !== base.name.toLowerCase() &&
        haversineKm(base, a) <= args.radiusKm,
    )
    .map((a) => {
      const matched = a.request === undefined ? undefined : asked.get(a.request.trim().toLowerCase());
      return matched === undefined ? { ...a, request: undefined } : { ...a, request: matched };
    });

  // The budget caps how many areas the *model* may add; it does not overrule the
  // group. Every place they asked for and that is actually reachable is kept,
  // then the budget is filled out with the model's own picks, nearest first.
  //
  // Trimming a requested town instead had a worse second effect than losing the
  // day trip: the caller falls back to searching that request as a venue near
  // the base, which is what put a massage parlour and a wedding DJ in the pool
  // for a group that asked for Saint-Tropez. An extra area costs only Places
  // lookups — unassigned areas contribute nothing to the planner's prompt.
  const requested = withinRange.filter((a) => a.request !== undefined);
  const rest = withinRange.filter((a) => a.request === undefined);
  const budget = args.dayCount === undefined ? MAX_AREAS : areaBudget(args.dayCount);
  const filler = rest.slice(0, Math.max(0, budget - requested.length));
  return [base, ...requested, ...filler];
}
