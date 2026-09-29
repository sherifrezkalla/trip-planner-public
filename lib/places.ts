export type OpeningPoint = { day: number; hour: number; minute: number };
export type OpeningPeriod = { open: OpeningPoint; close?: OpeningPoint };

export type PlaceCandidate = {
  placeId: string;
  name: string;
  category: string;
  /** Every search category this Google place satisfied. */
  categories: string[];
  rating: number | null;
  reviewCount: number;
  priceLevel: string | null;
  openingHours: string[];
  openingPeriods: OpeningPeriod[];
  lat: number;
  lng: number;
  mapsUrl: string;
  /** Town or area this venue belongs to; empty means the trip's base. */
  area?: string;
  /** Straight-line km from the trip's base. */
  distanceKm?: number;
};

/**
 * A `venue_candidates` row as the routes select it.
 *
 * Loose on purpose: the Supabase client returns rows untyped, and narrowing here
 * would only move the casts rather than remove them.
 */
export type VenueCandidateRow = {
  id: string;
  name: string;
  category: string;
  rating: number | null;
  review_count: number;
  price_level: string | null;
  opening_hours: unknown;
  opening_periods: unknown;
  lat: number;
  lng: number;
  maps_url: string;
  area?: string | null;
  distance_km?: number | null;
  venue_candidate_categories?: { category: string }[] | null;
};

/**
 * One stored venue as the planner sees it.
 *
 * Generation and swapping each built this by hand, identically, including the
 * fallback that treats the single `category` column as a one-item list when the
 * join table has nothing — the subtle part, and the part most likely to be
 * corrected in one place only. A venue that arranged differently depending on
 * which route loaded it would be a hard bug to see and a harder one to believe.
 */
export function venueRowToCandidate(row: VenueCandidateRow): PlaceCandidate {
  const categories = (row.venue_candidate_categories ?? []).map((entry) => entry.category);
  return {
    placeId: row.id,
    name: row.name,
    category: row.category,
    categories: categories.length > 0 ? categories : [row.category],
    rating: row.rating,
    reviewCount: row.review_count,
    priceLevel: row.price_level,
    openingHours: (row.opening_hours ?? []) as string[],
    openingPeriods: (row.opening_periods ?? []) as OpeningPeriod[],
    lat: row.lat,
    lng: row.lng,
    mapsUrl: row.maps_url,
    area: row.area ?? "",
    distanceKm: row.distance_km ?? 0,
  };
}

const INTEREST_QUERIES: Record<string, string> = {
  food: "famous food market or local specialty restaurant",
  history: "historical landmark or museum",
  nature: "park or nature attraction",
  nightlife: "popular bar or nightlife venue",
  shopping: "shopping street or market",
  art: "art gallery or cultural site",
  water: "beach or waterfront attraction",
  active: "outdoor activity or sports venue",
};

export function buildCategoryQueries(
  interests: string[],
  dietaryList: string[],
): { category: string; query: string }[] {
  const unique = [...new Set(interests)].filter((i) => INTEREST_QUERIES[i]);
  const queries = unique.map((i) => ({ category: i, query: INTEREST_QUERIES[i] }));
  const veg = dietaryList.some((d) => d === "vegetarian" || d === "vegan");
  queries.push({
    category: "restaurant",
    query: veg ? "highly rated vegetarian friendly restaurant" : "highly rated restaurant for dinner",
  });
  // Dinner is the only meal the plan books. Breakfast is wherever the group is
  // staying and lunch is wherever they happen to be — neither needs planning,
  // and searching for them only widened the pool the planner had to read.
  return queries;
}

type PlacesApiPlace = {
  id: string;
  displayName?: { text?: string };
  rating?: number;
  userRatingCount?: number;
  priceLevel?: string;
  location?: { latitude?: number; longitude?: number };
  googleMapsUri?: string;
  regularOpeningHours?: {
    weekdayDescriptions?: string[];
    periods?: {
      open?: Partial<OpeningPoint>;
      close?: Partial<OpeningPoint>;
    }[];
  };
  businessStatus?: string;
  types?: string[];
};

/** Provider rows lacking either required public navigation field are unusable. */
function hasPublicCoordinatesAndMapsUrl(place: PlacesApiPlace): place is PlacesApiPlace & {
  location: { latitude: number; longitude: number };
  googleMapsUri: string;
} {
  return Number.isFinite(place.location?.latitude)
    && Number.isFinite(place.location?.longitude)
    && typeof place.googleMapsUri === "string"
    && place.googleMapsUri.trim().length > 0;
}

