import { z } from "zod";

export const TRIP_AGENT_PROVIDERS = ["openclaw", "hermes"] as const;
export const tripAgentProviderSchema = z.enum(TRIP_AGENT_PROVIDERS);
export type TripAgentProvider = z.infer<typeof tripAgentProviderSchema>;

export const TRIP_AGENT_SCOPES = [
  "connector.setup",
  "trip.read",
  "trip.research",
  "trip.propose",
  "trip.modify",
  "trip.vote",
  "proactive.read",
  "announcement.write",
] as const;
export const tripAgentScopeSchema = z.enum(TRIP_AGENT_SCOPES);
export type TripAgentScope = z.infer<typeof tripAgentScopeSchema>;

export const TRIP_AGENT_OPERATIONS = [
  "register_group",
  "readiness",
  "activate",
  "read_context",
  "read_today",
  "search_options",
  "read_decisions",
  "preview_change",
  "commit_change",
  "vote",
  "decide",
  "report_announcement",
  "poll_proactive_events",
] as const;
export const tripAgentOperationSchema = z.enum(TRIP_AGENT_OPERATIONS);
export type TripAgentOperation = z.infer<typeof tripAgentOperationSchema>;

export const TRIP_AGENT_ACTION_STATUSES = [
  "received",
  "previewed",
  "executing",
  "succeeded",
  "awaiting_vote",
  "awaiting_confirmation",
  "rejected",
  "cancelled",
  "refused",
  "expired",
  "failed",
  "unknown",
] as const;
export const tripAgentActionStatusSchema = z.enum(TRIP_AGENT_ACTION_STATUSES);
export type TripAgentActionStatus = z.infer<typeof tripAgentActionStatusSchema>;

export const TRIP_AGENT_AUTHORITY_DECISIONS = [
  "allowed",
  "requires_organizer_confirmation",
  "denied",
] as const;
export const tripAgentAuthorityDecisionSchema = z.enum(TRIP_AGENT_AUTHORITY_DECISIONS);
export type TripAgentAuthorityDecision = z.infer<typeof tripAgentAuthorityDecisionSchema>;

export const authorityPolicySchema = z.object({
  travelerCanAddSuggestion: z.boolean().default(true),
  travelerCanProposeChange: z.boolean().default(true),
}).strict();
export type AuthorityPolicy = z.infer<typeof authorityPolicySchema>;

const requestEnvelopeSchema = z.object({
  requestId: z.string().uuid(),
  externalGroupId: z.string().trim().min(1),
}).strict();

const optionalParticipantEnvelopeSchema = requestEnvelopeSchema.extend({
  externalParticipantId: z.string().trim().min(1).optional(),
});

const participantEnvelopeSchema = requestEnvelopeSchema.extend({
  externalParticipantId: z.string().trim().min(1),
});

const textSchema = z.string().trim().min(1).max(240);
const itemIdSchema = z.string().uuid();

export const registerTripGroupInputSchema = requestEnvelopeSchema.extend({
  groupLabel: textSchema,
  participants: z.array(z.object({
    externalParticipantId: z.string().trim().min(1),
    displayNameHint: textSchema.optional(),
  }).strict()).max(100),
}).strict();
export type RegisterTripGroupInput = z.infer<typeof registerTripGroupInputSchema>;

export const getTripAgentReadinessInputSchema = requestEnvelopeSchema.strict();
export type GetTripAgentReadinessInput = z.infer<typeof getTripAgentReadinessInputSchema>;

export const activateTripAgentInputSchema = requestEnvelopeSchema.extend({
  privacyNoticeVersion: z.literal("v1"),
  deliveryReceiptId: z.string().trim().min(1).max(240),
}).strict();
export type ActivateTripAgentInput = z.infer<typeof activateTripAgentInputSchema>;

export const getTripContextInputSchema = optionalParticipantEnvelopeSchema.strict();
export type GetTripContextInput = z.infer<typeof getTripContextInputSchema>;

export const getTodayPlanInputSchema = optionalParticipantEnvelopeSchema.strict();
export type GetTodayPlanInput = z.infer<typeof getTodayPlanInputSchema>;

export const tripAgentRouteEndpointSchema = z.union([
  z.object({ itemId: itemIdSchema }).strict(),
  z.object({
    lat: z.number().finite().min(-90).max(90),
    lng: z.number().finite().min(-180).max(180),
    label: textSchema.optional(),
  }).strict(),
]);
export type TripAgentRouteEndpoint = z.infer<typeof tripAgentRouteEndpointSchema>;

