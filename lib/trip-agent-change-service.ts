import "server-only";
import { createPlanProposal, createSuggestionProposal } from "./persistence";
import { settleProposal, type ProposalRow } from "./proposal-actions";
import {
  authorityPolicySchema, commitTripChangeInputSchema, previewTripChangeInputSchema, tripChangeSchema,
  voteOnTripChangeInputSchema, decideTripChangeInputSchema,
  toolFailure, type TripAgentChange, type TripAgentToolResult, type TripAgentScope,
} from "./trip-agent-contracts";
import { evaluateTripAgentAuthority, type TripAgentAuthorityInput } from "./trip-agent-policy";
import {
  actionResult, beginAction, groupAndActorDigests, hashNormalizedJson, readAction, writeAction,
  finalizePreview, settlementSchema,
  type TripAgentAction, type ActionPreview,
} from "./trip-agent-actions";
import type { TripAgentToolContext } from "./trip-agent-tools";

export type TripAgentChangeDependencies = {
  now: () => Date;
  createPlanProposal: typeof createPlanProposal;
  createSuggestionProposal: typeof createSuggestionProposal;
  settleProposal: typeof settleProposal;
};
const defaults: TripAgentChangeDependencies = { now: () => new Date(), createPlanProposal, createSuggestionProposal, settleProposal };
const failures = new Set([
  "database_unavailable", "invalid_input", "group_not_registered", "group_mismatch", "configuration_unavailable",
  "connection_unavailable", "connection_not_active", "missing_scope", "confirmed_mapping_required",
  "automated_travelers_cannot_vote", "organizer_confirmation_required", "organizer_unavailable",
  "preview_expired", "plan_changed", "reservation_locked", "destination_occupied", "proposal_stale",
  "action_not_found", "actor_changed", "booking_route_unavailable",
  "duplicate_suggestion",
  "organizer_mapping_required", "proposal_already_decided", "action_in_progress", "authority_changed",
]);
class Refusal extends Error {}
function refuse(code: string): never { throw new Refusal(code); }
function failureCode(error: unknown): string {
  if (error instanceof Refusal && failures.has(error.message)) return error.message;
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  return ({ TP001: "plan_changed", TP002: "reservation_locked", TP003: "destination_occupied", TP004: "duplicate_suggestion", TP005: "proposal_already_decided", TP006: "authority_changed", TP007: "action_not_found", "23514": "proposal_stale", "23505": "destination_occupied", "23503": "proposal_stale", P0002: "proposal_stale" } as Record<string, string>)[code] ?? "database_unavailable";
}

async function currentAuthority(context: TripAgentToolContext, input: { externalGroupId: string; externalParticipantId: string }) {
  const connectionRead = await context.db.from("trip_agent_connections")
    .select("lifecycle_generation, status, granted_scopes, authority_policy, whatsapp_group_digest")
    .eq("id", context.connection.id).eq("trip_id", context.connection.tripId)
    .eq("lifecycle_generation", context.connection.lifecycleGeneration).maybeSingle();
  if (connectionRead.error) refuse("database_unavailable");
  if (!connectionRead.data) refuse("connection_unavailable");
  const stored = connectionRead.data;
  const policy = authorityPolicySchema.safeParse(stored.authority_policy);
  if (!policy.success) refuse("database_unavailable");
  const bound = { ...context, connection: { ...context.connection, whatsappGroupDigest: stored.whatsapp_group_digest as string | null } };
  const digests = groupAndActorDigests(bound, input);
  if (!digests.ok) refuse(digests.error.code);
  const mappingRead = await context.db.from("trip_agent_participant_mappings")
    .select("status, traveler_id").eq("connection_id", context.connection.id)
    .eq("trip_id", context.connection.tripId)
    .eq("lifecycle_generation", context.connection.lifecycleGeneration)
    .eq("external_participant_digest", digests.data.actorDigest).maybeSingle();
  if (mappingRead.error) refuse("database_unavailable");
  if (mappingRead.data?.status !== "confirmed" || !mappingRead.data.traveler_id) refuse("confirmed_mapping_required");
  // Resolve mapping first, then independently constrain the traveler to this trip.
  const travelerRead = await context.db.from("travelers").select("id, is_organizer, is_bot")
    .eq("id", mappingRead.data.traveler_id).eq("trip_id", context.connection.tripId).maybeSingle();
  if (travelerRead.error) refuse("database_unavailable");
  if (!travelerRead.data) refuse("confirmed_mapping_required");
  const traveler = travelerRead.data as { id: string; is_organizer: boolean; is_bot: boolean };
  const authority = {
    connection: { status: stored.status as TripAgentAuthorityInput["connection"]["status"], grantedScopes: stored.granted_scopes as TripAgentScope[] },
    authorityPolicy: policy.data,
    mapping: { status: "confirmed" as const, traveler: { id: traveler.id, isOrganizer: traveler.is_organizer, isBot: traveler.is_bot } },
  };
  return { context: bound, authority, traveler, ...digests.data };
}