const FOOD_PLACE_TYPES = new Set([
  "bakery", "bar", "cafe", "coffee_shop", "food_court", "meal_delivery",
  "meal_takeaway", "restaurant",
]);

/** Preserve the search label, while recognizing suggested restaurants as meal venues. */
export function placeCategories(searchCategory: string, types: string[] = []): string[] {
  const categories = new Set([searchCategory]);
  if (types.some((type) => FOOD_PLACE_TYPES.has(type) || type.endsWith("_restaurant"))) {
    categories.add("restaurant");
  }
  return [...categories];
}

/**
 * Google rejects a locationBias circle wider than 50 km outright, with a 400
 * that fails the whole generation.
 *
 * A trip's explore radius can be 60 or 100 km, which is a statement about how
 * far the group will travel, not about one search. Reach comes from searching
 * each proposed area separately; this circle only biases one of those searches,
 * and a bias is a preference rather than a boundary — Google may still return
 * something further out. So capping it costs nothing and is enforced here,
 * against the API that imposes it, rather than trusting three call sites to
 * remember.
 */
const MAX_BIAS_RADIUS_METRES = 50_000;

export function biasRadiusMetres(radiusKm?: number): number {
  return Math.min((radiusKm ?? 15) * 1000, MAX_BIAS_RADIUS_METRES);
}

export async function searchPlaces(args: {
  query: string;
  category: string;
  lat: number;
  lng: number;
  apiKey: string;
  /** How far around the centre to bias results. Defaults to a city radius. */
  radiusKm?: number;
  /** Label applied to every venue found by this search. */
  area?: string;
  fetchImpl?: typeof fetch;
}): Promise<PlaceCandidate[]> {
  const f = args.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await f("https://places.googleapis.com/v1/places:searchText", {
      method: "POST",
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": args.apiKey,
        "X-Goog-FieldMask": [
          "places.id",
          "places.displayName",
          "places.rating",
          "places.userRatingCount",
          "places.priceLevel",
          "places.location",
          "places.googleMapsUri",
          "places.regularOpeningHours.weekdayDescriptions",
          "places.regularOpeningHours.periods",
          "places.businessStatus",
          "places.types",
        ].join(","),
      },
      body: JSON.stringify({
        textQuery: args.query,
        pageSize: 20,
        languageCode: "en",
        locationBias: {
          circle: {
            center: { latitude: args.lat, longitude: args.lng },
            radius: biasRadiusMetres(args.radiusKm),
          },
        },
      }),
    });
    if (!res.ok) throw new Error(`Places API ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { places?: PlacesApiPlace[] };
    return (data.places ?? [])
      .filter((p) => p.businessStatus === "OPERATIONAL" || p.businessStatus === undefined)
      .filter(hasPublicCoordinatesAndMapsUrl)
      .map(
        (p): PlaceCandidate => ({
          placeId: p.id,
          name: p.displayName?.text ?? "Unknown",
          category: args.category,
          categories: placeCategories(args.category, p.types),
          rating: p.rating ?? null,
          reviewCount: p.userRatingCount ?? 0,
          priceLevel: p.priceLevel ?? null,
          openingHours: p.regularOpeningHours?.weekdayDescriptions ?? [],
          openingPeriods: (p.regularOpeningHours?.periods ?? [])
            .filter((period) => period.open !== undefined)
            .map((period) => ({
              open: {
                day: period.open?.day ?? 0,
                hour: period.open?.hour ?? 0,
                minute: period.open?.minute ?? 0,
              },
              ...(period.close ? {
                close: {
                  day: period.close.day ?? 0,
                  hour: period.close.hour ?? 0,
                  minute: period.close.minute ?? 0,
                },
              } : {}),
            })),
          lat: p.location.latitude,
          lng: p.location.longitude,
          mapsUrl: p.googleMapsUri.trim(),
          area: args.area ?? "",
        }),
      );
  } finally {
    clearTimeout(timeout);
  }
}

export function filterByRating(candidates: PlaceCandidate[]): PlaceCandidate[] {
  const strong = candidates.filter((c) => (c.rating ?? 0) >= 4.0);
  if (strong.length >= 3) return strong;
  return candidates.filter((c) => (c.rating ?? 0) >= 3.5);
}