export const searchTripOptionsInputSchema = z.discriminatedUnion("kind", [
  optionalParticipantEnvelopeSchema.extend({ kind: z.literal("place"), query: textSchema }).strict(),
  optionalParticipantEnvelopeSchema.extend({ kind: z.literal("restaurant"), query: textSchema }).strict(),
  optionalParticipantEnvelopeSchema.extend({ kind: z.literal("parking"), location: textSchema }).strict(),
  optionalParticipantEnvelopeSchema.extend({
    kind: z.literal("route"),
    origin: tripAgentRouteEndpointSchema,
    destination: tripAgentRouteEndpointSchema,
  }).strict(),
]);
export type SearchTripOptionsInput = z.infer<typeof searchTripOptionsInputSchema>;

export const getPendingTripDecisionsInputSchema = optionalParticipantEnvelopeSchema.strict();
export type GetPendingTripDecisionsInput = z.infer<typeof getPendingTripDecisionsInputSchema>;

export const TRIP_AGENT_CHANGE_KINDS = [
  "move",
  "remove",
  "replace",
  "suggest",
  "reservation_prepare",
] as const;

const moveTripChangeSchema = z.object({
  kind: z.literal("move"),
  itemId: itemIdSchema,
  toDayIndex: z.number().int().min(0),
  toBlock: z.enum(["morning", "lunch", "afternoon", "dinner", "evening"]),
  note: textSchema.optional(),
}).strict();
const removeTripChangeSchema = z.object({
  kind: z.literal("remove"),
  itemId: itemIdSchema,
  reason: textSchema.optional(),
}).strict();
const replaceTripChangeSchema = z.object({
  kind: z.literal("replace"),
  itemId: itemIdSchema,
  replacementCandidateId: z.string().trim().min(1).max(240),
  note: textSchema.optional(),
}).strict();
const suggestTripChangeSchema = z.object({
  kind: z.literal("suggest"),
  text: textSchema,
}).strict();
const reservationPrepareTripChangeSchema = z.object({
  kind: z.literal("reservation_prepare"),
  itemId: itemIdSchema,
  partySize: z.number().int().min(1).max(30),
  requestedAt: z.string().datetime({ offset: true }),
}).strict();

export const tripChangeSchema = z.discriminatedUnion("kind", [
  moveTripChangeSchema,
  removeTripChangeSchema,
  replaceTripChangeSchema,
  suggestTripChangeSchema,
  reservationPrepareTripChangeSchema,
]);
export type TripAgentChange = z.infer<typeof tripChangeSchema>;

const participantTripChangeInputSchema = z.discriminatedUnion("kind", [
  participantEnvelopeSchema.extend(moveTripChangeSchema.shape).strict(),
  participantEnvelopeSchema.extend(removeTripChangeSchema.shape).strict(),
  participantEnvelopeSchema.extend(replaceTripChangeSchema.shape).strict(),
  participantEnvelopeSchema.extend(suggestTripChangeSchema.shape).strict(),
  participantEnvelopeSchema.extend(reservationPrepareTripChangeSchema.shape).strict(),
]);

export const previewTripChangeInputSchema = participantTripChangeInputSchema;
export type PreviewTripChangeInput = z.infer<typeof previewTripChangeInputSchema>;

// The preview action ID is the sole commit idempotency key.
export const commitTripChangeInputSchema = z.object({
  actionId: itemIdSchema,
  externalGroupId: z.string().trim().min(1),
  externalParticipantId: z.string().trim().min(1),
}).strict();
export type CommitTripChangeInput = z.infer<typeof commitTripChangeInputSchema>;

export const voteOnTripChangeInputSchema = participantEnvelopeSchema.extend({
  actionId: itemIdSchema,
  vote: z.enum(["up", "down"]),
}).strict();
export type VoteOnTripChangeInput = z.infer<typeof voteOnTripChangeInputSchema>;

export const decideTripChangeInputSchema = participantEnvelopeSchema.extend({
  actionId: itemIdSchema,
  decision: z.enum(["approve", "reject"]),
}).strict();
export type DecideTripChangeInput = z.infer<typeof decideTripChangeInputSchema>;

export const reportGroupAnnouncementInputSchema = requestEnvelopeSchema.extend({
  actionId: itemIdSchema,
  deliveryStatus: z.enum(["delivered", "failed"]),
  providerMessageId: z.string().trim().min(1).max(240).optional(),
}).strict();
export type ReportGroupAnnouncementInput = z.infer<typeof reportGroupAnnouncementInputSchema>;

export const pollProactiveEventsInputSchema = requestEnvelopeSchema.extend({
  acknowledgements: z.array(z.object({
    eventId: itemIdSchema,
    deliveryReceiptId: z.string().trim().min(1).max(240),
  }).strict()).max(20).optional(),
}).strict();
export type PollProactiveEventsInput = z.infer<typeof pollProactiveEventsInputSchema>;

