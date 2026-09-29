import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { digestExternalIdentity } from "./trip-agent-auth";
import {
  previewTripChangeInputSchema, voteOnTripChangeInputSchema, decideTripChangeInputSchema, toolFailure, toolSuccess,
  type TripAgentActionStatus, type TripAgentAuthorityDecision,
  type TripAgentChange, type TripAgentToolResult,
} from "./trip-agent-contracts";
import type { TripAgentToolContext } from "./trip-agent-tools";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
/** Canonical object ordering is recursive; array order is meaningful. */
export function stableJson(value: Json): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}
export function hashNormalizedJson(value: Json): string {
  return createHash("sha256").update(stableJson(value)).digest("hex");
}

export const actionPreviewSchema = z.object({
  kind: z.enum(["move", "remove", "replace", "suggest", "reservation_prepare"]),
  impact: z.string(),
  authority: z.enum(["allowed", "requires_organizer_confirmation", "denied"]),
  expiresAt: z.string().datetime(),
}).strict();
export type ActionPreview = z.infer<typeof actionPreviewSchema>;
export const settlementSchema = z.object({
  status: z.enum(["open", "applied", "rejected", "cancelled"]),
  reasonCode: z.enum(["awaiting_vote", "approved", "rejected", "proposal_stale", "reservation_locked", "destination_occupied"]),
  yes: z.number().int().min(0).max(1_000_000), no: z.number().int().min(0).max(1_000_000),
  needed: z.number().int().min(0).max(1_000_000), travelerCount: z.number().int().min(0).max(1_000_000),
}).strict();
export type ActionSettlement = z.infer<typeof settlementSchema>;
type ActionRequest = TripAgentChange | { kind?: never; actionId: string; vote: "up" | "down" }
  | { kind?: never; actionId: string; decision: "approve" | "reject" };
export type TripAgentAction = {
  id: string; connection_id: string; trip_id: string; lifecycle_generation: number; external_actor_digest: string;
  mapped_traveler_id: string | null; operation: string; normalized_request: ActionRequest;
  authority_decision: TripAgentAuthorityDecision; status: TripAgentActionStatus;
  preview: ActionPreview | null; plan_fingerprint: string | null;
  confirmation_expires_at: string | null; proposal_id: string | null;
  error_code: string | null;
  result?: { settlement?: unknown } | null;
};
export const ACTION_COLUMNS = "id, connection_id, trip_id, lifecycle_generation, external_actor_digest, mapped_traveler_id, operation, normalized_request, authority_decision, status, preview, plan_fingerprint, confirmation_expires_at, proposal_id, error_code, result";

export function groupAndActorDigests(context: TripAgentToolContext, input: { externalGroupId: string; externalParticipantId: string }) {
  try {
    const groupDigest = digestExternalIdentity(context.connection.id, context.connection.lifecycleGeneration, input.externalGroupId);
    if (!context.connection.whatsappGroupDigest) return toolFailure("group_not_registered");
    if (groupDigest !== context.connection.whatsappGroupDigest) return toolFailure("group_mismatch");
    return toolSuccess({ groupDigest, actorDigest: digestExternalIdentity(context.connection.id, context.connection.lifecycleGeneration, input.externalParticipantId) });
  } catch { return toolFailure("configuration_unavailable"); }
}

/** Only the strict operation-specific schema can cross the JSON persistence boundary. */
export async function beginAction(context: TripAgentToolContext, args: {
  operation: "preview_change" | "vote" | "decide"; input: unknown; travelerId: string; authorityDecision: TripAgentAuthorityDecision;
}): Promise<TripAgentToolResult<{ action: TripAgentAction; replayed: boolean }>> {
  const schema = args.operation === "vote" ? voteOnTripChangeInputSchema : args.operation === "decide" ? decideTripChangeInputSchema : previewTripChangeInputSchema;
  const parsed = schema.safeParse(args.input);
  if (!parsed.success) return toolFailure("invalid_input");
  const { requestId, externalGroupId, externalParticipantId, ...change } = parsed.data;
  const idempotencyKey = requestId.toLowerCase();
  const digests = groupAndActorDigests(context, { externalGroupId, externalParticipantId });
  if (!digests.ok) return digests;
  const normalized = JSON.parse(stableJson(change)) as ActionRequest;
  try {
    const inserted = await context.db.from("trip_agent_actions").insert({
      connection_id: context.connection.id, trip_id: context.connection.tripId,
      lifecycle_generation: context.connection.lifecycleGeneration,
      idempotency_key: idempotencyKey, external_actor_digest: digests.data.actorDigest,
      mapped_traveler_id: args.travelerId, operation: args.operation,
      normalized_request: normalized, authority_decision: args.authorityDecision,
      status: "received", announcement_status: "pending",
    }).select(ACTION_COLUMNS).single();
    if (!inserted.error && inserted.data) return toolSuccess({ action: inserted.data as TripAgentAction, replayed: false });
    if (inserted.error?.code !== "23505") return toolFailure("database_unavailable", { retryable: false });
    const existing = await context.db.from("trip_agent_actions").select(ACTION_COLUMNS)
      .eq("connection_id", context.connection.id).eq("trip_id", context.connection.tripId)
      .eq("lifecycle_generation", context.connection.lifecycleGeneration)
      .eq("idempotency_key", idempotencyKey).maybeSingle();
    if (existing.error || !existing.data) return toolFailure("database_unavailable", { retryable: false });
    const action = existing.data as TripAgentAction;
    if (action.operation !== args.operation || action.external_actor_digest !== digests.data.actorDigest
      || action.mapped_traveler_id !== args.travelerId
      || stableJson(action.normalized_request as Json) !== stableJson(normalized as Json)) return toolFailure("idempotency_conflict");
    return toolSuccess({ action, replayed: true });
  } catch { return toolFailure("database_unavailable", { retryable: false }); }
}