type Item = { id: string; day_index: number; block: string; candidate_id: string; status: string; is_locked: boolean; reservation_status: string; reservation_at: string | null; position: number; booking_url?: string | null };
type Venue = { id: string; name: string; maps_url: string };
function safetyItem(item: Item) {
  return { id: item.id, dayIndex: item.day_index, block: item.block, candidateId: item.candidate_id, status: item.status, locked: item.is_locked, reservationStatus: item.reservation_status, reservationAt: item.reservation_at ? new Date(item.reservation_at).toISOString() : null, position: item.position };
}
function httpsRoute(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  try { const url = new URL(value.trim()); return url.protocol === "https:" && !url.username && !url.password ? value.trim() : null; } catch { return null; }
}

/** Private fields feed only the hash. No raw row becomes preview/result JSON. */
export async function tripAgentChangeSnapshot(context: TripAgentToolContext, change: TripAgentChange) {
  if (change.kind === "suggest") {
    const [trip, suggestions] = await Promise.all([
      context.db.from("trips").select("id").eq("id", context.connection.tripId).maybeSingle(),
      context.db.from("plan_proposals").select("id, suggestion_text")
        .eq("trip_id", context.connection.tripId).eq("kind", "suggest").eq("status", "open"),
    ]);
    if (trip.error || suggestions.error || !trip.data || !suggestions.data) refuse("database_unavailable");
    const normalize = (text: string) => text.trim().replace(/\s+/g, " ").toLowerCase();
    if (suggestions.data.some(row => normalize(row.suggestion_text) === normalize(change.text))) refuse("duplicate_suggestion");
    const expectedState = { tripId: context.connection.tripId, matchingOpenSuggestions: [] };
    return { fingerprint: hashNormalizedJson(expectedState), expectedState, impact: `Suggest to the group: ${change.text}` };
  }
  const [tripRead, itemsRead] = await Promise.all([
    context.db.from("trips").select("start_date, end_date").eq("id", context.connection.tripId).maybeSingle(),
    context.db.from("itinerary_items").select(`id, day_index, block, candidate_id, status, is_locked, reservation_status, reservation_at, position${change.kind === "reservation_prepare" ? ", booking_url" : ""}`).eq("trip_id", context.connection.tripId),
  ]);
  if (tripRead.error || itemsRead.error || !tripRead.data || !itemsRead.data) refuse("database_unavailable");
  const trip = { start_date: tripRead.data.start_date as string, end_date: tripRead.data.end_date as string };
  const items = itemsRead.data as unknown as Item[];
  const item = items.find(row => row.id === change.itemId);
  if (!item || item.status !== "planned") refuse("proposal_stale");
  if (item.is_locked || ["tentative", "confirmed"].includes(item.reservation_status)) refuse("reservation_locked");
  const venueRead = await context.db.from("venue_candidates").select("id, name, maps_url")
    .eq("id", item.candidate_id).eq("trip_id", context.connection.tripId).maybeSingle();
  if (venueRead.error) refuse("database_unavailable");
  if (!venueRead.data) refuse("proposal_stale");
  const venue = venueRead.data as Venue;
  let impact: string;
  let privateReservation: { organizerId: string; organizerName: string; route: string; bookingUrl: string | null; mapsUrl: string } | null = null;
  let replacement: { id: string; name: string } | null = null;
  if (change.kind === "move") {
    const duration = (Date.parse(trip.end_date) - Date.parse(trip.start_date)) / 86_400_000;
    if (!Number.isFinite(duration) || change.toDayIndex > duration
      || (item.day_index === change.toDayIndex && item.block === change.toBlock)) refuse("proposal_stale");
    if (items.some(row => row.id !== item.id && row.status === "planned" && row.day_index === change.toDayIndex && row.block === change.toBlock)) refuse("destination_occupied");
    impact = `Move ${venue.name} from Day ${item.day_index + 1} ${item.block} to Day ${change.toDayIndex + 1} ${change.toBlock}.`;
  } else if (change.kind === "remove") {
    impact = `Remove ${venue.name} from Day ${item.day_index + 1} ${item.block}.`;
  } else if (change.kind === "replace") {
    const read = await context.db.from("venue_candidates").select("id, name")
      .eq("id", change.replacementCandidateId).eq("trip_id", context.connection.tripId).maybeSingle();
    if (read.error) refuse("database_unavailable");
    if (!read.data || item.candidate_id === change.replacementCandidateId) refuse("proposal_stale");
    if (items.some(row => row.id !== item.id && row.status === "planned" && row.candidate_id === change.replacementCandidateId)) refuse("destination_occupied");
    replacement = { id: read.data.id as string, name: read.data.name as string };
    impact = `Replace ${venue.name} with ${replacement.name} on Day ${item.day_index + 1} ${item.block}.`;
  } else {
    const organizers = await context.db.from("travelers").select("id, display_name")
      .eq("trip_id", context.connection.tripId).eq("is_organizer", true).eq("is_bot", false);
    if (organizers.error || !organizers.data) refuse("database_unavailable");
    if (organizers.data.length !== 1 || !organizers.data[0].display_name?.trim() || organizers.data[0].display_name.trim().length > 120) refuse("organizer_unavailable");
    const route = httpsRoute(item.booking_url) ?? httpsRoute(venue.maps_url);
    if (!route) refuse("booking_route_unavailable");
    privateReservation = {
      organizerId: organizers.data[0].id, organizerName: organizers.data[0].display_name.trim(), route,
      bookingUrl: item.booking_url?.trim() ?? null, mapsUrl: venue.maps_url.trim(),
    };
    impact = `Prepare a reservation for ${venue.name}, party of ${change.partySize}, at ${change.requestedAt}. The organizer must confirm privately before booking starts.`;
  }
  const destination = items.filter(row => row.id !== item.id && row.status === "planned" && (
    change.kind === "move" ? row.day_index === change.toDayIndex && row.block === change.toBlock
      : change.kind === "replace" ? row.candidate_id === change.replacementCandidateId : false
  )).map(safetyItem).sort((a, b) => a.id.localeCompare(b.id));
  const expectedState = { trip, item: safetyItem(item), destination, venue: { id: venue.id, name: venue.name }, replacement, privateReservation };
  return { fingerprint: hashNormalizedJson(expectedState), expectedState, impact };
}
const snapshot = tripAgentChangeSnapshot;

