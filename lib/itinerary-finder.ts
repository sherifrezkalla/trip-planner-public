/**
 * Deterministic itinerary lookup for the trip concierge.
 *
 * A question like "where is the gym?" is answered from the plan itself, not
 * from a fresh Google search: the itinerary already knows the venue, the day,
 * the block, and the Maps link. This module is that deterministic first hop.
 * It is deliberately pure — no database, no fetches — so the matching rules
 * can be tested exhaustively and the route stays a thin adapter.
 *
 * The external place search still runs, but only when nothing in the
 * itinerary matches the question.
 */

export type ItineraryMatchStatus = "planned" | "done" | "skipped";

/**
 * One itinerary occurrence as the concierge route loads it. `candidateKey` is
 * the stored venue-candidate identity: two occurrences sharing it are the same
 * venue booked twice, not two places that happen to share a name.
 */
export type ItineraryLookupItem = {
  itemId: string;
  candidateKey: string;
  dayIndex: number;
  date: string;
  block: string;
  status: ItineraryMatchStatus;
  name: string;
  area: string;
  mapsUrl: string;
  categories: string[];
};

export type ItineraryOccurrence = {
  dayIndex: number;
  date: string;
  block: string;
  status: ItineraryMatchStatus;
};

export type ItineraryMatch = {
  name: string;
  categoryLabel: string;
  area: string;
  mapsUrl: string;
  occurrences: ItineraryOccurrence[];
};

export type ItineraryLookupResult = {
  matches: ItineraryMatch[];
  /** The words that drove the match, surfaced so the UI can say why. */
  matchedOn: string[];
};

/** Matches stop at this many venue groups; more would read as noise. */
const MATCH_GROUP_LIMIT = 3;

/**
 * Boundaries of the question that say "find me ideas" rather than "find the
 * stop we planned". A query that is only such a word ("restaurant?" while
 * standing in a square asking what's around) goes to external search even if
 * the plan has restaurants; "where is our restaurant?" still resolves to the
 * plan because the locator frame wins.
 */
const GENERIC_ONLY_TERMS = new Set([
  "boat", "tour", "trip", "excursion", "activity", "restaurant",
  "bateau", "bateaux", "croisiere",
  "boot", "boote", "bootstour", "bootstouren", "bootsfahrt", "bootsfahrten",
  "bar", "cafe", "coffee", "shop", "shopping",
  "market", "supermarket", "pharmacy", "hospital", "atm", "hotel",
]);

/**
 * Generic categories become itinerary lookups only when the original question
 * identifies the group's stop. This check deliberately runs on normalized raw
 * text before lookupTokens removes question words and possessives.
 */
const LOCATOR_FRAME_PATTERNS = [
  /\b(?:where|when)\b.*\b(?:our|ours)\b/,
  /\b(?:ou|quand)\b.*\b(?:notre|nos)\b/,
  /\b(?:wo|wann)\b.*\b(?:unser(?:e|er|en)?)\b/,
];

function hasLocatorFrame(value: string): boolean {
  const normalized = normalizeLookupText(value);
  return LOCATOR_FRAME_PATTERNS.some((pattern) => pattern.test(normalized));
}

/**
 * Stored categories are a small fixed vocabulary (the INTEREST keys plus
 * "restaurant" and "concierge"). Each maps to a short list of the words a
 * person actually types, in English plus the French/German equivalents the
 * group mixes in. The lists stay deliberately short: a synonym that fires on
 * everything is a false positive factory, and the question can always fall
 * through to the external search when nothing here fits.
 */
