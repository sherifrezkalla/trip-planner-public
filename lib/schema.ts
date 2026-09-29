import { z } from "zod";
import {
  MAX_RESERVATION_ARTIFACT_BYTES,
  RESERVATION_ARTIFACT_TYPES,
} from "./reservation-artifact-constants";
import { DEVICE_TRIP_LIMIT } from "./device-trips";
import {
  TRIP_AGENT_SCOPES,
  tripAgentProviderSchema,
  tripAgentScopeSchema,
} from "./trip-agent-contracts";

export const BLOCKS = ["morning", "lunch", "afternoon", "dinner", "evening"] as const;
export type Block = (typeof BLOCKS)[number];

export const INTERESTS = ["food", "history", "nature", "nightlife", "shopping", "art", "water", "active"] as const;
export type Interest = (typeof INTERESTS)[number];

export const itineraryPlanSchema = z.object({
  days: z
    .array(
      z.object({
        dayIndex: z.number().int().min(0),
        area: z.string().trim().min(1),
        blocks: z
          .array(
            z.object({
              block: z.enum(BLOCKS),
              candidateId: z.string().min(1),
              whyNote: z.string(),
              durationMin: z.number().int().min(30).max(480),
            }),
          )
          // One is the floor because dinner is the only required block (see
          // REQUIRED_BLOCKS in generate.ts): a day the group eats together is
          // the minimum useful day. Everything above that is optional, so a
          // rest day, a travel day, or a chill pace can produce a genuinely
          // light plan instead of four stops the group then has to fight.
          .min(1)
          .max(5),
      }),
    )
    .min(1),
});
export type ItineraryPlan = z.infer<typeof itineraryPlanSchema>;

export const swapBlockSchema = z.object({
  candidateId: z.string().min(1),
  whyNote: z.string(),
  durationMin: z.number().int().min(30).max(480),
});
export type SwapBlock = z.infer<typeof swapBlockSchema>;

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected YYYY-MM-DD");

export const createTripSchema = z
  .object({
    title: z.string().max(80).optional().default(""),
    destinationName: z.string().min(1).max(120),
    destinationPlaceId: z.string().min(1),
    lat: z.number().min(-90).max(90),
    lng: z.number().min(-180).max(180),
    startDate: dateString,
    endDate: dateString,
    budgetLevel: z.enum(["low", "mid", "high"]),
    exploreRadiusKm: z.union([z.literal(15), z.literal(60), z.literal(100)]).optional().default(15),
    vibeNote: z.string().max(500).optional().default(""),
  })
  .refine((t) => t.endDate >= t.startDate, { message: "endDate must be on or after startDate" });
export type CreateTrip = z.infer<typeof createTripSchema>;

export const joinTripSchema = z.object({
  displayName: z.string().min(1).max(50),
  interests: z.array(z.enum(INTERESTS)).min(1),
  pace: z.enum(["chill", "balanced", "packed"]),
  dietary: z.enum(["none", "vegetarian", "vegan", "halal", "other"]),
  constraintsNote: z.string().max(300).optional().default(""),
  /**
   * An automated traveller declaring itself, so it never counts toward a group
   * majority. Honesty-based and that is fine: the cost of lying is joining a
   * family trip you were invited to, and the organiser can flag anyone from the
   * roster anyway.
   */
  isBot: z.boolean().optional().default(false),
});
export type JoinTrip = z.infer<typeof joinTripSchema>;

export const voteSchema = z.object({
  slug: z.string().min(1),
  token: z.string().min(1),
  value: z.union([z.literal(1), z.literal(-1)]),
});

export const myTripsSchema = z.object({
  entries: z
    .array(z.object({ slug: z.string().min(1), token: z.string().min(1) }))
    .max(DEVICE_TRIP_LIMIT),
});

export type TripMeta = {
  destinationName: string;
  startDate: string;
  endDate: string;
  budgetLevel: "low" | "mid" | "high";
  vibeNote: string;
  dayCount: number;
};

export type TravelerPrefs = {
  displayName: string;
  interests: string[];
  pace: string;
  dietary: string;
  constraintsNote: string;
};

export const renameTripSchema = z.object({
  token: z.string().min(1),
  title: z.string().max(80),
});

export const createSuggestionSchema = z.object({
  token: z.string().min(1),
  text: z.string().trim().min(1).max(240).transform((text) => text.replace(/\s+/g, " ")),
});

export const deleteSuggestionSchema = z.object({
  token: z.string().min(1),
});

export type TripSuggestion = {
  displayName: string;
  text: string;
};

export const conciergeChatSchema = z
  .object({
    token: z.string().min(1),
    messages: z
      .array(
        z.object({
          role: z.enum(["user", "assistant"]),
          content: z.string().trim().min(1).max(2_000),
        }),
      )
      .min(1)
      .max(12),
  })
  .refine((chat) => chat.messages.at(-1)?.role === "user", {
    message: "The last chat message must be from the user",
  });

export type ConciergeMessage = z.infer<typeof conciergeChatSchema>["messages"][number];