function replay(action: TripAgentAction) {
  if ((action.operation === "vote" || action.operation === "decide") && action.status === "executing") return toolFailure("action_in_progress");
  if ((action.operation === "vote" || action.operation === "decide") && ["awaiting_vote", "succeeded", "rejected", "cancelled"].includes(action.status)
    && !settlementSchema.safeParse(action.result?.settlement).success) return toolFailure("database_unavailable", { retryable: false });
  return actionResult(action);
}

async function proposalCommand(context: TripAgentToolContext, operation: "vote" | "decide", input: unknown, overrides: Partial<TripAgentChangeDependencies>) {
  const parsed = (operation === "vote" ? voteOnTripChangeInputSchema : decideTripChangeInputSchema).safeParse(input);
  if (!parsed.success) return toolFailure("invalid_input");
  const dependencies = { ...defaults, ...overrides };
  let action: TripAgentAction | undefined;
  try {
    const current = await currentAuthority(context, parsed.data);
    const authority = evaluateTripAgentAuthority({ ...current.authority, operation });
    if (authority.decision !== "allowed") refuse(authority.reason);
    const begun = await beginAction(current.context, { operation, input: parsed.data, travelerId: current.traveler.id, authorityDecision: "allowed" });
    if (!begun.ok) return begun;
    action = begun.data.action;
    if (!["received", "executing"].includes(action.status)) return replay(action);
    let proposal: ProposalRow;
    if (action.status === "executing") {
      // Preparation already committed this command's vote. Re-read inputs but
      // never cast it again: another voter may have changed it in the meantime.
      const read = await context.db.from("plan_proposals").select("*")
        .eq("id", action.proposal_id).eq("trip_id", context.connection.tripId).maybeSingle();
      if (read.error || !read.data) refuse("database_unavailable");
      proposal = read.data as ProposalRow;
    } else {
      const prepared = await context.db.rpc("prepare_trip_agent_proposal_action", {
      p_action_id: action.id, p_connection_id: context.connection.id, p_trip_id: context.connection.tripId,
      p_actor_digest: current.actorDigest, p_group_digest: current.groupDigest,
    });
    if (prepared.error) throw prepared.error;
    if (prepared.data?.code) refuse(prepared.data.code);
    if (!prepared.data?.action) refuse("database_unavailable");
    action = prepared.data.action as TripAgentAction;
    if (!prepared.data.proposal) return replay(action);
      proposal = prepared.data.proposal as ProposalRow;
    }
    await dependencies.settleProposal(context.db, {
      proposal, actorId: current.traveler.id,
      ...("decision" in parsed.data ? { force: parsed.data.decision } : {}),
      gateway: { actionId: action.id, connectionId: context.connection.id, tripId: context.connection.tripId,
        actorDigest: current.actorDigest, groupDigest: current.groupDigest },
    });
    // Final settlement saved its exact verdict alongside the canonical write.
    // Return only that durable snapshot, without a second result write or tally.
    const saved = await readAction(context, action.id, action.external_actor_digest);
    if (!saved || ["received", "executing"].includes(saved.status) || !settlementSchema.safeParse(saved.result?.settlement).success) refuse("database_unavailable");
    return replay(saved);
  } catch (error) {
    const code = failureCode(error);
    if (action) {
      try {
        const saved = await readAction(context, action.id, action.external_actor_digest);
        if (saved && !["received", "executing"].includes(saved.status)) return replay(saved);
        // An ambiguous internal DB response is recovered by rereading durable
        // state. It never becomes unknown or replays a canonical mutation.
        if (saved && code !== "database_unavailable") await writeAction(context, saved, saved.status, {
          status: "failed", error_code: code, updated_at: dependencies.now().toISOString(),
        });
      } catch { /* A durable in-flight action must not be reset by a retry. */ }
    }
    return toolFailure(code, action ? { retryable: false } : {});
  }
}

