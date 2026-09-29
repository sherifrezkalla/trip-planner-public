import type { SupabaseClient } from "@supabase/supabase-js";

import { dayCount } from "./auth";
import {
  authorityPolicySchema,
  tripAgentScopeSchema,
  type AuthorityPolicy,
  type TripAgentScope,
} from "./trip-agent-contracts";
import { evaluateTripAgentAuthority } from "./trip-agent-policy";
import { tallyProposal, type ProposalKind } from "./proposals";
import {
  TODAY_BLOCK_START_MINUTES,
  getTripTiming,
  itemsForToday,
  leaveByEstimate,
  nextTodayItem,
  venueHoursRisk,
  type TodayItem,
} from "./today";
import type { OpeningPeriod } from "./places";
import {
  serializeReservationArtifact,
  type ReservationArtifactRow,
} from "./reservation-artifacts";
import { reservationAttemptForViewer } from "./reservation-assistance";

type ReadDb = Pick<SupabaseClient, "from">;
type VoteRow = { traveler_id: string; value: number };

type TripRow = {
  id: string;
  slug: string;
  title: string | null;
  destination_name: string;
  start_date: string;
  end_date: string;
  budget_level: string;
  vibe_note: string;
  lat: number;
  lng: number;
};

type VenueRow = {
  name: string;
  rating: number | null;
  review_count: number;
  price_level: string | null;
  opening_hours: string[];
  opening_periods: OpeningPeriod[] | null;
  lat: number;
  lng: number;
  maps_url: string;
  fetched_at: string;
  venue_candidate_categories: { category: string }[] | null;
};

type ItemRow = {
  id: string;
  day_index: number;
  block: string;
  why_note: string;
  area: string | null;
  duration_min: number;
  position: number;
  travel_warning: boolean;
  status: "planned" | "done" | "skipped" | null;
  is_locked: boolean | null;
  completed_at: string | null;
  completed_day_index: number | null;
  reservation_status: string | null;
  reservation_at: string | null;
  venue_candidates: VenueRow | VenueRow[] | null;
  votes: VoteRow[] | null;
};

type ProposalRow = {
  id: string;
  item_id: string | null;
  kind: ProposalKind;
  from_day_index: number | null;
  from_block: string | null;
  to_day_index: number | null;
  to_block: string | null;
  to_candidate_id: string | null;
  suggestion_text: string | null;
  created_at: string;
  plan_proposal_votes: VoteRow[] | null;
};

type BoardItemRow = ItemRow & {
  state_changed_by: string | null;
  confirmation_number: string | null;
  booking_url: string | null;
  cancellation_deadline: string | null;
  reservation_auto_locked: boolean | null;
  reservation_details_source: "organizer" | "artifact" | null;
  reservation_organizer_verified_at: string | null;
  reservation_proof_artifacts: ReservationArtifactRow[] | null;
};

type BoardProposalRow = ProposalRow & {
  proposed_by: string;
  note: string | null;
};

type ConnectionRow = {
  status: "pending" | "paired" | "active" | "paused" | "revoked" | "archived";
  granted_scopes: unknown;
  authority_policy: unknown;
};

type MappingRow = {
  status: "suggested" | "confirmed" | "revoked";
  traveler_id: string | null;
  traveler: {
    id: string;
    is_organizer: boolean;
    is_bot: boolean;
  } | Array<{
    id: string;
    is_organizer: boolean;
    is_bot: boolean;
  }> | null;
};

type ConfirmedViewer = {
  travelerId: string;
  isOrganizer: boolean;
  isBot: boolean;
  connection: {
    status: ConnectionRow["status"];
    grantedScopes: TripAgentScope[];
  };
  authorityPolicy: AuthorityPolicy;
};

export type GroupSafeViewerLookup = {
  connectionId: string;
  lifecycleGeneration: number;
  externalParticipantDigest: string;
};

export type GroupSafeCapabilities = {
  canVote: boolean;
  canProposeChange: boolean;
  canAddSuggestion: boolean;
  canDecide: boolean;
};