export const updateItemStateSchema = z.union([
  z.object({
    token: z.string().min(1),
    slug: z.string().min(1),
    action: z.literal("status"),
    status: z.enum(["planned", "done", "skipped"]),
    completedDayIndex: z.number().int().min(0).optional(),
  }),
  z.object({
    token: z.string().min(1),
    slug: z.string().min(1),
    action: z.literal("lock"),
    isLocked: z.boolean(),
  }),
]);

const optionalReservationDateTime = z.string().datetime({ offset: true }).nullable();
const optionalBookingUrl = z.union([
  z.literal(""),
  z.string().url().max(1_000).refine((value) => /^https?:\/\//i.test(value), {
    message: "Booking link must use http or https",
  }),
]).nullable();

export const updateReservationSchema = z.object({
  token: z.string().min(1),
  slug: z.string().min(1),
  status: z.enum(["none", "tentative", "confirmed", "cancelled"]),
  reservationAt: optionalReservationDateTime,
  confirmationNumber: z.string().trim().max(120).nullable(),
  bookingUrl: optionalBookingUrl,
  cancellationDeadline: optionalReservationDateTime,
  detailsSource: z.enum(["organizer", "artifact"]).default("organizer"),
  organizerVerified: z.boolean().default(false),
}).superRefine((reservation, ctx) => {
  if (reservation.status === "confirmed" && !reservation.reservationAt) {
    ctx.addIssue({
      code: "custom",
      path: ["reservationAt"],
      message: "Confirmed reservations require a date and time",
    });
  }
  if (reservation.status === "confirmed" && !reservation.confirmationNumber && !reservation.organizerVerified) {
    ctx.addIssue({
      code: "custom",
      path: ["status"],
      message: "Confirmed reservations require a confirmation reference or organizer verification",
    });
  }
});

export type UpdateReservation = z.infer<typeof updateReservationSchema>;

export const beginReservationProofUploadSchema = z.object({
  slug: z.string().trim().min(1).max(100),
  fileName: z.string().min(1).max(500),
  mediaType: z.enum(RESERVATION_ARTIFACT_TYPES),
  byteSize: z.number().int().min(1).max(MAX_RESERVATION_ARTIFACT_BYTES),
}).strict();

export const finalizeReservationProofUploadSchema = z.object({
  slug: z.string().trim().min(1).max(100),
  uploadId: z.string().uuid(),
}).strict();

export const reservationProofActionSchema = z.object({
  slug: z.string().trim().min(1).max(100),
}).strict();

const assistanceUrl = z.string().url().max(1_000).refine((value) => value.startsWith("https://"), "Booking routes must use https");
export const createReservationAttemptSchema = z.object({
  token: z.string().min(1), slug: z.string().min(1),
  partySize: z.number().int().min(1).max(30),
  requestedAt: z.string().datetime({ offset: true }),
  bookingName: z.string().trim().min(1).max(120),
  contactEmail: z.string().trim().email().max(254).nullable(),
  contactPhone: z.string().trim().min(5).max(40).nullable(),
  alternatives: z.array(z.string().datetime({ offset: true })).max(3),
  routes: z.array(assistanceUrl).min(1).max(3),
}).refine((value) => value.contactEmail || value.contactPhone, { message: "Email or phone is required", path: ["contactEmail"] });

export const updateReservationAttemptSchema = z.object({
  token: z.string().min(1), slug: z.string().min(1),
  action: z.enum(["approve", "route_failed", "choose_alternative", "confirm", "fail"]),
  alternativeAt: z.string().datetime({ offset: true }).optional(),
  confirmationReference: z.string().trim().min(1).max(120).optional(),
  confirmationUrl: assistanceUrl.optional(),
}).superRefine((value, ctx) => {
  if (value.action === "confirm" && !value.confirmationReference) ctx.addIssue({ code: "custom", path: ["confirmationReference"], message: "Confirmation requires a reference" });
  if (value.action === "choose_alternative" && !value.alternativeAt) ctx.addIssue({ code: "custom", path: ["alternativeAt"], message: "Choose an offered time" });
});

export const reshuffleMoveSchema = z.object({
  itemId: z.string().uuid(),
  fromDayIndex: z.number().int().min(0),
  fromBlock: z.enum(BLOCKS),
  toDayIndex: z.number().int().min(0),
  toBlock: z.enum(BLOCKS),
});

/** A traveller asking the group to move, drop, or restaff one stop. */
export const createProposalSchema = z.union([
  z.object({
    token: z.string().min(1),
    slug: z.string().min(1),
    kind: z.literal("move"),
    toDayIndex: z.number().int().min(0),
    toBlock: z.enum(BLOCKS),
    note: z.string().trim().max(200).optional().default(""),
  }),
  z.object({
    token: z.string().min(1),
    slug: z.string().min(1),
    kind: z.literal("remove"),
    note: z.string().trim().max(200).optional().default(""),
  }),
  z.object({
    token: z.string().min(1),
    slug: z.string().min(1),
    kind: z.literal("replace"),
    /** The venue proposed to stand in this slot instead. */
    toCandidateId: z.string().uuid(),
    note: z.string().trim().max(200).optional().default(""),
  }),
]);
export type CreateProposal = z.infer<typeof createProposalSchema>;