const CATEGORY_SYNONYMS: Record<string, string[]> = {
  active: [
    "gym", "gyms", "fitness", "workout", "sport", "sports", "climbing",
    "hike", "hikes", "hiking", "tennis", "padel", "golf",
    "sportplatz", "sporthalle", "fitnessstudio", "wandern",
    "salle", "escalade", "randonnee",
  ],
  water: [
    "beach", "beaches", "swim", "swimming", "pool", "pools", "sea", "ocean",
    "boat", "boats", "kayak", "kayaking", "snorkel", "snorkelling",
    "snorkeling", "surf", "surfing", "diving", "paddle",
    "strand", "meer", "schwimmen", "boot", "boote", "bootstour", "bootstouren",
    "bootsfahrt", "bootsfahrten", "tauchen",
    "plage", "mer", "nager", "bateau", "bateaux", "croisiere", "plongee", "piscine",
  ],
  food: [
    "food", "market", "markets", "streetfood", "deli", "bakery", "bakeries",
    "hallen", "wochenmarkt", "markt", "marche", "marches",
  ],
  restaurant: [
    "restaurant", "restaurants", "dinner", "dinners", "lunch", "lunches",
    "eat", "eating", "essen", "abendessen", "mittagessen",
  ],
  history: [
    "museum", "museums", "castle", "castles", "cathedral", "cathedrals",
    "church", "churches", "palace", "palaces", "fortress", "ruins", "abbey",
    "monastery", "amphitheatre", "amphitheater",
    "schloss", "burg", "kathedrale", "kirche", "kirchen", "kloster", "ruine", "ruinen",
    "musee", "musees", "chateau", "chateaux", "cathedrale", "eglise", "eglises", "palais",
  ],
  nature: [
    "park", "parks", "garden", "gardens", "forest", "waterfall", "waterfalls",
    "canyon", "lake", "lakes", "mountain", "mountains", "trail", "trails",
    "view", "viewpoint", "viewpoints", "cliff", "cliffs",
    "wald", "see", "seen", "wasserfall", "berg", "berge", "aussicht",
    "parc", "parcs", "jardin", "jardins", "foret", "lac", "lacs", "montagne", "montagnes", "cascade",
  ],
  nightlife: [
    "bar", "bars", "club", "clubs", "clubbing", "nightclub", "nightclubs",
    "pub", "pubs", "karaoke", "cocktail", "cocktails",
    "kneipe", "disko", "discotheque", "soiree",
  ],
  shopping: [
    "mall", "malls", "boutique", "boutiques", "souvenir", "souvenirs",
    "outlet", "einkaufen", "einkaufszentrum", "laden",
  ],
  art: [
    "art", "arts", "gallery", "galleries", "exhibition", "exhibitions",
    "galerie", "galerien", "ausstellung",
  ],
};

/**
 * Words that carry no finding power on their own. Without this, "where",
 * "the", "again" and friends would each be a candidate name token, and any
 * venue named "The Old Mill" would answer "where is the museum?".
 */
const STOP_WORDS = new Set([
  // English question frame
  "where", "what", "whats", "which", "when", "how", "is", "are", "was", "were",
  "the", "a", "an", "our", "ours", "my", "we", "do", "does", "did", "can",
  "could", "there", "any", "some", "find", "show", "tell", "get", "go",
  "going", "on", "in", "at", "to", "for", "of", "and", "or", "with", "near",
  "nearby", "around", "again", "it", "this", "that", "us", "me",
  // French question frame
  "ou", "est", "sont", "le", "la", "les", "un", "une", "des", "du", "de",
  "notre", "nos", "on", "quoi", "quel", "quelle", "quels", "quelles", "quand",
  "en", "au", "aux", "trouve", "trouver", "proximite", "alentour", "alentours",
  // German question frame
  "wo", "ist", "sind", "der", "die", "das", "ein", "eine", "einem", "einen",
  "unser", "unsere", "unserer", "unseren", "wir", "nochmal", "noch",
  "mal", "gibt", "es", "wann", "finde", "finden", "nahe", "umgebung",
]);

const GERMAN_ESZETT = /\u00df/g;

/**
 * Lowercases and folds accents so "Musée" and "musee" meet in the middle, and
 * folds ß to ss. This is the only transformation either side of a comparison
 * gets — storage keeps its proper spelling.
 */
export function normalizeLookupText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(GERMAN_ESZETT, "ss")
    .toLowerCase()
    .trim();
}

function singularize(token: string): string {
  if (token.length <= 3) return token;
  if (/(ses|xes|zes|ches|shes)$/.test(token)) return token.slice(0, -2);
  if (/ies$/.test(token) && token.length > 4) return `${token.slice(0, -3)}y`;
  if (/[^s]s$/.test(token)) return token.slice(0, -1);
  return token;
}

/** Normalized singular token stream of free text, stop words kept out. */
export function lookupTokens(value: string): string[] {
  const normalized = normalizeLookupText(value);
  return normalized
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map(singularize)
    .filter((token) => token.length > 1 && !STOP_WORDS.has(token));
}

const SYNONYM_BY_TOKEN = new Map<string, string>();
for (const [label, synonyms] of Object.entries(CATEGORY_SYNONYMS)) {
  for (const synonym of synonyms) {
    // First label wins for a shared token ("bar" belongs to both nightlife and
    // restaurant-adjacent speech; nightlife is the safer read of the word).
    if (!SYNONYM_BY_TOKEN.has(synonym)) SYNONYM_BY_TOKEN.set(synonym, label);
  }
}