export type GroupSafeVenue = {
  name: string;
  rating: number | null;
  reviewCount: number;
  priceLevel: string | null;
  openingHours: string[];
  openingPeriods: OpeningPeriod[];
  categories: string[];
  lat: number;
  lng: number;
  mapsUrl: string;
  fetchedAt: string;
};

export type GroupSafeItem = {
  id: string;
  dayIndex: number;
  block: string;
  whyNote: string;
  area: string;
  durationMin: number;
  position: number;
  travelWarning: boolean;
  status: "planned" | "done" | "skipped";
  isLocked: boolean;
  completedAt: string | null;
  completedDayIndex: number | null;
  reservationStatus: string;
  reservationAt: string | null;
  bookingStatus: string | null;
  venue: GroupSafeVenue;
  voteSum: number;
  myVote?: number;
};

export type GroupSafeDecision = {
  id: string;
  itemId: string | null;
  kind: ProposalKind;
  description: string;
  fromDayIndex: number | null;
  fromBlock: string | null;
  toDayIndex: number | null;
  toBlock: string | null;
  replacementName: string | null;
  suggestionText: string | null;
  createdAt: string;
  yes: number;
  no: number;
  needed: number;
  outcome: "apply" | "reject" | "pending";
  myVote?: number;
};

export type GroupSafeTripContext = {
  trip: {
    slug: string;
    title: string;
    destinationName: string;
    startDate: string;
    endDate: string;
    budgetLevel: string;
    vibeNote: string;
    lat: number;
    lng: number;
    dayCount: number;
  };
  items: GroupSafeItem[];
  pendingDecisions: GroupSafeDecision[];
  viewer?: GroupSafeCapabilities;
};

export type GroupSafeTodayOptions = {
  viewer?: GroupSafeViewerLookup | null;
  /** Explicit destination timezone. UTC is the safe foundation fallback. */
  timeZone?: string;
};

export type GroupSafeToday = {
  phase: "before" | "during" | "after";
  dayIndex: number;
  date: string;
  items: GroupSafeItem[];
  next: GroupSafeItem | null;
  leaveBy: {
    originName: string;
    scheduledAt: string;
    leaveBy: string;
    transfer: {
      distanceKm: number;
      durationMin: number;
      mode: "walk" | "local transfer" | "drive";
    };
    urgency: "later" | "soon" | "now" | "late";
  } | null;
  openingHoursRisk: {
    level: "clear" | "warning" | "danger" | "unknown";
    message: string;
  } | null;
  pendingDecisions: GroupSafeDecision[];
  viewer?: GroupSafeCapabilities;
};

function singleRelation<T>(value: T | T[] | null): T | null {
  return Array.isArray(value) ? value[0] ?? null : value;
}

function safeVenue(row: VenueRow): GroupSafeVenue {
  return {
    name: row.name,
    rating: row.rating,
    reviewCount: row.review_count,
    priceLevel: row.price_level,
    openingHours: row.opening_hours ?? [],
    openingPeriods: row.opening_periods ?? [],
    categories: (row.venue_candidate_categories ?? []).map((entry) => entry.category),
    lat: row.lat,
    lng: row.lng,
    mapsUrl: row.maps_url,
    fetchedAt: row.fetched_at,
  };
}

function safeTrip(row: TripRow): GroupSafeTripContext["trip"] {
  return {
    slug: row.slug,
    title: row.title ?? "",
    destinationName: row.destination_name,
    startDate: row.start_date,
    endDate: row.end_date,
    budgetLevel: row.budget_level,
    vibeNote: row.vibe_note,
    lat: row.lat,
    lng: row.lng,
    dayCount: dayCount(row.start_date, row.end_date),
  };
}

/** Exact legacy board trip mapper; kept separate from every group-safe mapper. */
export function mapBoardTripRow(row: TripRow): GroupSafeTripContext["trip"] {
  return safeTrip(row);
}

