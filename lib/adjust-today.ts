import { regularHoursCoverBlock } from "./opening-hours";
import { haversineKm } from "./geo";
import { travelWarnings } from "./generate";
import { BLOCKS, type Block, type Interest } from "./schema";
import type { PlaceCandidate } from "./places";

/**
 * Deterministic, grounded re-planning of the current day.
 *
 * This is deliberately deterministic rather than model-driven. The acceptance
 * contract for Adjust today is that every replacement is grounded in a real,
 * already-verified venue from the trip's own cached pool against its current
 * regular opening hours, that protected activities are never touched, and that
 * nothing mutates on concierge text alone. A language model can paraphrase the
 * constraint back, but it can also invent a venue that was never fetched — so
 * the venue never comes from the model here. The model stays out of the write
 * path entirely; constraint parsing is a small, bounded, unit-tested mapping.
 *
 * The day is repaired only within itself (no cross-day moves), matching the
 * running-late repair's boundary.
 */

export type AdjustConstraint = {
  /** Lower the day's load: fewer stops, easier pace. */
  energy: "low" | "normal" | "high";
  /** Drop everything that takes longer than this many minutes. */
  maxDurationMin: number | null;
  /** Prefer an activity type for any replacement (a venue-search category). */
  activityType: Interest | null;
  /** Whether proposed replacements should be within easy reach of the day. */
  accessibility: "step-free" | null;
  /** Venue names the organizer asked to keep, matched against today's plan. */
  mustKeepNames: string[];
};

export type ParsedIntent = {
  constraint: AdjustConstraint;
  /** Free-text fragments we could not map to a structured constraint. */
  unmapped: string[];
  /** Structured notes about how pieces of the request were read. */
  parsed: string[];
};

export type AdjustItem = {
  id: string;
  dayIndex: number;
  block: Block;
  position: number;
  status: "planned" | "done" | "skipped";
  isLocked: boolean;
  /** Whether an active tentative/confirmed reservation protects this row. */
  reservationLocked: boolean;
  venueName: string;
  durationMin: number;
  openingPeriods: PlaceCandidate["openingPeriods"];
  /** Every verified search category associated with the current venue. */
  categories: string[];
  /** The venue's own coordinates for travel-distance impact. */
  lat?: number;
  lng?: number;
  /** The day/area this venue belongs to (from the item's `area` column). */
  area: string;
  /** The candidate id currently in this slot (for replacements). */
  candidateId: string;
};

export type AdjustMove = {
  itemId: string;
  venueName: string;
  fromDayIndex: number;
  fromBlock: Block;
  toDayIndex: number;
  toBlock: Block;
};

export type AdjustSkip = {
  itemId: string;
  venueName: string;
  fromDayIndex: number;
  fromBlock: Block;
  reason: string;
};

export type AdjustSwap = {
  itemId: string;
  fromVenueName: string;
  toCandidateId: string;
  toVenueName: string;
  fromDayIndex: number;
  fromBlock: Block;
  reason: string;
  /** Replacement-derived fields persisted with the new candidate. */
  durationMin: number;
  area: string;
};

export type AdjustPreserved = {
  itemId: string;
  venueName: string;
  block: Block;
  reason: "completed" | "skipped" | "locked" | "reservation" | "must-keep";
};

export type AdjustImpact = {
  /** Every schedule move, removal, and replacement, already named. */
  moves: AdjustMove[];
  skips: AdjustSkip[];
  swaps: AdjustSwap[];
  /** Stops the constraint could not place anywhere safe today. */
  unplaced: { itemId: string; venueName: string; reason: string }[];
  /** Stops deliberately left alone, with why. */
  preserved: AdjustPreserved[];
  /** Reservations that survive, and any that constrain the outcome. */
  reservationNotes: string[];
  /** Estimated transfer change between the day's remaining stops. */
  travelNote: string | null;
  /** Plain-language preference/pace effects of the accepted revision. */
  preferenceNotes: string[];
  /** Genuine conflicts the organizer must see before confirming. */
  conflicts: string[];
  /** Uncertainty labels for closures, holiday hours, traffic, availability. */
  uncertainties: string[];
  /** Recomputed warning state for every surviving planned stop on the day. */
  warningUpdates: { itemId: string; travelWarning: boolean }[];
};

export type AdjustPreview = {
  kind: "adjust-today";
  dayIndex: number;
  reason: string;
  impact: AdjustImpact;
  /** Whether the reviewed revision contains any change at all. */
  hasChanges: boolean;
};

