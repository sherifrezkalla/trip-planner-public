import "server-only";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { ACTION_COLUMNS, type TripAgentAction } from "./trip-agent-actions";
import { tripChangeSchema } from "./trip-agent-contracts";
import { tripAgentChangeSnapshot } from "./trip-agent-change-service";

// A successful organizer response is an allowlist, never an action/attempt row.
const responseSchema = z.object({
  action: z.object({ id: z.string().uuid(), status: z.enum(["succeeded", "rejected"]) }),
  attempt: z.object({ id: z.string().uuid(), state: z.literal("awaiting_approval") }).optional(),
  item: z.object({ id: z.string().uuid(), venueName: z.string() }).optional(),
});
export type ConfirmationResponse = z.infer<typeof responseSchema>;
const codes = new Set(["invalid_input", "action_not_found", "organizer_required", "connection_unavailable",
  "confirmation_used", "confirmation_expired", "action_not_confirmable", "missing_scope", "proposal_stale",
  "reservation_locked", "organizer_unavailable", "booking_route_unavailable", "plan_changed",
  "reservation_attempt_active", "database_unavailable"]);
function code(value: unknown) { return typeof value === "string" && codes.has(value) ? value : "database_unavailable"; }

export async function confirmTripAgentAction(db: SupabaseClient, args: {
  tripId: string; actorId: string; actionId: string; decision: "confirm" | "reject";
}): Promise<ConfirmationResponse | { code: string }> {
  const read = async () => {
    const connection = await db.from("trip_agent_connections")
      .select("id, lifecycle_generation")
      .eq("trip_id", args.tripId)
      .maybeSingle();
    if (connection.error) throw Error("database_unavailable");
    if (!connection.data) return null;
    const result = await db.from("trip_agent_actions").select(ACTION_COLUMNS)
      .eq("id", args.actionId)
      .eq("connection_id", connection.data.id)
      .eq("trip_id", args.tripId)
      .eq("lifecycle_generation", connection.data.lifecycle_generation)
      .maybeSingle();
    if (result.error) throw Error("database_unavailable");
    return result.data as TripAgentAction | null;
  };
  try {
    const action = await read();
    if (!action) return { code: "action_not_found" };
    if (action.status !== "awaiting_confirmation") return { code: "confirmation_used" };
    const change = tripChangeSchema.safeParse(action.normalized_request);
    if (action.operation !== "preview_change" || !change.success || change.data.kind !== "reservation_prepare") return { code: "action_not_confirmable" };
    let state: Awaited<ReturnType<typeof tripAgentChangeSnapshot>> | null = null;
    let snapshotError: string | null = null;
    if (args.decision === "confirm") {
      try {
        state = await tripAgentChangeSnapshot({ db, connection: {
          id: action.connection_id,
          tripId: args.tripId,
          lifecycleGeneration: action.lifecycle_generation,
          status: "active",
          grantedScopes: [],
        } }, change.data);
        if (state.fingerprint !== action.plan_fingerprint) snapshotError = "plan_changed";
      } catch (error) { snapshotError = code(error instanceof Error ? error.message : null); }
    }
    let result;
    try {
      result = await db.rpc("confirm_trip_agent_action", {
        p_action_id: args.actionId, p_trip_id: args.tripId, p_actor_id: args.actorId, p_decision: args.decision,
        p_expected_fingerprint: state?.fingerprint ?? null, p_expected_state: state?.expectedState ?? null,
        p_snapshot_error: snapshotError,
      });
      if (result.error) throw Error("database_unavailable");
    } catch {
      // Internal DB effects are atomic and rereadable. Do not call the RPC a
      // second time, attach another action's attempt, or set unknown.
      const saved = await read();
      if (saved?.status === "expired") return { code: "confirmation_expired" };
      if (saved && ["succeeded", "rejected"].includes(saved.status)) {
        const recovered = responseSchema.safeParse(saved.result);
        if (recovered.success && recovered.data.action.id === args.actionId && recovered.data.action.status === saved.status) return recovered.data;
      }
      return { code: "database_unavailable" };
    }
    if (result.data?.code) return { code: code(result.data.code) };
    const safe = responseSchema.safeParse(result.data);
    return safe.success && safe.data.action.id === args.actionId ? safe.data : { code: "database_unavailable" };
  } catch { return { code: "database_unavailable" }; }
}