/** Exact legacy board proposal mapper; this private board shape is never used by agent reads. */
export function mapBoardProposalRow(
  row: BoardProposalRow,
  options: {
    humanTravelerCount: number;
    viewerTravelerId: string;
    travelerNameById: ReadonlyMap<string, string>;
    replacementNameById: ReadonlyMap<string, string>;
  },
) {
  const votes = row.plan_proposal_votes ?? [];
  const tally = tallyProposal({
    votes: votes.map((vote) => ({
      travelerId: vote.traveler_id,
      value: vote.value === 1 ? 1 : -1,
    })),
    travelerCount: options.humanTravelerCount,
  });
  return {
    id: row.id,
    itemId: row.item_id,
    kind: row.kind,
    proposedByName: options.travelerNameById.get(row.proposed_by) ?? "Traveller",
    fromDayIndex: row.from_day_index,
    fromBlock: row.from_block,
    toDayIndex: row.to_day_index,
    toBlock: row.to_block,
    replacementName: options.replacementNameById.get(row.to_candidate_id ?? "") ?? null,
    suggestionText: row.suggestion_text ?? null,
    note: row.note ?? "",
    createdAt: row.created_at,
    yes: tally.yes,
    no: tally.no,
    needed: tally.needed,
    myVote: votes.find((vote) => vote.traveler_id === options.viewerTravelerId)?.value ?? 0,
  };
}

/** Exact legacy board item mapper; intentionally includes organizer/private board fields. */
export function mapBoardItemRow(
  row: BoardItemRow,
  options: {
    viewerTravelerId: string;
    viewerIsOrganizer: boolean;
    travelerNameById: ReadonlyMap<string, string>;
    reservationAttempt: Record<string, unknown> | null;
  },
) {
  const votes = row.votes ?? [];
  const venue = singleRelation(row.venue_candidates);
  if (!venue) throw new Error(`Missing venue for itinerary item ${row.id}`);
  const proofRows = row.reservation_proof_artifacts ?? [];
  const proof = proofRows.find((candidate) => candidate.status === "active") ?? null;
  return {
    id: row.id,
    dayIndex: row.day_index,
    block: row.block,
    whyNote: row.why_note,
    area: row.area ?? "",
    durationMin: row.duration_min,
    position: row.position,
    travelWarning: row.travel_warning,
    status: row.status ?? "planned",
    isLocked: row.is_locked ?? false,
    completedAt: row.completed_at ?? null,
    completedDayIndex: row.completed_day_index ?? null,
    stateChangedByName: row.state_changed_by
      ? options.travelerNameById.get(row.state_changed_by) ?? "Traveller"
      : null,
    reservation: {
      status: row.reservation_status ?? "none",
      reservationAt: row.reservation_at ?? null,
      confirmationNumber: row.confirmation_number ?? null,
      bookingUrl: row.booking_url ?? null,
      cancellationDeadline: row.cancellation_deadline ?? null,
      autoLocked: row.reservation_auto_locked ?? false,
      detailsSource: row.reservation_details_source ?? "organizer",
      organizerVerifiedAt: row.reservation_organizer_verified_at ?? null,
      artifact: serializeReservationArtifact(proof, options.viewerIsOrganizer),
      artifactCleanupPending: options.viewerIsOrganizer
        && proofRows.some((candidate) => candidate.status === "pending_delete"),
    },
    reservationAttempt: options.reservationAttempt
      ? reservationAttemptForViewer(options.reservationAttempt, options.viewerIsOrganizer)
      : null,
    venue: safeVenue(venue),
    voteSum: votes.reduce((sum, vote) => sum + vote.value, 0),
    myVote: votes.find((vote) => vote.traveler_id === options.viewerTravelerId)?.value ?? 0,
  };
}