export function voteOnTripChange(context: TripAgentToolContext, input: unknown, overrides: Partial<TripAgentChangeDependencies> = {}) {
  return proposalCommand(context, "vote", input, overrides);
}
export function decideTripChange(context: TripAgentToolContext, input: unknown, overrides: Partial<TripAgentChangeDependencies> = {}) {
  return proposalCommand(context, "decide", input, overrides);
}

async function finishReservationPreparation(context: TripAgentToolContext, action: TripAgentAction, at: Date) {
  const expired = !action.confirmation_expires_at || Date.parse(action.confirmation_expires_at) <= at.getTime();
  try {
    return replay(await writeAction(context, action, "executing", {
      status: expired ? "expired" : "awaiting_confirmation",
      result: { status: expired ? "expired" : "awaiting_confirmation" },
      ...(expired ? { error_code: "preview_expired" } : {}),
      confirmation_expires_at: expired ? null : action.confirmation_expires_at,
      updated_at: at.toISOString(),
    }));
  } catch {
    // Internal-only preparation can recover a lost finalization response by
    // reading its durable state; it never creates an external booking attempt.
    const latest = await readAction(context, action.id, action.external_actor_digest);
    if (latest && latest.status !== "executing") return replay(latest);
    refuse("database_unavailable");
  }
}