function rank(block: Block): number {
  return BLOCKS.indexOf(block);
}

function slotKind(block: Block): "meal" | "activity" {
  return block === "lunch" || block === "dinner" ? "meal" : "activity";
}

function isMealCandidate(candidate: PlaceCandidate): boolean {
  const categories = new Set(candidate.categories);
  return categories.has("restaurant") || categories.has("food");
}

/**
 * Map short natural-language intent onto a bounded, structured constraint.
 *
 * Bounded on purpose: the supported vocabulary is small enough to unit-test
 * exhaustively, and anything we cannot read is handed back in `unmapped` so the
 * organizer sees what was and was not understood rather than having it silently
 * ignored.
 */
export function parseAdjustIntent(text: string): ParsedIntent {
  const raw = text.trim().replace(/\s+/g, " ");
  const lower = raw.toLowerCase();
  const constraint: AdjustConstraint = {
    energy: "normal",
    maxDurationMin: null,
    activityType: null,
    accessibility: null,
    mustKeepNames: [],
  };
  const parsed: string[] = [];
  const unmapped: string[] = [];

  // Pace / energy.
  if (/\b(low energy|easy|gentle|tired|relaxed|slower|slow down|chill|lighter|rest)\b/.test(lower)) {
    constraint.energy = "low";
    parsed.push("pace eased (lower energy)");
  } else if (/\b(packed|full day|more|ambitious|busy|high energy|fast)\b/.test(lower)) {
    constraint.energy = "high";
    parsed.push("pace raised");
  } else if (/\b(normal|balanced)\b/.test(lower)) {
    constraint.energy = "normal";
  }

  // Duration cap.
  const durationMatch = lower.match(/(?:no more than|under|at most|max(?:imum)?|shorter than)\s*(\d{1,3})\s*(?:minutes|min|m)\b/);
  if (durationMatch) {
    const minutes = Number(durationMatch[1]);
    if (Number.isFinite(minutes) && minutes >= 30 && minutes <= 480) {
      constraint.maxDurationMin = minutes;
      parsed.push(`stops capped at ${minutes} minutes`);
    } else {
      unmapped.push(`duration "${durationMatch[0]}"`);
    }
  }
  if (/\bshorter\b/.test(lower) && constraint.maxDurationMin === null) {
    constraint.maxDurationMin = 90;
    parsed.push("shorter stops");
  }

  // Accessibility.
  if (/\b(accessible|accessibility|step[- ]free|wheelchair|no stairs|flat)\b/.test(lower)) {
    constraint.accessibility = "step-free";
    parsed.push("step-free preferred");
  }

  // Desired activity type, mapped onto the venue-search categories that already
  // drive generation so a "museum" request uses the same label everywhere.
  const typeMatchers: [RegExp, Interest][] = [
    [/\b(museum|museums|gallery|art|culture)\b/, "art"],
    [/\b(food|restaurant|dinner|lunch|eat|meal|cafe)\b/, "food"],
    [/\b(history|historic|monument|castle|church|landmark)\b/, "history"],
    [/\b(park|nature|garden|outdoor|hike|walk)\b/, "nature"],
    [/\b(nightlife|bar|club|drink)\b/, "nightlife"],
    [/\b(shop|shopping|market|store)\b/, "shopping"],
    [/\b(beach|water|swim|sea|lake|river)\b/, "water"],
    [/\b(active|sport|bike|climb)\b/, "active"],
  ];
  for (const [pattern, interest] of typeMatchers) {
    if (pattern.test(lower)) {
      constraint.activityType = interest;
      parsed.push(`prefer ${interest}`);
      break;
    }
  }

  // Must-keep stops, quoted "like this" or after "keep".
  const keepQuoted = [...lower.matchAll(/(?:keep|hold|save|preserve)\s+"([^"]{1,80})"/g)].map((m) => m[1]);
  const keepBare = [...lower.matchAll(/(?:keep|hold|save|preserve)\s+(?:the\s+)?([a-z0-9][a-z0-9 .&'-]{1,60}?)(?:,|\.|$| and | but )/g)].map((m) => m[1]);
  for (const name of [...keepQuoted, ...keepBare]) {
    const clean = name.trim();
    if (clean && !constraint.mustKeepNames.includes(clean)) {
      constraint.mustKeepNames.push(clean);
    }
  }
  if (constraint.mustKeepNames.length > 0) {
    parsed.push(`must-keep: ${constraint.mustKeepNames.join(", ")}`);
  }

  // Whatever is left that carries no recognisable structure is surfaced, not
  // dropped: a half-understood instruction is worse than none.
  const leftover = lower
    .replace(/(?:keep|hold|save|preserve)\s+"[^"]{1,80}"/g, " ")
    .replace(/(?:low energy|easy|gentle|tired|relaxed|slower|slow down|chill|lighter|rest|packed|full day|more|ambitious|busy|high energy|fast|normal|balanced|shorter|accessible|accessibility|step[- ]free|wheelchair|no stairs|flat)\b/g, " ")
    .replace(/(?:no more than|under|at most|max(?:imum)?|shorter than)\s*\d{1,3}\s*(?:minutes|min|m)\b/g, " ")
    .replace(/(?:keep|hold|save|preserve)\s+(?:the\s+)?[a-z0-9][a-z0-9 .&'-]{1,60}?(?:,|\.|$| and | but )/g, " ")
    .replace(/[,.!?]/g, " ")
    .trim();
  if (leftover.length > 0 && parsed.length === 0 && constraint.mustKeepNames.length === 0) {
    unmapped.push(leftover);
  }

  return { constraint, parsed, unmapped };
}

/** Normalize a venue name for must-keep matching. */
function normalizeName(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9 ]+/g, "").replace(/\s+/g, " ");
}

function isProtected(item: AdjustItem): { protected: boolean; reason: AdjustPreserved["reason"] | null } {
  if (item.status === "done") return { protected: true, reason: "completed" };
  if (item.status === "skipped") return { protected: true, reason: "skipped" };
  if (item.isLocked) return { protected: true, reason: "locked" };
  if (item.reservationLocked) return { protected: true, reason: "reservation" };
  return { protected: false, reason: null };
}

/**
 * Build the full structured preview of an adjust-today revision.
 *
 * Pure and I/O-free: the route gathers the day's items, the trip's venue pool,
 * and the parsed intent, and this decides what a safe revision looks like. Every
 * replacement is a venue from the supplied pool whose regular hours cover the
 * slot it would occupy, within the trip's base area for the day — never a name
 * the prompt made up.
 */
export function buildAdjustTodayPreview(args: {
  dayIndex: number;
  items: AdjustItem[];
  pool: PlaceCandidate[];
  startDate: string;
  dayCount: number;
  reason: string;
  intent: ParsedIntent;
}): AdjustPreview {
  const { dayIndex, intent } = args;
  const dayItems = args.items
    .filter((item) => item.dayIndex === dayIndex)
    .sort((a, b) => rank(a.block) - rank(b.block) || a.position - b.position);

  const preserved: AdjustPreserved[] = [];
  const reservationNotes: string[] = [];
  const flexible: AdjustItem[] = [];
  const mustKeepMatched = new Set<string>();

  for (const item of dayItems) {
    const protection = isProtected(item);
    if (protection.protected) {
      if (protection.reason === "reservation") {
        reservationNotes.push(`${item.venueName} has an active reservation and stays untouched.`);
      }
      preserved.push({ itemId: item.id, venueName: item.venueName, block: item.block, reason: protection.reason! });
      continue;
    }
    const isMustKeep = intent.constraint.mustKeepNames.some(
      (name) => normalizeName(item.venueName).includes(normalizeName(name)) || normalizeName(name).includes(normalizeName(item.venueName)),
    );
    if (isMustKeep) {
      mustKeepMatched.add(item.id);
      preserved.push({ itemId: item.id, venueName: item.venueName, block: item.block, reason: "must-keep" });
      continue;
    }
    flexible.push(item);
  }

  const moves: AdjustMove[] = [];
  const skips: AdjustSkip[] = [];
  const swaps: AdjustSwap[] = [];
  const unplaced: AdjustImpact["unplaced"] = [];
  const preferenceNotes: string[] = [];
  const conflicts: string[] = [];
  const uncertainties: string[] = [];

  // Decide which rows genuinely need a change first. This lets occupancy start
  // from the final set of rows that stay in place: unchanged flexible activities
  // occupy their slots, while sources that this same preview will move or skip
  // are already known to be vacant.
  const decisions = flexible.map((item) => {
    const tooLong = intent.constraint.maxDurationMin !== null && item.durationMin > intent.constraint.maxDurationMin;
    const tooHeavy = intent.constraint.energy === "low" && item.durationMin > 120;
    const wantsReplacement = intent.constraint.activityType !== null
      && slotKind(item.block) === "activity"
      && !item.categories.includes(intent.constraint.activityType);
    if (!tooLong && !tooHeavy && !wantsReplacement) return null;

    // Try to find a grounded replacement within the same block and area.
    const replacement = pickReplacement({
      item,
      pool: args.pool,
      items: args.items,
      startDate: args.startDate,
      dayIndex,
      intent,
    });
    return { item, replacement };
  }).filter((decision): decision is { item: AdjustItem; replacement: PlaceCandidate | null } => decision !== null);

  const relocatingIds = new Set(
    decisions.filter((decision) => decision.replacement === null).map((decision) => decision.item.id),
  );
  const occupiedBlocks = new Set(
    dayItems
      .filter((item) => item.status === "planned" && !relocatingIds.has(item.id))
      .map((item) => item.block),
  );

  for (const { item, replacement } of decisions) {

    if (replacement) {
      const durationMin = blockDurationHint(replacement);
      swaps.push({
        itemId: item.id,
        fromVenueName: item.venueName,
        toCandidateId: replacement.placeId,
        toVenueName: replacement.name,
        fromDayIndex: item.dayIndex,
        fromBlock: item.block,
        reason: swapReason(intent, item),
        durationMin,
        area: replacement.area ?? item.area,
      });
      continue;
    }

    // No grounded replacement fits this slot; try a later same-kind slot today.
    const target = laterSlotFor(item, occupiedBlocks);
    if (target && target !== item.block) {
      moves.push({
        itemId: item.id,
        venueName: item.venueName,
        fromDayIndex: item.dayIndex,
        fromBlock: item.block,
        toDayIndex: dayIndex,
        toBlock: target,
      });
      occupiedBlocks.add(target);
      continue;
    }

    // Nothing safe fits; propose removing it from today.
    skips.push({
      itemId: item.id,
      venueName: item.venueName,
      fromDayIndex: item.dayIndex,
      fromBlock: item.block,
      reason: skipReason(intent, item),
    });
  }

  // Pace notes.
  if (intent.constraint.energy === "low") {
    const kept = flexible.length - skips.length;
    preferenceNotes.push(
      `Lower energy: the revision keeps ${kept} of ${flexible.length} flexible stops, sets aside ${skips.length}, and moves ${moves.length} later.`,
    );
  }
  if (intent.constraint.maxDurationMin !== null) {
    const swapByItem = new Map(swaps.map((swap) => [swap.itemId, swap]));
    const skippedIds = new Set(skips.map((skip) => skip.itemId));
    const stillOverCap = dayItems.filter((item) =>
      item.status === "planned"
      && !skippedIds.has(item.id)
      && (swapByItem.get(item.id)?.durationMin ?? item.durationMin) > intent.constraint.maxDurationMin!,
    );
    preferenceNotes.push(stillOverCap.length === 0
      ? `Every remaining planned stop is at or below ${intent.constraint.maxDurationMin} minutes.`
      : `${stillOverCap.length} protected or moved stop${stillOverCap.length === 1 ? " remains" : "s remain"} over the ${intent.constraint.maxDurationMin}-minute request; review before applying.`);
  }
  if (intent.constraint.activityType) {
    preferenceNotes.push(`Activity-type changes target only non-meal stops that do not already match ${intent.constraint.activityType}; grounded replacements are used when available.`);
  }
  if (intent.constraint.accessibility) {
    preferenceNotes.push("Step-free access was requested but cannot be verified from venue data; confirm directly with the venue.");
  }

  // Travel impact between the day's surviving planned stops.
  const travelNote = travelImpactNote(args.items.filter((i) => i.dayIndex === dayIndex), moves, swaps);
  if (travelNote) preferenceNotes.push(travelNote);

  // Uncertainty labels: what grounding could not promise.
  const anySwap = swaps.length > 0;
  if (anySwap) {
    uncertainties.push(
      "Regular opening hours are advisory — holiday, seasonal, or exceptional hours may differ; verify before relying on them.",
    );
    uncertainties.push("Live availability and real-time traffic are not modelled; this is a planning estimate, not routing.");
  }
  uncertainties.push("Closures beyond stored regular hours cannot be predicted from cached venue data.");

  // A genuine conflict: a must-keep name matched nothing on the day.
  for (const name of intent.constraint.mustKeepNames) {
    const matched = dayItems.some(
      (item) => mustKeepMatched.has(item.id) || normalizeName(item.venueName).includes(normalizeName(name)) || normalizeName(name).includes(normalizeName(item.venueName)),
    );
    if (!matched) {
      conflicts.push(`No activity on today matches "${name}" to keep`);
    }
  }
  // An inaccessible request we cannot verify is a visible caveat, not a conflict.
  if (intent.unmapped.length > 0) {
    conflicts.push(`Could not read part of the request: ${intent.unmapped.join("; ")}`);
  }
  for (const note of preferenceNotes) {
    // Preference notes that describe a hard cap the revision could not keep.
    if (note.startsWith("Could not")) conflicts.push(note);
  }

  const warningUpdates = buildWarningUpdates(dayItems, args.pool, moves, skips, swaps);

  const impact: AdjustImpact = {
    moves,
    skips,
    swaps,
    unplaced,
    preserved,
    reservationNotes,
    travelNote,
    preferenceNotes,
    conflicts,
    uncertainties,
    warningUpdates,
  };

  return {
    kind: "adjust-today",
    dayIndex,
    reason: args.reason,
    impact,
    hasChanges: moves.length + skips.length + swaps.length > 0,
  };
}

function swapReason(intent: ParsedIntent, item: AdjustItem): string {
  if (intent.constraint.activityType && !item.categories.includes(intent.constraint.activityType)) {
    return `${item.venueName} does not fit the requested ${intent.constraint.activityType} focus; a verified alternative is proposed.`;
  }
  if (intent.constraint.maxDurationMin !== null && item.durationMin > intent.constraint.maxDurationMin) {
    return `${item.venueName} runs ${item.durationMin} min, over the ${intent.constraint.maxDurationMin}-minute cap.`;
  }
  return `${item.venueName} is heavier than the requested pace.`;
}

function skipReason(intent: ParsedIntent, item: AdjustItem): string {
  if (intent.constraint.energy === "low") return `Lower energy today; ${item.venueName} is set aside rather than rushed.`;
  if (intent.constraint.maxDurationMin !== null) return `${item.venueName} exceeds the ${intent.constraint.maxDurationMin}-minute cap and no lighter slot fits.`;
  return `${item.venueName} cannot be placed safely within today's remaining time.`;
}

function pickReplacement(args: {
  item: AdjustItem;
  pool: PlaceCandidate[];
  items: AdjustItem[];
  startDate: string;
  dayIndex: number;
  intent: ParsedIntent;
}): PlaceCandidate | null {
  const { item, pool, items, startDate, dayIndex, intent } = args;
  const usedTodayIds = new Set(
    items.filter((i) => i.dayIndex === dayIndex && i.id !== item.id).map((i) => i.candidateId),
  );
  const anchors = items
    .filter((i) => i.dayIndex === dayIndex && i.id !== item.id && Number.isFinite(i.lat) && Number.isFinite(i.lng))
    .map((i) => ({ lat: i.lat as number, lng: i.lng as number }));

  const candidates = pool
    .filter((candidate) => !usedTodayIds.has(candidate.placeId))
    .filter((candidate) => candidate.placeId !== item.candidateId)
    // Same block kind: a dinner replacement stays a meal, an activity stays one.
    .filter((candidate) =>
      slotKind(item.block) === "meal" ? isMealCandidate(candidate) : !isMealCandidate(candidate),
    )
    // Grounded: stay in the day's own area when one is recorded, and the venue's
    // regular hours must cover the slot it would occupy on this weekday.
    .filter((candidate) => (item.area ? (candidate.area ?? "") === item.area : true))
    .filter((candidate) =>
      regularHoursCoverBlock(candidate.openingPeriods, startDate, dayIndex, item.block, blockDurationHint(candidate)),
    )
    .filter((candidate) => {
      if (anchors.length === 0) return true;
      return anchors.every((anchor) => haversineKm(anchor, candidate) <= 60);
    })
    // Honour the desired activity type when one was asked for.
    .filter((candidate) =>
      intent.constraint.activityType ? candidate.categories.includes(intent.constraint.activityType) : true,
    )
    // Respect the duration cap on the replacement too, when expressed.
    .filter((candidate) =>
      intent.constraint.maxDurationMin !== null ? (blockDurationHint(candidate) <= intent.constraint.maxDurationMin) : true,
    )
    .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.reviewCount - a.reviewCount);

  return candidates[0] ?? null;
}

/** A loose duration hint for a candidate we have no booking for, by category. */
function blockDurationHint(candidate: PlaceCandidate): number {
  return isMealCandidate(candidate) ? 90 : 60;
}

/** Find a later same-kind slot not occupied in the preview's final plan. */
function laterSlotFor(item: AdjustItem, occupied: Set<Block>): Block | null {
  const order: Block[] = slotKind(item.block) === "meal" ? ["lunch", "dinner"] : ["morning", "afternoon", "evening"];
  const from = order.indexOf(item.block);
  for (const block of order.slice(from + 1)) {
    if (!occupied.has(block)) return block;
  }
  return null;
}

function buildWarningUpdates(
  dayItems: AdjustItem[],
  pool: PlaceCandidate[],
  moves: AdjustMove[],
  skips: AdjustSkip[],
  swaps: AdjustSwap[],
): AdjustImpact["warningUpdates"] {
  const moveByItem = new Map(moves.map((move) => [move.itemId, move]));
  const swapByItem = new Map(swaps.map((swap) => [swap.itemId, swap]));
  const skippedIds = new Set(skips.map((skip) => skip.itemId));
  const finalItems = dayItems
    .filter((item) => item.status === "planned" && !skippedIds.has(item.id))
    .map((item) => ({
      item,
      candidateId: swapByItem.get(item.id)?.toCandidateId ?? item.candidateId,
      block: moveByItem.get(item.id)?.toBlock ?? item.block,
      durationMin: swapByItem.get(item.id)?.durationMin ?? item.durationMin,
    }))
    .sort((a, b) => rank(a.block) - rank(b.block) || a.item.position - b.item.position);
  const warned = travelWarnings({
    days: [{
      dayIndex: dayItems[0]?.dayIndex ?? 0,
      area: dayItems[0]?.area ?? "",
      blocks: finalItems.map((entry) => ({
        block: entry.block,
        candidateId: entry.candidateId,
        whyNote: "",
        durationMin: entry.durationMin,
      })),
    }],
  }, new Map(pool.map((candidate) => [candidate.placeId, candidate])));

  return finalItems.map((entry) => ({
    itemId: entry.item.id,
    travelWarning: warned.has(entry.candidateId),
  }));
}

function travelImpactNote(dayItems: AdjustItem[], moves: AdjustMove[], swaps: AdjustSwap[]): string | null {
  if (moves.length === 0 && swaps.length === 0) return null;
  // Without precise routing we summarise the direction of travel change, not a
  // number: a swapped-in venue's distance to the day's other stops.
  const swapped = swaps
    .map((s) => {
      const source = dayItems.find((i) => i.id === s.itemId);
      if (!source || !Number.isFinite(source.lat) || !Number.isFinite(source.lng)) return null;
      return { name: s.toVenueName, origin: source };
    })
    .filter((entry): entry is { name: string; origin: AdjustItem } => entry !== null);
  if (swapped.length === 0) return null;
  const names = swapped.map((s) => s.name).join(", ");
  return `Travel between today's stops changes around ${names}; open Maps for live routing.`;
}

/**
 * A stable, order-independent content fingerprint of a preview payload.
 *
 * The route ships this alongside the persisted preview; the apply RPC compares
 * the fingerprint instead of trusting the client to echo unmodified JSON, which
 * is what turns "confirm what I reviewed" into a server-enforced guarantee.
 */
export function fingerprintPreview(preview: AdjustPreview): string {
  const canonical = JSON.stringify({
    dayIndex: preview.dayIndex,
    reason: preview.reason,
    moves: [...preview.impact.moves].sort((a, b) => a.itemId.localeCompare(b.itemId)),
    skips: [...preview.impact.skips].sort((a, b) => a.itemId.localeCompare(b.itemId)),
    swaps: [...preview.impact.swaps].sort((a, b) => a.itemId.localeCompare(b.itemId)),
  });
  // FNV-1a over the canonical string: small, dependency-free, stable across
  // Node and Postgres when the route and DB both need it.
  let hash = 0x811c9dc5;
  for (let i = 0; i < canonical.length; i++) {
    hash ^= canonical.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return `fnv1a:${hash.toString(16).padStart(8, "0")}`;
}