/** Never spread stored result JSON: a replay has the same bounded public shape. */
export function actionResult(action: TripAgentAction) {
  if (action.error_code || action.status === "failed" || action.status === "unknown") {
    return toolFailure(action.error_code ?? "database_unavailable", { retryable: false });
  }
  const preview = actionPreviewSchema.safeParse(action.preview);
  const settlement = settlementSchema.safeParse(action.result?.settlement);
  return toolSuccess({
    actionId: action.id, status: action.status,
    authority: action.authority_decision,
    ...(preview.success ? { impact: preview.data.impact } : {}),
    ...(action.confirmation_expires_at ? { expiresAt: action.confirmation_expires_at } : {}),
    ...(action.proposal_id ? { proposalId: action.proposal_id } : {}),
    ...(settlement.success ? { settlement: settlement.data } : {}),
  });
}

export async function readAction(context: TripAgentToolContext, actionId: string, actorDigest: string) {
  const read = await context.db.from("trip_agent_actions").select(ACTION_COLUMNS)
    .eq("id", actionId).eq("connection_id", context.connection.id).eq("trip_id", context.connection.tripId)
    .eq("lifecycle_generation", context.connection.lifecycleGeneration)
    .eq("external_actor_digest", actorDigest).maybeSingle();
  if (read.error) throw Error("database_unavailable");
  return read.data as TripAgentAction | null;
}

/** Every state write is compare-and-set; executing is never reset for a retry. */
export async function writeAction(context: TripAgentToolContext, action: TripAgentAction, from: TripAgentActionStatus, patch: {
  status: TripAgentActionStatus; preview?: ActionPreview; plan_fingerprint?: string;
  authority_decision?: TripAgentAuthorityDecision; confirmation_expires_at?: string | null;
  proposal_id?: string; canonical_reference?: { kind: "plan_proposal"; id: string };
  result?: { status: TripAgentActionStatus; proposalId?: string; settlement?: ActionSettlement }; error_code?: string;
  executed_at?: string; updated_at: string;
}) {
  const write = await context.db.rpc("write_trip_agent_action_state", {
    p_connection_id: context.connection.id,
    p_trip_id: context.connection.tripId,
    p_lifecycle_generation: context.connection.lifecycleGeneration,
    p_action_id: action.id,
    p_actor_digest: action.external_actor_digest,
    p_from_status: from,
    p_patch: patch,
  });
  if (write.error) throw Error("database_unavailable");
  const saved = Array.isArray(write.data) ? write.data[0] : null;
  if (!saved) throw Error("database_unavailable");
  return saved as TripAgentAction;
}

/** Database time starts the ten-minute clock only when a worker finalizes. */
export async function finalizePreview(context: TripAgentToolContext, action: TripAgentAction, result: {
  status: "previewed" | "refused" | "failed"; preview?: ActionPreview; fingerprint?: string; errorCode?: string;
}) {
  const response = await context.db.rpc("finalize_trip_agent_preview", {
    p_action_id: action.id, p_connection_id: context.connection.id, p_trip_id: context.connection.tripId,
    p_actor_digest: action.external_actor_digest, p_status: result.status,
    p_preview: result.preview ?? null, p_fingerprint: result.fingerprint ?? null, p_error_code: result.errorCode ?? null,
  });
  if (response.error) throw Error("database_unavailable");
  const saved = Array.isArray(response.data) ? response.data[0] as TripAgentAction | undefined : undefined;
  if (saved) return saved;
  const latest = await readAction(context, action.id, action.external_actor_digest);
  if (!latest || latest.status === "received") throw Error("database_unavailable");
  return latest;
}