export async function previewTripChange(context: TripAgentToolContext, input: unknown, overrides: Partial<TripAgentChangeDependencies> = {}): Promise<TripAgentToolResult<unknown>> {
  const parsed = previewTripChangeInputSchema.safeParse(input);
  if (!parsed.success) return toolFailure("invalid_input");
  const dependencies = { ...defaults, ...overrides };
  let action: TripAgentAction | undefined;
  try {
    const current = await currentAuthority(context, parsed.data);
    const previewAuthority = evaluateTripAgentAuthority({ ...current.authority, operation: "preview_change", changeKind: parsed.data.kind });
    if (previewAuthority.decision === "denied") refuse(previewAuthority.reason);
    const decision = evaluateTripAgentAuthority({ ...current.authority, operation: "commit_change", changeKind: parsed.data.kind });
    if (decision.decision === "denied") refuse(decision.reason);
    const begun = await beginAction(current.context, { operation: "preview_change", input: parsed.data, travelerId: current.traveler.id, authorityDecision: decision.decision });
    if (!begun.ok) return begun;
    action = begun.data.action;
    if (begun.data.replayed && action.status !== "received") return replay(action);
    const change = tripChangeSchema.safeParse(action.normalized_request);
    if (!change.success) refuse("invalid_input");
    const state = await snapshot(context, change.data);
    const at = dependencies.now();
    const preview: ActionPreview = { kind: parsed.data.kind, impact: state.impact, authority: decision.decision, expiresAt: new Date(at.getTime() + 10 * 60_000).toISOString() };
    return replay(await finalizePreview(context, action, { status: "previewed", preview, fingerprint: state.fingerprint }));
  } catch (error) {
    const code = failureCode(error);
    if (action) {
      try { return replay(await finalizePreview(context, action, { status: code === "database_unavailable" ? "failed" : "refused", errorCode: code })); } catch { /* no success without durable state */ }
    }
    return toolFailure(code, action ? { retryable: false } : {});
  }
}