/** Public errors are a closed vocabulary; diagnostics never cross this boundary. */
export const TRIP_AGENT_FAILURE_CATALOG = {
  rate_limited: { message: "Too many requests. Please try again later.", retryable: true },
  database_unavailable: { message: "The service is temporarily unavailable.", retryable: true },
  upstream_unavailable: { message: "The research service is temporarily unavailable.", retryable: true },
  invalid_input: { message: "The request is invalid.", retryable: false },
  configuration_unavailable: { message: "The connection configuration is unavailable.", retryable: false },
  connection_unavailable: { message: "The connection is unavailable.", retryable: false },
  connection_not_found: { message: "The connection is unavailable.", retryable: false },
  connection_not_active: { message: "The connection is not active.", retryable: false },
  connection_not_paired: { message: "The connection is not ready for setup.", retryable: false },
  connection_changed: { message: "The connection has changed.", retryable: false },
  group_not_registered: { message: "The group has not been registered.", retryable: false },
  group_mismatch: { message: "The group does not match this connection.", retryable: false },
  missing_scope: { message: "The connection does not have the required permission.", retryable: false },
  confirmed_mapping_required: { message: "A confirmed participant mapping is required.", retryable: false },
  automated_travelers_cannot_vote: { message: "Automated participants cannot perform this action.", retryable: false },
  organizer_confirmation_required: { message: "Private organizer confirmation is required.", retryable: false },
  organizer_mapping_required: { message: "A confirmed organizer mapping is required.", retryable: false },
  organizer_required: { message: "Only the organizer can perform this action.", retryable: false },
  organizer_unavailable: { message: "The organizer is unavailable.", retryable: false },
  not_ready: { message: "The connection is not ready for activation.", retryable: false },
  authority_changed: { message: "Permission for this action has changed.", retryable: false },
  actor_changed: { message: "The participant mapping has changed.", retryable: false },
  preview_expired: { message: "The action preview has expired.", retryable: false },
  confirmation_expired: { message: "The confirmation has expired.", retryable: false },
  confirmation_used: { message: "The confirmation is no longer available.", retryable: false },
  plan_changed: { message: "The trip plan has changed.", retryable: false },
  proposal_stale: { message: "The proposal is no longer current.", retryable: false },
  reservation_locked: { message: "A reservation prevents this change.", retryable: false },
  reservation_attempt_active: { message: "A reservation attempt is already active.", retryable: false },
  booking_route_unavailable: { message: "A booking handoff is unavailable.", retryable: false },
  destination_occupied: { message: "The requested destination is already occupied.", retryable: false },
  duplicate_suggestion: { message: "This suggestion already exists.", retryable: false },
  proposal_already_decided: { message: "The proposal has already been decided.", retryable: false },
  action_not_found: { message: "The action is unavailable.", retryable: false },
  action_in_progress: { message: "The action is already in progress.", retryable: false },
  action_not_confirmable: { message: "The action cannot be confirmed.", retryable: false },
  action_not_announceable: { message: "The action cannot be announced.", retryable: false },
  announcement_conflict: { message: "The announcement conflicts with an existing receipt.", retryable: false },
  idempotency_conflict: { message: "The request conflicts with an existing command.", retryable: false },
} as const satisfies Record<string, { message: string; retryable: boolean }>;
export type TripAgentFailureCode = keyof typeof TRIP_AGENT_FAILURE_CATALOG;

export type TripAgentToolSuccess<T> = { ok: true; data: T };
export type TripAgentToolFailure = {
  ok: false;
  error: { code: TripAgentFailureCode; message: string; retryable: boolean; retryAfter?: number };
};
export type TripAgentToolResult<T> = TripAgentToolSuccess<T> | TripAgentToolFailure;

export function toolSuccess<T>(data: T): TripAgentToolSuccess<T> {
  return { ok: true, data };
}

export function toolFailure(
  code: string,
  options: { retryable?: false; retryAfter?: number } = {},
): TripAgentToolFailure {
  const publicCode = Object.hasOwn(TRIP_AGENT_FAILURE_CATALOG, code)
    ? code as TripAgentFailureCode : "database_unavailable";
  const entry = TRIP_AGENT_FAILURE_CATALOG[publicCode];
  const retryAfter = options.retryAfter;
  return {
    ok: false,
    error: {
      code: publicCode,
      message: entry.message,
      retryable: entry.retryable && options.retryable !== false,
      ...(Number.isInteger(retryAfter) && retryAfter! > 0 && retryAfter! <= 86_400 ? { retryAfter } : {}),
    },
  };
}
