/**
 * Classifying a venue as sheltered or not.
 *
 * This is the only judgement in weather adaptation that a model makes, and it is
 * deliberately the smallest one available: a single venue, a closed vocabulary,
 * no context beyond a name and a category. The cheap model handles that
 * reliably, where "rewrite this itinerary around the forecast" would not.
 *
 * The answer is stored, so it is asked once per venue for the life of a trip
 * rather than once per request, and a human can read down the list and fix it.
 */

import { callWithFallback, type Callers } from "./llm";

export const EXPOSURES = ["indoor", "outdoor", "covered"] as const;
export type Exposure = (typeof EXPOSURES)[number];

export type VenueToClassify = { id: string; name: string; category: string };

/** Small enough that one bad line costs little, large enough to be worth a call. */
export const EXPOSURE_BATCH_SIZE = 25;

/**
 * A line-per-venue format rather than JSON.
 *
 * A weak model producing slightly malformed JSON loses the whole batch; the same
 * model producing one bad line out of twenty-five loses one venue. The parser
 * takes what it can read and ignores the rest, so the failure mode is a smaller
 * answer rather than no answer.
 */
export function buildExposurePrompt(venues: VenueToClassify[]): string {
  const list = venues.map((v, i) => `${i + 1}. ${v.name} (${v.category})`).join("\n");
  return `For each place below, say whether visiting it puts you under a roof.

Answer with one line per place, exactly in the form:
NUMBER|indoor
NUMBER|outdoor
NUMBER|covered

Use:
- indoor: fully enclosed (museum, gallery, restaurant, shop, aquarium)
- outdoor: open to the sky (beach, park, viewpoint, trail, square, open market)
- covered: roofed but open-sided (covered market, arcade, roofed terrace)

No other words, no blank lines, one line per place.

${list}`;
}

/**
 * Read back whatever the model got right.
 *
 * Anything unparseable, out of range, or not one of the three words is dropped
 * rather than guessed at. A venue that does not come back stays unclassified,
 * and the scan skips unclassified venues — so a bad response narrows what the
 * feature can do instead of making it wrong.
 */
export function parseExposureResponse(
  text: string,
  venues: VenueToClassify[],
): Map<string, Exposure> {
  const result = new Map<string, Exposure>();
  for (const rawLine of text.split("\n")) {
    const match = /^\s*(\d+)\s*\|\s*([a-z]+)\s*$/i.exec(rawLine.trim());
    if (!match) continue;
    const index = Number(match[1]) - 1;
    const value = match[2].toLowerCase() as Exposure;
    if (index < 0 || index >= venues.length) continue;
    if (!EXPOSURES.includes(value)) continue;
    // First answer wins: a model that repeats itself should not overwrite a
    // line it already got right with a later contradiction.
    if (!result.has(venues[index].id)) result.set(venues[index].id, value);
  }
  return result;
}

/** Classify every venue given, in batches, keeping whatever comes back clean. */
export async function classifyExposure(
  callers: Callers,
  venues: VenueToClassify[],
): Promise<Map<string, Exposure>> {
  const classified = new Map<string, Exposure>();
  for (let start = 0; start < venues.length; start += EXPOSURE_BATCH_SIZE) {
    const batch = venues.slice(start, start + EXPOSURE_BATCH_SIZE);
    try {
      const { text } = await callWithFallback(buildExposurePrompt(batch), callers);
      for (const [id, exposure] of parseExposureResponse(text, batch)) {
        classified.set(id, exposure);
      }
    } catch {
      // One failed batch should not lose the batches that worked. The venues in
      // it stay unclassified and are picked up next run.
    }
  }
  return classified;
}