/** Category labels the query points at. Tokens arrive singularized, and the
 * synonym lists are singular too, so a plain lookup covers "museums" and
 * "Museum" alike without a per-synonym rescan. */
function queryCategoryLabels(tokens: string[]): Set<string> {
  const labels = new Set<string>();
  for (const token of tokens) {
    const direct = SYNONYM_BY_TOKEN.get(token);
    if (direct) labels.add(direct);
  }
  return labels;
}

function venueCategoryLabels(item: ItineraryLookupItem): Set<string> {
  return new Set(
    (item.categories.length > 0 ? item.categories : [])
      .map((category) => normalizeLookupText(category)),
  );
}

function venueNameTokens(item: ItineraryLookupItem): Set<string> {
  return new Set(lookupTokens(item.name));
}

function labelFor(matched: Set<string>, available: Set<string>): string {
  for (const label of available) {
    if (matched.has(label)) return label;
  }
  return [...available][0] ?? "";
}

function displayArea(area: string, destinationName: string): string {
  return area.trim() || destinationName.trim();
}

/**
 * Answers "where/when is X?" from the itinerary alone. Returns an empty match
 * list when the plan says nothing — the caller then falls through to external
 * place search. That empty answer is the contract: never invent a location,
 * never guess at a stop the plan does not record (including a skipped one —
 * it is labelled, not hidden).
 */
export function findItineraryMatches(
  query: string,
  items: ItineraryLookupItem[],
  destinationName: string,
): ItineraryLookupResult {
  const tokens = lookupTokens(query);
  const matchedOn: string[] = [];
  if (tokens.length === 0) return { matches: [], matchedOn };

  // A pure ideas question ("boat trips?", "find a restaurant nearby") is a
  // search brief, not a locator. Skip the itinerary hop entirely.
  if (!hasLocatorFrame(query) && tokens.every((token) => GENERIC_ONLY_TERMS.has(token))) {
    return { matches: [], matchedOn };
  }

  const categoryLabels = queryCategoryLabels(tokens);
  const matchedGroups: { key: string; item: ItineraryLookupItem; group: ItineraryMatch }[] = [];
  const groupByKey = new Map<string, ItineraryMatch>();
  const matchedCategoryLabels = new Set<string>();

  for (const item of items) {
    const nameTokens = venueNameTokens(item);
    const hitToken = tokens.find((token) => nameTokens.has(token));
    const itemCategories = venueCategoryLabels(item);
    const hitCategory = [...categoryLabels].find((label) => itemCategories.has(label));
    if (!hitToken && !hitCategory) continue;

    if (hitToken) matchedOn.push(hitToken);
    if (hitCategory) {
      matchedCategoryLabels.add(hitCategory);
      matchedOn.push(`category:${hitCategory}`);
    }

    const key = item.candidateKey || item.itemId;
    let group = groupByKey.get(key);
    if (!group) {
      group = {
        name: item.name,
        categoryLabel: [...itemCategories][0] ?? "",
        area: displayArea(item.area, destinationName),
        mapsUrl: item.mapsUrl,
        occurrences: [],
      };
      groupByKey.set(key, group);
      matchedGroups.push({ key, item, group });
    }
    group.occurrences.push({
      dayIndex: item.dayIndex,
      date: item.date,
      block: item.block,
      status: item.status,
    });
  }

  for (const { group, item } of matchedGroups) {
    group.categoryLabel = labelFor(matchedCategoryLabels, venueCategoryLabels(item));
    group.occurrences.sort(
      (a, b) => a.dayIndex - b.dayIndex || a.block.localeCompare(b.block),
    );
  }

  return {
    matches: matchedGroups.slice(0, MATCH_GROUP_LIMIT).map(({ group }) => group),
    matchedOn: [...new Set(matchedOn)],
  };
}

const WEEKDAY_SHORT = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTH_SHORT = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

/**
 * The calendar date of a trip day. "2026-08-07" + 2 → "2026-08-09". Parsed as
 * UTC so the answer does not depend on where the server happens to run.
 */
export function tripDateForDayIndex(startDate: string, dayIndex: number): string {
  const date = new Date(`${startDate}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return "";
  date.setUTCDate(date.getUTCDate() + dayIndex);
  return date.toISOString().slice(0, 10);
}

/** "Mon, 25 Aug" — en-GB by hand so server locale cannot move the words. */
export function formatOccurrenceDate(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return "";
  return `${WEEKDAY_SHORT[parsed.getUTCDay()]}, ${parsed.getUTCDate()} ${MONTH_SHORT[parsed.getUTCMonth()]}`;
}