function safeItem(
  row: ItemRow,
  bookingStatus: string | null,
  viewerTravelerId: string | null,
): GroupSafeItem {
  const venue = singleRelation(row.venue_candidates);
  if (!venue) throw new Error(`Missing venue for itinerary item ${row.id}`);
  const votes = row.votes ?? [];
  const mapped: GroupSafeItem = {
    id: row.id,
    dayIndex: row.day_index,
    block: row.block,
    whyNote: row.why_note,
    area: row.area ?? "",
    durationMin: row.duration_min,
    position: row.position,
    travelWarning: row.travel_warning,
    status: row.status ?? "planned",
    isLocked: row.is_locked ?? false,
    completedAt: row.completed_at ?? null,
    completedDayIndex: row.completed_day_index ?? null,
    reservationStatus: row.reservation_status ?? "none",
    reservationAt: row.reservation_at ?? null,
    bookingStatus,
    venue: safeVenue(venue),
    voteSum: votes.reduce((sum, vote) => sum + vote.value, 0),
  };
  if (viewerTravelerId !== null) {
    mapped.myVote = votes.find((vote) => vote.traveler_id === viewerTravelerId)?.value ?? 0;
  }
  return mapped;
}

function describeDecision(
  proposal: ProposalRow,
  itemNameById: ReadonlyMap<string, string>,
  replacementNameById: ReadonlyMap<string, string>,
): string {
  const itemName = proposal.item_id ? itemNameById.get(proposal.item_id) ?? "an activity" : "an activity";
  const fromDay = (proposal.from_day_index ?? 0) + 1;
  switch (proposal.kind) {
    case "remove":
      return `Drop ${itemName} from Day ${fromDay}`;
    case "move":
      return `Move ${itemName} to Day ${(proposal.to_day_index ?? 0) + 1} ${proposal.to_block}`;
    case "replace":
      return `Swap ${itemName} for ${replacementNameById.get(proposal.to_candidate_id ?? "") ?? "another venue"} on Day ${fromDay}`;
    case "suggest":
      return `Add ${proposal.suggestion_text ?? "this idea"} to the group's suggestions`;
  }
}

function safeDecision(
  row: ProposalRow,
  humanTravelerCount: number,
  viewerTravelerId: string | null,
  itemNameById: ReadonlyMap<string, string>,
  replacementNameById: ReadonlyMap<string, string>,
): GroupSafeDecision {
  const votes = row.plan_proposal_votes ?? [];
  const tally = tallyProposal({
    votes: votes.map((vote) => ({
      travelerId: vote.traveler_id,
      value: vote.value === 1 ? 1 : -1,
    })),
    travelerCount: humanTravelerCount,
  });
  const decision: GroupSafeDecision = {
    id: row.id,
    itemId: row.item_id,
    kind: row.kind,
    description: describeDecision(row, itemNameById, replacementNameById),
    fromDayIndex: row.from_day_index,
    fromBlock: row.from_block,
    toDayIndex: row.to_day_index,
    toBlock: row.to_block,
    replacementName: replacementNameById.get(row.to_candidate_id ?? "") ?? null,
    suggestionText: row.suggestion_text ?? null,
    createdAt: row.created_at,
    yes: tally.yes,
    no: tally.no,
    needed: tally.needed,
    outcome: tally.outcome,
  };
  if (viewerTravelerId !== null) {
    decision.myVote = votes.find((vote) => vote.traveler_id === viewerTravelerId)?.value ?? 0;
  }
  return decision;
}

function parsedScopes(value: unknown): TripAgentScope[] | null {
  const parsed = tripAgentScopeSchema.array().safeParse(value);
  return parsed.success ? parsed.data : null;
}

