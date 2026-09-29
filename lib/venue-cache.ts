import type { PlaceCandidate } from "./places";

/**
 * Keeping the cached venue pool in step with who has joined.
 *
 * Venues are fetched once and reused, which makes regeneration fast and free.
 * But the pool is built from the categories the travellers wanted *at that
 * moment* — so someone joining later with a new interest has nothing to draw
 * from, and regenerating would silently ignore them.
 */

/** Categories the travellers now want that the cached venues do not cover. */
export function missingCategories(required: string[], cached: string[]): string[] {
  const have = new Set(cached);
  return [...new Set(required)].filter((category) => !have.has(category));
}

export type MergedCandidate = { candidate: PlaceCandidate; categories: string[] };

/**
 * Deduplicate Google results without throwing away why each venue was found.
 * Metadata comes from the first result; category labels are accumulated in
 * stable search order and persisted separately by the caller.
 */
export function mergeCandidateCategories(candidates: PlaceCandidate[]): MergedCandidate[] {
  const byPlace = new Map<string, MergedCandidate>();
  for (const candidate of candidates) {
    const existing = byPlace.get(candidate.placeId);
    if (!existing) {
      byPlace.set(candidate.placeId, {
        candidate: { ...candidate, categories: [...candidate.categories] },
        categories: [...new Set(candidate.categories)],
      });
      continue;
    }
    for (const category of candidate.categories) {
      if (!existing.categories.includes(category)) existing.categories.push(category);
    }
    existing.candidate.categories = [...existing.categories];
  }
  return [...byPlace.values()];
}
