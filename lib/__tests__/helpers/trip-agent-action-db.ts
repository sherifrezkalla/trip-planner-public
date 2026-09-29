import { vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { digestExternalIdentity } from "@/lib/trip-agent-auth";
import type { TripAgentToolContext } from "@/lib/trip-agent-tools";

export const ids = { trip: "10000000-0000-4000-8000-000000000001", connection: "20000000-0000-4000-8000-000000000001", actor: "30000000-0000-4000-8000-000000000001", item: "40000000-0000-4000-8000-000000000001", action: "50000000-0000-4000-8000-000000000001", proposal: "60000000-0000-4000-8000-000000000001", request: "70000000-0000-4000-8000-000000000001" };
export const envelope = { requestId: ids.request, externalGroupId: "raw-group", externalParticipantId: "raw-person" };
export const move = { ...envelope, kind: "move" as const, itemId: ids.item, toDayIndex: 1, toBlock: "dinner" as const };
export const now = new Date("2026-09-01T10:00:00Z");
type Row = Record<string, unknown>;

// Stateful fake: filters, uniqueness and CAS writes execute at await time,
// so simultaneous commits exercise the winner/loser application paths.
export function actionWorld() {
  const rows: Record<string, Row[]> = {
    trip_agent_connections: [{ id: ids.connection, trip_id: ids.trip, lifecycle_generation: 1, status: "active", granted_scopes: ["trip.propose", "trip.modify"], whatsapp_group_digest: digestExternalIdentity(ids.connection, 1, envelope.externalGroupId), authority_policy: { travelerCanAddSuggestion: true, travelerCanProposeChange: true } }],
    trip_agent_participant_mappings: [{ connection_id: ids.connection, trip_id: ids.trip, lifecycle_generation: 1, status: "confirmed", external_participant_digest: digestExternalIdentity(ids.connection, 1, envelope.externalParticipantId), traveler_id: ids.actor }],
    travelers: [{ id: ids.actor, trip_id: ids.trip, is_bot: false, is_organizer: true, display_name: " Private Organizer " }],
    trips: [{ id: ids.trip, start_date: "2026-09-01", end_date: "2026-09-07" }],
    itinerary_items: [{ id: ids.item, trip_id: ids.trip, status: "planned", is_locked: false, reservation_status: "none", reservation_at: null, day_index: 0, block: "lunch", candidate_id: "venue", booking_url: "https://booking.test/private", position: 0 }],
    venue_candidates: [{ id: "venue", trip_id: ids.trip, name: "Museum", maps_url: "https://maps.test/venue" }, { id: "replacement", trip_id: ids.trip, name: "Gallery", maps_url: "https://maps.test/gallery" }],
    trip_agent_actions: [],
    plan_proposals: [{ id: ids.proposal, trip_id: ids.trip, item_id: ids.item, proposed_by: ids.actor, kind: "move", status: "open", from_day_index: 0, from_block: "lunch", to_day_index: 1, to_block: "dinner", to_candidate_id: null, note: null }],
  };
  let failure: ((table: string, operation: string, payload?: Row) => boolean) | undefined;
  const writes: { table: string; operation: string; payload: Row }[] = [];
  const rpc = vi.fn(async (fn: string, p: Row): Promise<{ data: unknown; error: { code?: string; message?: string } | null }> => {
    if (fn === "consume_trip_agent_rate_limit") return { data: [{ allowed: true }], error: null };
    const connection = rows.trip_agent_connections.find(r => r.id === p.p_connection_id && r.trip_id === p.p_trip_id);
    const action = rows.trip_agent_actions.find(r => r.id === p.p_action_id && r.connection_id === p.p_connection_id && r.trip_id === p.p_trip_id && r.lifecycle_generation === connection?.lifecycle_generation && r.external_actor_digest === p.p_actor_digest);
    if (fn === "finalize_trip_agent_preview") {
      if (!action || action.status !== "received") return { data: [], error: null };
      const expires = p.p_status === "previewed" ? new Date(now.getTime() + 600_000).toISOString() : null;
      Object.assign(action, { status: p.p_status, preview: p.p_preview ? { ...(p.p_preview as Row), expiresAt: expires } : null,
        confirmation_expires_at: expires, plan_fingerprint: p.p_fingerprint, error_code: p.p_error_code });
      return { data: [{ ...action }], error: null };
    }
    if (fn === "write_trip_agent_action_state") {
      const patch = p.p_patch as Row;
      writes.push({ table: "trip_agent_actions", operation: "update", payload: patch });
      if (failure?.("trip_agent_actions", "update", patch)) {
        return { data: null, error: { message: "PRIVATE DB credential" } };
      }
      if (!connection
        || connection.lifecycle_generation !== p.p_lifecycle_generation
        || !action
        || action.status !== p.p_from_status) return { data: [], error: null };
      Object.assign(action, patch);
      return { data: [{ ...action }], error: null };
    }
    if (fn !== "claim_trip_agent_action") throw Error(`Unexpected RPC: ${fn}`);
    if (!action || action.status !== "previewed") return { data: [], error: null };
    if (!rows.trip_agent_participant_mappings.some(m => m.lifecycle_generation === connection?.lifecycle_generation && m.status === "confirmed" && m.traveler_id === action.mapped_traveler_id && m.external_participant_digest === p.p_actor_digest)) return { data: [], error: null };
    action.status = "executing";
    action.confirmation_expires_at = (action.normalized_request as Row).kind === "reservation_prepare" ? new Date(now.getTime() + 900_000).toISOString() : null;
    return { data: [{ action: { ...action }, is_organizer: rows.travelers[0].is_organizer, authority_policy: rows.trip_agent_connections[0].authority_policy }], error: null };
  });
  const db = { rpc, from(table: string) {
    let operation = "read"; let payload: Row = {}; let single = false;
    const filters: ((row: Row) => boolean)[] = [];
    const query = {
      select() { return query; },
      eq(k: string, v: unknown) { filters.push(r => r[k] === v); return query; },
      neq(k: string, v: unknown) { filters.push(r => r[k] !== v); return query; },
      insert(p: Row) { operation = "insert"; payload = p; return query; },
      update(p: Row) { operation = "update"; payload = p; return query; },
      maybeSingle() { single = true; return query; }, single() { single = true; return query; },
      then(resolve: (v: unknown) => unknown) {
        if (operation !== "read") writes.push({ table, operation, payload });
        if (failure?.(table, operation, payload)) return Promise.resolve({ data: null, error: { message: "PRIVATE DB credential" } }).then(resolve);
        const collection = rows[table];
        if (!collection) throw Error(`Unexpected table: ${table}`);
        let matches = collection.filter(r => filters.every(f => f(r)));
        if (operation === "insert") {
          if (collection.some(r => r.connection_id === payload.connection_id && r.lifecycle_generation === payload.lifecycle_generation && r.idempotency_key === payload.idempotency_key)) return Promise.resolve({ data: null, error: { code: "23505" } }).then(resolve);
          const row = { id: ids.action, status: "received", preview: null, result: null, proposal_id: null, error_code: null, ...payload };
          collection.push(row); matches = [row];
        }
        if (operation === "update") matches.forEach(r => Object.assign(r, payload));
        return Promise.resolve({ data: single ? (matches[0] ? { ...matches[0] } : null) : matches.map(r => ({ ...r })), error: null }).then(resolve);
      },
    }; return query;
  } } as unknown as SupabaseClient;
  const context: TripAgentToolContext = { db, connection: { id: ids.connection, tripId: ids.trip, lifecycleGeneration: 1, status: "active", grantedScopes: ["trip.propose", "trip.modify"], whatsappGroupDigest: rows.trip_agent_connections[0].whatsapp_group_digest as string } };
  return { context, rows, writes, rpc, fail: (predicate: typeof failure) => { failure = predicate; } };
}
