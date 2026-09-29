/**
 * Hero photography for a trip, taken from the destination's own Google Place.
 *
 * The API key must never reach the browser, and a link-preview crawler arrives
 * without any credentials, so the app fetches the reference here and proxies the
 * image itself (see app/api/trips/[slug]/photo).
 */

const PLACES_BASE = "https://places.googleapis.com/v1";

/**
 * The first photo Google holds for a place, or null when there is none.
 *
 * Never throws: a missing photo degrades the card, it does not fail the trip.
 */
export async function fetchPlacePhotoRef(
  placeId: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  try {
    const res = await fetchImpl(`${PLACES_BASE}/places/${placeId}?fields=photos`, {
      headers: { "X-Goog-Api-Key": apiKey },
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { photos?: { name?: string }[] };
    return data.photos?.[0]?.name ?? null;
  } catch {
    return null;
  }
}

/** Where the actual image bytes live. Server-side only — it carries the key. */
export function photoMediaUrl(photoRef: string, apiKey: string, maxWidthPx: number): string {
  return `${PLACES_BASE}/${photoRef}/media?maxWidthPx=${maxWidthPx}&key=${apiKey}`;
}