async function confirmedViewer(
  db: ReadDb,
  tripId: string,
  viewer: GroupSafeViewerLookup | null,
): Promise<ConfirmedViewer | null> {
  if (!viewer) return null;
  const [connectionResult, mappingResult] = await Promise.all([
    db.from("trip_agent_connections")
      .select("status, granted_scopes, authority_policy")
      .eq("id", viewer.connectionId)
      .eq("trip_id", tripId)
      .eq("lifecycle_generation", viewer.lifecycleGeneration)
      .maybeSingle(),
    db.from("trip_agent_participant_mappings")
      .select("status, traveler_id, traveler:travelers!trip_agent_participant_mapping_traveler_same_trip(id, is_organizer, is_bot)")
      .eq("connection_id", viewer.connectionId)
      .eq("trip_id", tripId)
      .eq("lifecycle_generation", viewer.lifecycleGeneration)
      .eq("external_participant_digest", viewer.externalParticipantDigest)
      .eq("status", "confirmed")
      .maybeSingle(),
  ]);
  if (connectionResult.error) throw new Error(`Could not load trip-agent connection: ${connectionResult.error.message}`);
  if (mappingResult.error) throw new Error(`Could not load trip-agent viewer: ${mappingResult.error.message}`);

  const connection = connectionResult.data as ConnectionRow | null;
  const mapping = mappingResult.data as unknown as MappingRow | null;
  const traveler = mapping ? singleRelation(mapping.traveler) : null;
  const scopes = parsedScopes(connection?.granted_scopes);
  const policy = authorityPolicySchema.safeParse(connection?.authority_policy);
  if (
    !connection
    || !mapping
    || mapping.status !== "confirmed"
    || !mapping.traveler_id
    || !traveler
    || mapping.traveler_id !== traveler.id
    || !scopes
    || !policy.success
  ) return null;

  return {
    travelerId: traveler.id,
    isOrganizer: traveler.is_organizer,
    isBot: traveler.is_bot,
    connection: { status: connection.status, grantedScopes: scopes },
    authorityPolicy: policy.data,
  };
}

function capabilities(viewer: ConfirmedViewer): GroupSafeCapabilities {
  const mapping = {
    status: "confirmed" as const,
    traveler: {
      id: viewer.travelerId,
      isOrganizer: viewer.isOrganizer,
      isBot: viewer.isBot,
    },
  };
  const authority = (operation: "vote" | "decide" | "commit_change", changeKind?: "move" | "suggest") =>
    evaluateTripAgentAuthority({
      operation,
      connection: viewer.connection,
      mapping,
      authorityPolicy: viewer.authorityPolicy,
      changeKind,
    }).decision === "allowed";
  return {
    canVote: authority("vote"),
    canProposeChange: authority("commit_change", "move"),
    canAddSuggestion: authority("commit_change", "suggest"),
    canDecide: authority("decide"),
  };
}