export async function commitTripChange(context: TripAgentToolContext, input: unknown, overrides: Partial<TripAgentChangeDependencies> = {}): Promise<TripAgentToolResult<unknown>> {
  const parsed = commitTripChangeInputSchema.safeParse(input);
  if (!parsed.success) return toolFailure("invalid_input");
  const dependencies = { ...defaults, ...overrides };
  let claimed: TripAgentAction | undefined;
  let mayHaveWritten = false;
  let proposalId: string | undefined;
  try {
    const current = await currentAuthority(context, parsed.data);
    const action = await readAction(context, parsed.data.actionId, current.actorDigest);
    if (!action || action.operation !== "preview_change") refuse("action_not_found");
    if (action.mapped_traveler_id !== current.traveler.id) refuse("actor_changed");
    const change = tripChangeSchema.safeParse(action.normalized_request);
    if (!change.success) refuse("invalid_input");
    const decision = evaluateTripAgentAuthority({ ...current.authority, operation: "commit_change", changeKind: change.data.kind });
    if (decision.decision === "denied") refuse(decision.reason);
    if (action.status === "executing" && change.data.kind === "reservation_prepare") {
      mayHaveWritten = true;
      return await finishReservationPreparation(context, action, dependencies.now());
    }
    if (action.status !== "previewed") return replay(action);
    const at = dependencies.now();
    if (!action.confirmation_expires_at || Date.parse(action.confirmation_expires_at) <= at.getTime()) refuse("preview_expired");
    if (decision.decision === "requires_organizer_confirmation" && change.data.kind !== "reservation_prepare") refuse("organizer_confirmation_required");
    const state = await snapshot(context, change.data);
    if (state.fingerprint !== action.plan_fingerprint) refuse("plan_changed");
    // Mark uncertainty before the request: a lost response may hide a committed claim.
    mayHaveWritten = true;
    const claim = await context.db.rpc("claim_trip_agent_action", {
      p_action_id: action.id, p_connection_id: context.connection.id, p_trip_id: context.connection.tripId,
      p_actor_digest: current.actorDigest, p_group_digest: current.groupDigest,
      p_expected_fingerprint: state.fingerprint, p_now: at.toISOString(),
      p_expected_is_organizer: current.traveler.is_organizer,
      p_expected_state: state.expectedState,
    });
    if (claim.error) throw claim.error;
    const claimRow = Array.isArray(claim.data) ? claim.data[0] as { action: TripAgentAction; is_organizer: boolean; authority_policy: unknown } | undefined : undefined;
    // The authoritative database clock may have expired the preview after the
    // application precheck. Return that durable outcome without any mutation.
    if (claimRow && claimRow.action.status !== "executing") return replay(claimRow.action);
    claimed = claimRow?.action;
    if (!claimed) {
      const latest = await readAction(context, action.id, current.actorDigest);
      if (latest && latest.status !== "previewed") return replay(latest);
      refuse("plan_changed");
    }
    if (change.data.kind === "reservation_prepare") {
      return await finishReservationPreparation(context, claimed, at);
    }
    const changeRequest = change.data;
    proposalId = changeRequest.kind === "suggest"
      ? await dependencies.createSuggestionProposal(context.db, { tripId: context.connection.tripId, proposedBy: current.traveler.id, text: changeRequest.text, expectedState: state.expectedState })
      : await dependencies.createPlanProposal(context.db, {
        tripId: context.connection.tripId, itemId: changeRequest.itemId, proposedBy: current.traveler.id, kind: changeRequest.kind,
        toDayIndex: changeRequest.kind === "move" ? changeRequest.toDayIndex : null,
        toBlock: changeRequest.kind === "move" ? changeRequest.toBlock : null,
        toCandidateId: changeRequest.kind === "replace" ? changeRequest.replacementCandidateId : null,
        note: changeRequest.kind === "remove" ? changeRequest.reason ?? "" : changeRequest.note ?? "",
        expectedState: state.expectedState,
      });
    // Both canonical create RPCs already insert the proposer's yes vote once.
    // Record the ID before settling for recovery if a later call is uncertain.
    await writeAction(context, claimed, "executing", { status: "executing", proposal_id: proposalId, canonical_reference: { kind: "plan_proposal", id: proposalId }, updated_at: at.toISOString() });
    const proposalRead = await context.db.from("plan_proposals")
      .select("id, trip_id, item_id, proposed_by, kind, from_day_index, from_block, to_day_index, to_block, to_candidate_id, suggestion_text, note, status")
      .eq("id", proposalId).eq("trip_id", context.connection.tripId).maybeSingle();
    if (proposalRead.error || !proposalRead.data) refuse("database_unavailable");
    const settled = await dependencies.settleProposal(context.db, {
      proposal: proposalRead.data as ProposalRow, actorId: current.traveler.id,
      ...(claimRow?.is_organizer && changeRequest.kind !== "suggest" ? { force: "approve" as const } : {}),
    });
    const status = { open: "awaiting_vote", applied: "succeeded", rejected: "rejected", cancelled: "cancelled" }[settled.status] as TripAgentAction["status"];
    const saved = await writeAction(context, claimed, "executing", {
      status, proposal_id: proposalId, canonical_reference: { kind: "plan_proposal", id: proposalId },
      result: { status, proposalId }, ...(status === "cancelled" ? { error_code: settled.reasonCode } : {}),
      confirmation_expires_at: null,
      executed_at: at.toISOString(), updated_at: at.toISOString(),
    });
    return replay(saved);
  } catch (error) {
    const code = failureCode(error);
    if (claimed && claimed.normalized_request.kind !== "reservation_prepare") {
      // The operation may already have committed. Unknown is terminal for
      // automatic execution, even when recording the failure also fails.
      try { await writeAction(context, claimed, "executing", {
        status: !proposalId && code !== "database_unavailable" ? "refused" : "unknown", error_code: code,
        confirmation_expires_at: null,
        ...(proposalId ? { proposal_id: proposalId, canonical_reference: { kind: "plan_proposal" as const, id: proposalId } } : {}),
        updated_at: dependencies.now().toISOString(),
      }); } catch { /* Leave executing: never reset to previewed. */ }
    }
    return toolFailure(code, mayHaveWritten ? { retryable: false } : {});
  }
}