export const voteProposalSchema = z.object({
  token: z.string().min(1),
  slug: z.string().min(1),
  value: z.union([z.literal(1), z.literal(-1)]),
});

export const decideProposalSchema = z.object({
  token: z.string().min(1),
  slug: z.string().min(1),
  decision: z.enum(["approve", "reject"]),
});

/** One hand-picked move: the traveller drags a single stop to a free slot. */
export const moveItemSchema = z.object({
  token: z.string().min(1),
  slug: z.string().min(1),
  fromDayIndex: z.number().int().min(0),
  fromBlock: z.enum(BLOCKS),
  toDayIndex: z.number().int().min(0),
  toBlock: z.enum(BLOCKS),
});
export type MoveItem = z.infer<typeof moveItemSchema>;

export const partialDaySkipSchema = z.object({
  itemId: z.string().uuid(),
  fromDayIndex: z.number().int().min(0),
  fromBlock: z.enum(BLOCKS),
});

const applyPartialDaySchema = z.object({
  token: z.string().min(1),
  action: z.literal("apply-partial-day"),
  dayIndex: z.number().int().min(0),
  currentBlock: z.enum(BLOCKS),
  trigger: z.literal("running-late"),
  moves: z.array(reshuffleMoveSchema).max(BLOCKS.length),
  skips: z.array(partialDaySkipSchema).max(BLOCKS.length),
}).refine((request) => request.moves.length + request.skips.length > 0, {
  message: "At least one partial-day change is required",
});

export const adjustTodayPreviewRequestSchema = z.object({
  token: z.string().min(1),
  action: z.literal("preview"),
  dayIndex: z.number().int().min(0),
  reason: z.string().trim().min(1).max(240),
});

export const adjustTodayApplyRequestSchema = z.object({
  token: z.string().min(1),
  action: z.literal("apply"),
  previewId: z.string().uuid(),
  fingerprint: z.string().min(1).max(100),
  reason: z.string().trim().min(1).max(240),
  moves: z.array(reshuffleMoveSchema).max(BLOCKS.length),
  skips: z.array(partialDaySkipSchema).max(BLOCKS.length),
  swaps: z.array(z.object({
    itemId: z.string().uuid(),
    toCandidateId: z.string().uuid(),
    fromDayIndex: z.number().int().min(0),
    fromBlock: z.enum(BLOCKS),
  })).max(BLOCKS.length),
}).refine((request) => request.moves.length + request.skips.length + request.swaps.length > 0, {
  message: "At least one adjustment is required",
});

export const adjustTodayAbandonRequestSchema = z.object({
  token: z.string().min(1),
  action: z.literal("abandon"),
  previewId: z.string().uuid(),
});

export const adjustTodayRequestSchema = z.discriminatedUnion("action", [
  adjustTodayPreviewRequestSchema,
  adjustTodayApplyRequestSchema,
  adjustTodayAbandonRequestSchema,
]);

export type AdjustTodayRequest = z.infer<typeof adjustTodayRequestSchema>;

export const reshuffleRequestSchema = z.union([
  z.object({
    token: z.string().min(1),
    action: z.literal("preview"),
    currentDayIndex: z.number().int().min(0),
  }),
  z.object({
    token: z.string().min(1),
    action: z.literal("apply"),
    moves: z.array(reshuffleMoveSchema).min(1).max(100),
  }),
  z.object({
    token: z.string().min(1),
    action: z.literal("preview-partial-day"),
    currentDayIndex: z.number().int().min(0),
    currentBlock: z.enum(BLOCKS),
  }),
  applyPartialDaySchema,
]);

export const createTripAgentConnectionSchema = z.object({
  provider: tripAgentProviderSchema,
}).strict();

const tripAgentLifecycleActionSchema = (action: "pause" | "resume" | "rotate" | "archive") =>
  z.object({ action: z.literal(action) }).strict();

export const updateTripAgentConnectionSchema = z.discriminatedUnion("action", [
  tripAgentLifecycleActionSchema("pause"),
  tripAgentLifecycleActionSchema("resume"),
  tripAgentLifecycleActionSchema("rotate"),
  tripAgentLifecycleActionSchema("archive"),
  z.object({
    action: z.literal("update_policy"),
    travelerCanAddSuggestion: z.boolean(),
    travelerCanProposeChange: z.boolean(),
    grantedScopes: z.array(tripAgentScopeSchema).max(TRIP_AGENT_SCOPES.length),
  }).strict(),
  z.object({
    action: z.literal("update_metadata"),
    agentPhoneE164: z.string().regex(/^\+[0-9]{7,15}$/),
    whatsappGroupLabel: z.string().trim().min(1).max(100),
  }).strict(),
]);

export type CreateTripAgentConnection = z.infer<typeof createTripAgentConnectionSchema>;
export type UpdateTripAgentConnection = z.infer<typeof updateTripAgentConnectionSchema>;