/** Load a fresh explicit allowlist projection; it never serializes the board response. */
export async function loadGroupSafeTripContext(
  db: ReadDb,
  tripId: string,
  viewerLookup: GroupSafeViewerLookup | null,
): Promise<GroupSafeTripContext> {
  const [tripResult, travelersResult, itemsResult, proposalsResult, attemptsResult, viewer] = await Promise.all([
    db.from("trips")
      .select("id, slug, title, destination_name, start_date, end_date, budget_level, vibe_note, lat, lng")
      .eq("id", tripId)
      .maybeSingle(),
    db.from("travelers")
      .select("is_bot")
      .eq("trip_id", tripId),
    db.from("itinerary_items")
      .select("id, day_index, block, why_note, area, duration_min, position, travel_warning, status, is_locked, completed_at, completed_day_index, reservation_status, reservation_at, venue_candidates(name, rating, review_count, price_level, opening_hours, opening_periods, lat, lng, maps_url, fetched_at, venue_candidate_categories(category)), votes(traveler_id, value)")
      .eq("trip_id", tripId)
      .order("day_index")
      .order("position"),
    db.from("plan_proposals")
      .select("id, item_id, kind, from_day_index, from_block, to_day_index, to_block, to_candidate_id, suggestion_text, created_at, plan_proposal_votes(traveler_id, value)")
      .eq("trip_id", tripId)
      .eq("status", "open")
      .order("created_at"),
    db.from("reservation_attempts")
      .select("itinerary_item_id, state, created_at")
      .eq("trip_id", tripId)
      .order("created_at", { ascending: false }),
    confirmedViewer(db, tripId, viewerLookup),
  ]);

  const failures = [
    ["trip", tripResult.error],
    ["travelers", travelersResult.error],
    ["itinerary", itemsResult.error],
    ["proposals", proposalsResult.error],
    ["reservation assistance", attemptsResult.error],
  ] as const;
  const failed = failures.find(([, error]) => error);
  if (failed) throw new Error(`Could not load ${failed[0]}: ${failed[1]!.message}`);
  if (!tripResult.data) throw new Error("Trip not found");

  const tripRow = tripResult.data as TripRow;
  const travelerRows = (travelersResult.data ?? []) as Array<{ is_bot: boolean }>;
  const itemRows = (itemsResult.data ?? []) as unknown as ItemRow[];
  const proposalRows = (proposalsResult.data ?? []) as unknown as ProposalRow[];
  const attemptRows = (attemptsResult.data ?? []) as Array<{ itinerary_item_id: string; state: string }>;

  const replacementIds = [...new Set(proposalRows
    .map((proposal) => proposal.to_candidate_id)
    .filter((id): id is string => Boolean(id)))];
  const replacementNameById = new Map<string, string>();
  if (replacementIds.length > 0) {
    const replacements = await db.from("venue_candidates")
      .select("id, name")
      .eq("trip_id", tripId)
      .in("id", replacementIds);
    if (replacements.error) throw new Error(`Could not load replacement venues: ${replacements.error.message}`);
    for (const row of (replacements.data ?? []) as Array<{ id: string; name: string }>) {
      replacementNameById.set(row.id, row.name);
    }
  }

  const bookingStatusByItemId = new Map<string, string>();
  for (const attempt of attemptRows) {
    if (!bookingStatusByItemId.has(attempt.itinerary_item_id)) {
      bookingStatusByItemId.set(attempt.itinerary_item_id, attempt.state);
    }
  }
  const viewerTravelerId = viewer?.travelerId ?? null;
  const safeItems = itemRows.map((row) => safeItem(
    row,
    bookingStatusByItemId.get(row.id) ?? null,
    viewerTravelerId,
  ));
  const itemNameById = new Map(safeItems.map((item) => [item.id, item.venue.name]));
  const humanTravelerCount = travelerRows.filter((row) => !row.is_bot).length;
  const result: GroupSafeTripContext = {
    trip: safeTrip(tripRow),
    items: safeItems,
    pendingDecisions: proposalRows.map((row) => safeDecision(
      row,
      humanTravelerCount,
      viewerTravelerId,
      itemNameById,
      replacementNameById,
    )),
  };
  if (viewer) result.viewer = capabilities(viewer);
  return result;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  try {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    throw new Error(`Invalid time zone: ${timeZone}`);
  }
}

function zonedParts(instant: Date, formatter: Intl.DateTimeFormat): Record<string, number> {
  const parts: Record<string, number> = {};
  for (const part of formatter.formatToParts(instant)) {
    if (part.type !== "literal") parts[part.type] = Number(part.value);
  }
  return parts;
}

/** A synthetic local Date lets the existing Today helpers operate on destination wall time. */
function wallClockDate(instant: Date, formatter: Intl.DateTimeFormat): Date {
  const parts = zonedParts(instant, formatter);
  return new Date(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
}

function tripDateAt(startDate: string, dayIndex: number): string {
  const [year, month, day] = startDate.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + dayIndex)).toISOString().slice(0, 10);
}

/** Resolve a trip-local wall time to its actual instant, including DST offsets. */
function instantForTripWallTime(
  date: string,
  minutes: number,
  formatter: Intl.DateTimeFormat,
): Date {
  const [year, month, day] = date.split("-").map(Number);
  const wallTime = Date.UTC(year, month - 1, day, Math.floor(minutes / 60), minutes % 60);
  let candidate = wallTime;
  for (let iteration = 0; iteration < 3; iteration += 1) {
    const parts = zonedParts(new Date(candidate), formatter);
    const representedWallTime = Date.UTC(
      parts.year,
      parts.month - 1,
      parts.day,
      parts.hour,
      parts.minute,
      parts.second,
    );
    candidate += wallTime - representedWallTime;
  }
  return new Date(candidate);
}

function toTodayItem(item: GroupSafeItem): TodayItem {
  return {
    id: item.id,
    dayIndex: item.dayIndex,
    block: item.block,
    status: item.status,
    completedDayIndex: item.completedDayIndex,
    position: item.position,
    durationMin: item.durationMin,
    reservation: {
      status: item.reservationStatus as "none" | "tentative" | "confirmed" | "cancelled",
      reservationAt: item.reservationAt,
      confirmationNumber: null,
      bookingUrl: null,
      cancellationDeadline: null,
      autoLocked: item.isLocked,
    },
    venue: {
      name: item.venue.name,
      openingHours: item.venue.openingHours,
      openingPeriods: item.venue.openingPeriods,
      lat: item.venue.lat,
      lng: item.venue.lng,
    },
  };
}

export async function loadGroupSafeToday(
  db: ReadDb,
  tripId: string,
  at: Date,
  options: GroupSafeTodayOptions = {},
): Promise<GroupSafeToday> {
  if (!Number.isFinite(at.getTime())) throw new Error("Invalid current time");
  const formatter = formatterFor(options.timeZone ?? "UTC");
  const context = await loadGroupSafeTripContext(db, tripId, options.viewer ?? null);
  const wallNow = wallClockDate(at, formatter);
  const timing = getTripTiming(context.trip.startDate, context.trip.endDate, wallNow);
  const todayDomainItems = itemsForToday(context.items.map(toTodayItem), timing.dayIndex);
  const safeItemById = new Map(context.items.map((item) => [item.id, item]));
  const todayItems = todayDomainItems
    .map((item) => safeItemById.get(item.id))
    .filter((item): item is GroupSafeItem => Boolean(item));
  const nextDomain = nextTodayItem(todayDomainItems, timing.dayIndex, wallNow);
  const next = nextDomain
    ? context.items.find((item) => item.id === nextDomain.id) ?? null
    : null;

  let leaveBy: GroupSafeToday["leaveBy"] = null;
  let openingHoursRisk: GroupSafeToday["openingHoursRisk"] = null;
  if (nextDomain && next) {
    const activeReservation = ["tentative", "confirmed"].includes(next.reservationStatus)
      && next.reservationAt;
    const estimateTarget: TodayItem = activeReservation
      ? nextDomain
      : {
          id: nextDomain.id,
          dayIndex: nextDomain.dayIndex,
          block: nextDomain.block,
          status: nextDomain.status,
          completedDayIndex: nextDomain.completedDayIndex,
          position: nextDomain.position,
          durationMin: nextDomain.durationMin,
          venue: nextDomain.venue,
          reservation: {
            status: "confirmed",
            reservationAt: instantForTripWallTime(
              tripDateAt(context.trip.startDate, timing.dayIndex),
              TODAY_BLOCK_START_MINUTES[next.block] ?? 0,
              formatter,
            ).toISOString(),
            confirmationNumber: null,
            bookingUrl: null,
            cancellationDeadline: null,
            autoLocked: false,
          },
        };
    const estimateItems = todayDomainItems.map((item) =>
      item.id === estimateTarget.id ? estimateTarget : item);
    const estimate = leaveByEstimate(
      estimateItems,
      estimateTarget,
      timing.dayIndex,
      context.trip.startDate,
      at,
    );
    if (estimate) {
      leaveBy = {
        originName: estimate.originName,
        scheduledAt: estimate.scheduledAt.toISOString(),
        leaveBy: estimate.leaveBy.toISOString(),
        transfer: {
          distanceKm: estimate.transfer.distanceKm,
          durationMin: estimate.transfer.durationMin,
          mode: estimate.transfer.mode,
        },
        urgency: estimate.urgency,
      };
    }
    openingHoursRisk = venueHoursRisk(
      next.venue.openingPeriods,
      context.trip.startDate,
      timing.dayIndex,
      next.block,
      next.durationMin,
      wallNow,
    );
  }

  const result: GroupSafeToday = {
    phase: timing.phase,
    dayIndex: timing.dayIndex,
    date: tripDateAt(context.trip.startDate, timing.dayIndex),
    items: todayItems,
    next,
    leaveBy,
    openingHoursRisk,
    pendingDecisions: context.pendingDecisions,
  };
  if (context.viewer) result.viewer = context.viewer;
  return result;
}
